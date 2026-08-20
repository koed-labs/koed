#!/usr/bin/env python3
"""Locked, thin Harbor adapter and Terminal-Bench 3 corpus manifest tooling."""

from __future__ import annotations

import argparse
import asyncio
from builtins import BaseExceptionGroup
import contextlib
import copy
import hashlib
import importlib.metadata
import ipaddress
import json
import math
import os
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse

import tomllib
from dirhash import dirhash
from harbor.agents.installed.codex import Codex
from harbor.environments.factory import EnvironmentFactory
from harbor.job import Job
from harbor.models.job.config import DatasetConfig, JobConfig
from harbor.models.task.config import VerifierEnvironmentMode
from harbor.models.task.verifier_mode import resolve_effective_verifier_env_config
from harbor.models.trial.config import TaskConfig
from harbor.publisher.packager import Packager
from harbor.tasks.client import TaskClient
from harbor.trial.hooks import TrialHookEvent
from harbor.trial.trial import Trial

HARBOR_VERSION = "0.21.0"
HARBOR_COMMIT = "64afbbcb62165950301e1a6407c729aa26d844ff"
TB_VERSION = "v3.0.0"
TB_COMMIT = "2b0442c3c583b710ca8da14c8e601b99f2f1f244"
TB_REPO = f"harbor-framework/terminal-bench@{TB_COMMIT}"
TB_GIT_URL = "https://github.com/harbor-framework/terminal-bench.git"
CORPUS_TASK_COUNT = 74
MANIFEST_SCHEMA = "koed-terminal-bench-corpus-v2"
RUN_REQUEST_SCHEMA = "koed-harbor-run-v1"
TASK_IMAGE_SCHEMA = "koed-harbor-task-image-v1"
FREEZE_MANIFEST_SCHEMA = "koed-harbor-freeze-v1"
TASK_INSTRUCTION_POLICY = "koed-memory-eval-task-instruction-v2"
TASK_ANTI_CHEAT_SENTENCE = (
    "Do not cheat by using online solutions or hints specific to this task."
)
TASK_NETWORK_SENTENCE = "Do not cheat by using online solutions."
AGENT_GUIDANCE_PATH = Path(__file__).with_name("koed-agent-guidance.md")
MAX_TRAJECTORY_BYTES = 256 * 1024 * 1024
MAX_LIFECYCLE_LINE_BYTES = 16 * 1024
LIFECYCLE_SOCKET_ENV = "KOED_HARBOR_LIFECYCLE_SOCKET"
LIFECYCLE_TOKEN_ENV = "KOED_HARBOR_LIFECYCLE_TOKEN"
LIFECYCLE_TIMEOUT_ENV = "KOED_HARBOR_LIFECYCLE_TIMEOUT_MS"
REWARD_CONTRACTS_PATH = Path(__file__).with_name("reward-contracts.json")
SAFE_JOB_CONFIG_FIELDS = frozenset(
    {
        "job_name",
        "timeout_multiplier",
        "agent_timeout_multiplier",
        "verifier_timeout_multiplier",
        "agent_setup_timeout_multiplier",
        "environment_build_timeout_multiplier",
        "debug",
        "quiet",
        "retry",
        "environment",
        "verifier",
        "agents",
    }
)
SAFE_AGENT_CONFIG_FIELDS = frozenset(
    {
        "name",
        "model_name",
        "n_concurrent",
        "concurrency_group",
        "override_timeout_sec",
        "override_setup_timeout_sec",
        "max_timeout_sec",
        "extra_allowed_hosts",
        "env",
        "kwargs",
    }
)
SAFE_ENVIRONMENT_CONFIG_FIELDS = frozenset(
    {
        "type",
        "force_build",
        "delete",
        "cpu_enforcement_policy",
        "memory_enforcement_policy",
        "override_cpus",
        "override_memory_mb",
        "override_storage_mb",
        "override_gpus",
        "override_tpu",
        "extra_allowed_hosts",
        "env",
    }
)
SAFE_VERIFIER_CONFIG_FIELDS = frozenset(
    {"override_timeout_sec", "max_timeout_sec", "env", "disable"}
)
SAFE_RETRY_CONFIG_FIELDS = frozenset(
    {
        "max_retries",
        "include_exceptions",
        "exclude_exceptions",
        "wait_multiplier",
        "min_wait_sec",
        "max_wait_sec",
    }
)
CODEX_AGENT_NAME = "codex"
CODEX_AGENT_ENV_FIELDS = frozenset({"OPENAI_API_KEY", "KOED_BENCHMARK_MCP_TOKEN"})
CODEX_EXTRA_ALLOWED_HOSTS = frozenset(
    {
        "api.openai.com",
        "auth.openai.com",
        "chatgpt.com",
        "host.docker.internal",
    }
)
SAFE_CODEX_CONFIG_FIELDS = frozenset(
    {
        "model",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "approval_policy",
        "suppress_unstable_features_warning",
        "developer_instructions",
        "include_permissions_instructions",
        "include_apps_instructions",
        "include_collaboration_mode_instructions",
        "include_environment_context",
        "project_doc_max_bytes",
        "web_search",
        "features",
        "agents",
        "skills",
        "mcp_servers",
    }
)

QUICK_TASKS = (
    "terminal-bench/cad-model",
    "terminal-bench/batched-eval-parity",
    "terminal-bench/embedding-drift-monitor",
    "terminal-bench/music-harmony",
    "terminal-bench/cargo-flight-dispatch",
    "terminal-bench/fin-saccr-rwa",
    "terminal-bench/foodstuff-beta-activity",
    "terminal-bench/coq-block-bound",
    "terminal-bench/ico-path-patch",
    "terminal-bench/bun-sourcemap-leak",
    "terminal-bench/cumulative-layout-shift",
    "terminal-bench/ontology-kg-querying",
)
STANDARD_EXTRA_TASKS = (
    "terminal-bench/retro-console-soc",
    "terminal-bench/pretrain-shard-corruption",
    "terminal-bench/gpt2-codegolf",
    "terminal-bench/satb-audio-transcription",
    "terminal-bench/medical-claims-processing",
    "terminal-bench/production-planning",
    "terminal-bench/atrx-vep-crispr",
    "terminal-bench/ks-solver-cpp",
    "terminal-bench/html-js-filter",
    "terminal-bench/data-anonymization",
    "terminal-bench/live-database-cutover",
    "terminal-bench/session-window-debug",
)


class ContractError(RuntimeError):
    """An immutable benchmark input or lifecycle contract was violated."""


def _nested_contract_code(error: BaseException) -> str | None:
    pending: list[BaseException] = [error]
    visited: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in visited:
            continue
        visited.add(id(current))
        if isinstance(current, ContractError):
            code = str(current)
            if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", code):
                return code
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return None


def _guard_empty_harbor_progress_metrics(job: Job) -> None:
    """Avoid Harbor 0.21 indexing an absent metric in its progress callback."""
    original = job._update_metric_display

    def guarded(event: TrialHookEvent, loading_progress: Any, progress_task: Any) -> None:
        dataset = event.config.task.source or "adhoc"
        if not job._metrics.get(dataset):
            return
        original(event, loading_progress, progress_task)

    job._update_metric_display = guarded


def _notify_lifecycle(event: TrialHookEvent, name: str, attempt_kind: str) -> None:
    socket_path = os.environ.get(LIFECYCLE_SOCKET_ENV)
    token = os.environ.get(LIFECYCLE_TOKEN_ENV)
    timeout_text = os.environ.get(LIFECYCLE_TIMEOUT_ENV)
    if not socket_path or not token or not timeout_text:
        raise ContractError("LIFECYCLE_CHANNEL_MISSING")
    try:
        timeout = int(timeout_text) / 1000
    except ValueError as error:
        raise ContractError("INVALID_LIFECYCLE_TIMEOUT") from error
    payload = (
        json.dumps(
            {
                "schema_version": "koed-harbor-lifecycle-v1",
                "token": token,
                "attempt_kind": attempt_kind,
                "event": name,
                "trial_id": str(event.trial_id),
                "task_name": event.task_name,
                "timestamp": event.timestamp.isoformat(),
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )
    if len(payload) > MAX_LIFECYCLE_LINE_BYTES:
        raise ContractError("LIFECYCLE_EVENT_TOO_LARGE")
    received = bytearray()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(socket_path)
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            while b"\n" not in received:
                chunk = client.recv(1024)
                if not chunk:
                    break
                received.extend(chunk)
                if len(received) > 1024:
                    raise ContractError("INVALID_LIFECYCLE_ACK")
    except (OSError, TimeoutError) as error:
        raise ContractError("LIFECYCLE_ACK_FAILED") from error
    try:
        ack = json.loads(bytes(received))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ContractError("INVALID_LIFECYCLE_ACK") from error
    if ack != {
        "schema_version": "koed-harbor-lifecycle-ack-v1",
        "accepted": True,
    }:
        raise ContractError("LIFECYCLE_EVENT_REJECTED")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _adapt_task_instruction(instruction: str) -> str:
    occurrences = instruction.count(TASK_ANTI_CHEAT_SENTENCE)
    if occurrences != 1:
        raise ContractError(
            "TASK_INSTRUCTION_POLICY_MISMATCH: expected exactly one anti-cheat sentence"
        )
    return instruction.replace(TASK_ANTI_CHEAT_SENTENCE, TASK_NETWORK_SENTENCE)


def _prepare_adapted_task(
    source: Path, run_root: Path, task_selector: str
) -> tuple[Path, dict[str, str]]:
    instruction_path = source / "instruction.md"
    try:
        original = instruction_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ContractError("TASK_INSTRUCTION_UNREADABLE") from error
    adapted = _adapt_task_instruction(original)
    if (source / "AGENTS.md").exists():
        raise ContractError("TASK_AGENT_GUIDANCE_COLLISION")
    try:
        agent_guidance = AGENT_GUIDANCE_PATH.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ContractError("AGENT_GUIDANCE_UNREADABLE") from error
    original_sha256 = f"sha256:{hashlib.sha256(original.encode()).hexdigest()}"
    adapted_sha256 = f"sha256:{hashlib.sha256(adapted.encode()).hexdigest()}"
    agent_guidance_sha256 = (
        f"sha256:{hashlib.sha256(agent_guidance.encode()).hexdigest()}"
    )
    adaptation_sha256 = hashlib.sha256(
        f"{adapted_sha256}\n{agent_guidance_sha256}".encode()
    ).hexdigest()
    destination = (
        run_root
        / "harbor-adapted-tasks"
        / f"{task_selector}-{adaptation_sha256[:16]}"
    )
    if destination.exists():
        existing_instruction = destination / "instruction.md"
        existing_agent_guidance = destination / "AGENTS.md"
        if (
            not existing_instruction.is_file()
            or _sha256_file(existing_instruction) != adapted_sha256
            or not existing_agent_guidance.is_file()
            or _sha256_file(existing_agent_guidance) != agent_guidance_sha256
        ):
            raise ContractError("ADAPTED_TASK_COLLISION")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{task_selector}-", dir=destination.parent)
        )
        try:
            shutil.copytree(source, temporary, dirs_exist_ok=True)
            (temporary / "instruction.md").write_text(adapted, encoding="utf-8")
            (temporary / "AGENTS.md").write_text(agent_guidance, encoding="utf-8")
            temporary.rename(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return destination, {
        "policy": TASK_INSTRUCTION_POLICY,
        "original_sha256": original_sha256,
        "adapted_sha256": adapted_sha256,
        "agent_guidance_sha256": agent_guidance_sha256,
    }


def _run_docker(
    docker: str, arguments: list[str], *, timeout: int = 120
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            [docker, *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ContractError("DOCKER_COMMAND_FAILED") from error
    if result.returncode != 0:
        raise ContractError("DOCKER_COMMAND_FAILED")
    return result


def _docker_inspect(docker: str, reference: str) -> dict[str, Any]:
    output = _run_docker(
        docker, ["image", "inspect", reference, "--format", "{{json .}}"]
    ).stdout.strip()
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError as error:
        raise ContractError("INVALID_DOCKER_INSPECTION") from error
    if not isinstance(parsed, dict):
        raise ContractError("INVALID_DOCKER_INSPECTION")
    image_id = parsed.get("Id")
    repo_digests = parsed.get("RepoDigests")
    if (
        not isinstance(image_id, str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id)
        or not isinstance(repo_digests, list)
        or any(not isinstance(value, str) for value in repo_digests)
    ):
        raise ContractError("INVALID_DOCKER_INSPECTION")
    return parsed


def _registry_repository(registry: str, task_name: str) -> str:
    if (
        not isinstance(registry, str)
        or len(registry) > 240
        or registry != registry.strip().rstrip("/")
        or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?"
            r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*",
            registry,
        )
    ):
        raise ContractError("INVALID_OCI_REGISTRY")
    if not re.fullmatch(r"terminal-bench/[a-z0-9][a-z0-9-]*", task_name):
        raise ContractError("INVALID_TASK_NAME")
    return f"{registry}/tb3-{task_name.removeprefix('terminal-bench/')}"


def _dockerfile_logical_lines(text: str) -> list[str]:
    lines: list[str] = []
    pending = ""
    for physical in text.splitlines():
        stripped = physical.strip()
        if not stripped or (not pending and stripped.startswith("#")):
            continue
        pending = f"{pending}{stripped}"
        if pending.endswith("\\"):
            pending = f"{pending[:-1]} "
            continue
        lines.append(pending)
        pending = ""
    if pending:
        raise ContractError("INVALID_DOCKERFILE")
    return lines


def _resolve_from_value(value: str, arguments: dict[str, str]) -> str:
    variable = re.compile(
        r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))"
    )
    resolved = value
    for _ in range(16):
        match = variable.search(resolved)
        if match is None:
            return resolved
        name = match.group(1) or match.group(2)
        if name not in arguments:
            raise ContractError("UNRESOLVED_DOCKERFILE_FROM_ARGUMENT")
        resolved = (
            f"{resolved[: match.start()]}{arguments[name]}{resolved[match.end() :]}"
        )
    raise ContractError("CYCLIC_DOCKERFILE_FROM_ARGUMENT")


def _dockerfile_base_references(dockerfile: Path) -> tuple[str, list[str]]:
    try:
        metadata = dockerfile.lstat()
        text = dockerfile.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError("MISSING_DOCKERFILE") from error
    if not stat.S_ISREG(metadata.st_mode) or dockerfile.is_symlink():
        raise ContractError("UNSAFE_DOCKERFILE")
    arguments: dict[str, str] = {}
    stages: set[str] = set()
    bases: list[str] = []
    seen_from = False
    for line in _dockerfile_logical_lines(text):
        instruction, _, remainder = line.partition(" ")
        instruction = instruction.upper()
        remainder = remainder.strip()
        if instruction == "ARG":
            if seen_from:
                continue
            name, separator, value = remainder.partition("=")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ContractError("UNRESOLVED_DOCKERFILE_FROM_ARGUMENT")
            if separator:
                arguments[name] = _resolve_from_value(value, arguments)
            continue
        if instruction != "FROM":
            continue
        seen_from = True
        tokens = remainder.split()
        while tokens and tokens[0].startswith("--"):
            tokens.pop(0)
        if len(tokens) not in (1, 3) or (
            len(tokens) == 3 and tokens[1].upper() != "AS"
        ):
            raise ContractError("INVALID_DOCKERFILE_FROM")
        reference = _resolve_from_value(tokens[0], arguments)
        if not reference or any(character.isspace() for character in reference):
            raise ContractError("INVALID_DOCKERFILE_FROM")
        if reference.lower() != "scratch" and reference.lower() not in stages:
            bases.append(reference)
        if len(tokens) == 3:
            alias = tokens[2].lower()
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", alias):
                raise ContractError("INVALID_DOCKERFILE_FROM")
            stages.add(alias)
    if not any(
        line.split(maxsplit=1)[0].upper() == "FROM"
        for line in _dockerfile_logical_lines(text)
    ):
        raise ContractError("DOCKERFILE_HAS_NO_FROM")
    return _sha256_file(dockerfile), bases


def _resolved_base_digests(docker: str, references: list[str]) -> list[str]:
    resolved: list[str] = []
    for reference in references:
        _run_docker(docker, ["pull", reference], timeout=600)
        inspected = _docker_inspect(docker, reference)
        digests = {
            value.rsplit("@", 1)[1]
            for value in inspected["RepoDigests"]
            if "@" in value
            and re.fullmatch(r"sha256:[a-f0-9]{64}", value.rsplit("@", 1)[1])
        }
        if len(digests) != 1:
            raise ContractError("BASE_IMAGE_IMMUTABLE_IDENTITY_UNAVAILABLE")
        digest = next(iter(digests))
        if "@sha256:" in reference and reference.rsplit("@", 1)[1] != digest:
            raise ContractError("BASE_IMAGE_DIGEST_MISMATCH")
        if digest not in resolved:
            resolved.append(digest)
    return resolved


def _runtime_versions(docker: str) -> tuple[str, str]:
    version = _run_docker(docker, ["version", "--format", "{{json .}}"])
    try:
        parsed = json.loads(version.stdout)
        client = parsed["Client"]["Version"]
        server = parsed["Server"]["Version"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise ContractError("INVALID_DOCKER_VERSION") from error
    if not all(
        isinstance(value, str) and value and "\n" not in value
        for value in (client, server)
    ):
        raise ContractError("INVALID_DOCKER_VERSION")
    buildkit_output = _run_docker(
        docker,
        ["buildx", "inspect", "--bootstrap"],
    ).stdout
    buildkit_versions = set(
        re.findall(r"^BuildKit version:\s*(\S+)\s*$", buildkit_output, re.MULTILINE)
    )
    if len(buildkit_versions) != 1:
        raise ContractError("INVALID_BUILDKIT_VERSION")
    buildkit = next(iter(buildkit_versions))
    if "\n" in buildkit or "\r" in buildkit:
        raise ContractError("INVALID_BUILDKIT_VERSION")
    return f"Docker client {client} server {server}", f"BuildKit {buildkit}"


def _available_provenance_sha256(docker: str, immutable_reference: str) -> str | None:
    try:
        result = _run_docker(
            docker,
            [
                "buildx",
                "imagetools",
                "inspect",
                immutable_reference,
                "--format",
                "{{json .Provenance}}",
            ],
        )
        value = json.loads(result.stdout)
    except (ContractError, json.JSONDecodeError):
        return None
    if value in (None, {}, []):
        return None
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _atomic_json(path: Path, value: Any, *, no_overwrite: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if no_overwrite and path.exists():
        raise ContractError("OUTPUT_ALREADY_EXISTS")
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        if no_overwrite:
            try:
                os.link(temporary_path, path)
            except FileExistsError as error:
                raise ContractError("OUTPUT_ALREADY_EXISTS") from error
            temporary_path.unlink()
        else:
            os.replace(temporary_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary_path.unlink(missing_ok=True)


def _git_output(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _verify_source_checkout(source: Path) -> None:
    actual = _git_output(source, "rev-parse", "HEAD")
    if actual != TB_COMMIT:
        raise ContractError(
            f"Terminal-Bench checkout is {actual}; expected pinned {TB_COMMIT}"
        )
    if _git_output(source, "status", "--porcelain"):
        raise ContractError("Terminal-Bench source checkout must be clean")


def _expert_time_seconds(metadata: dict[str, Any]) -> int:
    if "expert_time_estimate_sec" in metadata:
        return int(metadata["expert_time_estimate_sec"])
    if "expert_time_estimate_min" in metadata:
        return int(round(float(metadata["expert_time_estimate_min"]) * 60))
    if "expert_time_estimate_hours" in metadata:
        return int(round(float(metadata["expert_time_estimate_hours"]) * 3600))
    raise ContractError("task metadata has no expert-time estimate")


def _task_timeout_seconds(section: Any, label: str, task_name: str) -> int:
    if not isinstance(section, dict):
        raise ContractError(f"{label} timeout is missing for {task_name}")
    value = section.get("timeout_sec")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{label} timeout is missing for {task_name}")
    if not math.isfinite(value) or value <= 0 or int(value) != value:
        raise ContractError(f"{label} timeout is invalid for {task_name}")
    return int(value)


def _finite_number(value: Any, reason: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
    ):
        raise ContractError(reason)
    return float(value)


def _validate_reward_contract(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "metrics",
        "primary_field",
        "success",
    }:
        raise ContractError("INVALID_REWARD_CONTRACT")
    metrics = value["metrics"]
    if not isinstance(metrics, dict) or not metrics:
        raise ContractError("INVALID_REWARD_CONTRACT")
    normalized_metrics: dict[str, dict[str, float]] = {}
    for metric_field, bounds in metrics.items():
        if (
            not isinstance(metric_field, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,127}", metric_field)
            or not isinstance(bounds, dict)
            or set(bounds) != {"minimum", "maximum"}
        ):
            raise ContractError("INVALID_REWARD_CONTRACT")
        minimum = _finite_number(bounds["minimum"], "INVALID_REWARD_CONTRACT")
        maximum = _finite_number(bounds["maximum"], "INVALID_REWARD_CONTRACT")
        if minimum > maximum:
            raise ContractError("INVALID_REWARD_CONTRACT")
        normalized_metrics[metric_field] = {
            "minimum": minimum,
            "maximum": maximum,
        }
    primary = value["primary_field"]
    if not isinstance(primary, str) or primary not in normalized_metrics:
        raise ContractError("INVALID_REWARD_CONTRACT")
    success = value["success"]
    if (
        not isinstance(success, dict)
        or set(success) != {"operator", "value"}
        or success["operator"]
        not in {
            "equals",
            "greater_than",
            "greater_than_or_equal",
            "less_than",
            "less_than_or_equal",
        }
    ):
        raise ContractError("INVALID_REWARD_CONTRACT")
    threshold = _finite_number(success["value"], "INVALID_REWARD_CONTRACT")
    primary_bounds = normalized_metrics[primary]
    if not primary_bounds["minimum"] <= threshold <= primary_bounds["maximum"]:
        raise ContractError("INVALID_REWARD_CONTRACT")
    return {
        "metrics": normalized_metrics,
        "primary_field": primary,
        "success": {"operator": success["operator"], "value": threshold},
    }


def _load_reward_contracts(
    path: Path = REWARD_CONTRACTS_PATH,
) -> dict[str, dict[str, Any]]:
    mapping = json.loads(path.read_text(), object_pairs_hook=_reject_duplicate_pairs)
    if not isinstance(mapping, dict) or set(mapping) != {
        "schema_version",
        "terminal_bench_commit",
        "extraction",
        "contract_groups",
    }:
        raise ContractError("INVALID_REWARD_CONTRACT_MAPPING")
    if (
        mapping["schema_version"] != "koed-terminal-bench-reward-contracts-v1"
        or mapping["terminal_bench_commit"] != TB_COMMIT
        or not isinstance(mapping["extraction"], str)
        or not isinstance(mapping["contract_groups"], list)
    ):
        raise ContractError("INVALID_REWARD_CONTRACT_MAPPING")
    contracts: dict[str, dict[str, Any]] = {}
    for group in mapping["contract_groups"]:
        if not isinstance(group, dict) or set(group) != {"id", "contract", "tasks"}:
            raise ContractError("INVALID_REWARD_CONTRACT_MAPPING")
        contract = _validate_reward_contract(group["contract"])
        if not isinstance(group["id"], str) or not isinstance(group["tasks"], list):
            raise ContractError("INVALID_REWARD_CONTRACT_MAPPING")
        for name in group["tasks"]:
            if not isinstance(name, str) or name in contracts:
                raise ContractError("INVALID_REWARD_CONTRACT_MAPPING")
            contracts[name] = copy.deepcopy(contract)
    if len(contracts) != CORPUS_TASK_COUNT:
        raise ContractError("INCOMPLETE_REWARD_CONTRACT_MAPPING")
    return contracts


def _reward_contract(name: str) -> dict[str, Any]:
    contract = _load_reward_contracts().get(name)
    if contract is None:
        raise ContractError("MISSING_TASK_REWARD_CONTRACT")
    return contract


def _validate_reward_values(rewards: Any, contract: dict[str, Any]) -> dict[str, Any]:
    normalized_contract = _validate_reward_contract(contract)
    if not isinstance(rewards, dict):
        raise ContractError("MISSING_REWARD_VALUES")
    expected = set(normalized_contract["metrics"])
    if set(rewards) != expected:
        raise ContractError("REWARD_FIELDS_MISMATCH")
    values: dict[str, float] = {}
    for metric_field, bounds in normalized_contract["metrics"].items():
        value = _finite_number(rewards[metric_field], "INVALID_REWARD_VALUE")
        if not bounds["minimum"] <= value <= bounds["maximum"]:
            raise ContractError("REWARD_OUT_OF_RANGE")
        values[metric_field] = value
    primary_field = normalized_contract["primary_field"]
    primary = values[primary_field]
    success = normalized_contract["success"]
    threshold = success["value"]
    passed = {
        "equals": primary == threshold,
        "greater_than": primary > threshold,
        "greater_than_or_equal": primary >= threshold,
        "less_than": primary < threshold,
        "less_than_or_equal": primary <= threshold,
    }[success["operator"]]
    return {
        "values": values,
        "primary_field": primary_field,
        "primary_value": primary,
        "passed": passed,
    }


def _trial_failure_category(exception_type: str | None) -> str | None:
    if exception_type is None:
        return None
    if exception_type == "AgentTimeoutError":
        return "agent_timeout"
    if exception_type in {"ApiUsageLimitError", "NonZeroAgentExitCodeError"}:
        return "agent_failed"
    if exception_type == "VerifierTimeoutError":
        return "verifier_timeout"
    if exception_type.startswith("Agent"):
        return "agent_failed"
    if exception_type.startswith("Verifier") or exception_type.startswith("Reward"):
        return "verifier_failed"
    return "other"


def _trial_outcome(
    validated_reward: dict[str, Any] | None,
    exception_type: str | None,
    reward_field: str,
) -> dict[str, Any]:
    if validated_reward is None and exception_type is None:
        raise ContractError("MISSING_REWARD_VALUES")
    errored = exception_type is not None or validated_reward is None
    return {
        "primary_reward": {
            "field": reward_field,
            "value": (
                validated_reward["primary_value"]
                if validated_reward is not None and not errored
                else None
            ),
            "passed": (
                validated_reward["passed"]
                if validated_reward is not None and not errored
                else False
            ),
        },
        "errored": errored,
        "failure_category": (
            _trial_failure_category(exception_type) if errored else None
        ),
    }


def _task_record(task_dir: Path) -> dict[str, Any]:
    config = tomllib.loads((task_dir / "task.toml").read_text())
    task = config.get("task", {})
    metadata = config.get("metadata", {})
    environment = config.get("environment", {})
    agent = config.get("agent", {})
    verifier = config.get("verifier", {})
    name = task.get("name")
    if not isinstance(name, str) or not name.startswith("terminal-bench/"):
        raise ContractError(f"invalid task name in {task_dir / 'task.toml'}")

    task_digest, _ = Packager.compute_content_hash(task_dir)
    reward_contract = _reward_contract(name)
    primary_field = reward_contract["primary_field"]
    primary_bounds = reward_contract["metrics"][primary_field]

    return {
        "name": name,
        "source_path": f"tasks/{task_dir.name}",
        "harbor_task_checksum": f"sha256:{dirhash(task_dir, 'sha256')}",
        "task_digest": f"sha256:{task_digest}",
        "primary_reward": {
            "field": primary_field,
            **primary_bounds,
            "success": reward_contract["success"],
        },
        "reward_contract": reward_contract,
        "category": str(metadata.get("category", "uncategorized")),
        "expert_time_seconds": _expert_time_seconds(metadata),
        "agent_timeout_seconds": _task_timeout_seconds(agent, "agent", name),
        "verifier_timeout_seconds": _task_timeout_seconds(
            verifier, "verifier", name
        ),
        "resource_class": "gpu" if int(environment.get("gpus", 0)) > 0 else "cpu",
    }


def build_manifest(source: Path) -> dict[str, Any]:
    source = source.resolve()
    _verify_source_checkout(source)
    tasks_dir = source / "tasks"
    records = sorted(
        (
            _task_record(path)
            for path in tasks_dir.iterdir()
            if (path / "task.toml").is_file()
        ),
        key=lambda record: record["name"],
    )
    if len(records) != CORPUS_TASK_COUNT:
        raise ContractError(
            f"resolved {len(records)} tasks; expected {CORPUS_TASK_COUNT}"
        )
    names = [record["name"] for record in records]
    if len(names) != len(set(names)):
        raise ContractError("Terminal-Bench corpus contains duplicate task names")

    ranked = sorted(
        records, key=lambda record: (record["expert_time_seconds"], record["name"])
    )
    for index, record in enumerate(ranked):
        record["expert_time_quartile"] = min(4, (index * 4 // len(ranked)) + 1)

    return {
        "schema_version": MANIFEST_SCHEMA,
        "harbor": {"version": HARBOR_VERSION, "commit": HARBOR_COMMIT},
        "reward_contracts": {
            "schema_version": "koed-terminal-bench-reward-contracts-v1",
            "sha256": _sha256_file(REWARD_CONTRACTS_PATH),
        },
        "terminal_bench": {
            "version": TB_VERSION,
            "commit": TB_COMMIT,
            "repository": TB_GIT_URL,
            "dataset": {"kind": "implicit_git", "repo": TB_REPO, "path": "tasks"},
        },
        "task_count": len(records),
        "tasks": records,
    }


def _subset_manifest(
    corpus: dict[str, Any], names: tuple[str, ...], profile: str
) -> dict[str, Any]:
    by_name = {task["name"]: task for task in corpus["tasks"]}
    missing = sorted(set(names) - by_name.keys())
    if missing:
        raise ContractError(f"{profile} tasks missing from corpus: {missing}")
    fields = (
        "name",
        "source_path",
        "harbor_task_checksum",
        "task_digest",
        "category",
        "expert_time_seconds",
        "agent_timeout_seconds",
        "verifier_timeout_seconds",
        "expert_time_quartile",
        "resource_class",
        "primary_reward",
        "reward_contract",
    )
    return {
        "schema_version": "koed-terminal-bench-subset-v2",
        "profile": profile,
        "corpus_schema_version": corpus["schema_version"],
        "terminal_bench_commit": TB_COMMIT,
        "selection": {
            "version": 1,
            "seed": "koed-experience-replay-tb3-subsets-v1",
            "uses_replay_results": False,
        },
        "task_count": len(names),
        "tasks": [{field: by_name[name][field] for field in fields} for name in names],
    }


def write_manifests(source: Path, output_dir: Path) -> None:
    corpus = build_manifest(source)
    _atomic_json(output_dir / "tb3-v3.0.0.json", corpus)
    _atomic_json(
        output_dir / "quick-12.json", _subset_manifest(corpus, QUICK_TASKS, "quick")
    )
    standard = QUICK_TASKS + STANDARD_EXTRA_TASKS
    _atomic_json(
        output_dir / "standard-24.json", _subset_manifest(corpus, standard, "standard")
    )


def load_and_verify_manifest(path: Path) -> dict[str, Any]:
    manifest = json.loads(path.read_text(), object_pairs_hook=_reject_duplicate_pairs)
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise ContractError("unsupported corpus manifest schema")
    if manifest.get("task_count") != CORPUS_TASK_COUNT:
        raise ContractError("corpus manifest does not contain exactly 74 tasks")
    harbor = manifest.get("harbor", {})
    terminal_bench = manifest.get("terminal_bench", {})
    if harbor != {"version": HARBOR_VERSION, "commit": HARBOR_COMMIT}:
        raise ContractError("corpus manifest Harbor pin differs from the runner")
    if terminal_bench.get("commit") != TB_COMMIT:
        raise ContractError(
            "corpus manifest Terminal-Bench pin differs from the runner"
        )
    dataset = terminal_bench.get("dataset", {})
    if dataset != {"kind": "implicit_git", "repo": TB_REPO, "path": "tasks"}:
        raise ContractError(
            "corpus manifest does not use the pinned implicit Git dataset"
        )
    tasks = manifest.get("tasks", [])
    names = [task.get("name") for task in tasks]
    if len(names) != CORPUS_TASK_COUNT or len(set(names)) != CORPUS_TASK_COUNT:
        raise ContractError("corpus manifest task names are incomplete or duplicated")
    reward_mapping = manifest.get("reward_contracts")
    expected_mapping = {
        "schema_version": "koed-terminal-bench-reward-contracts-v1",
        "sha256": _sha256_file(REWARD_CONTRACTS_PATH),
    }
    if reward_mapping is not None and reward_mapping != expected_mapping:
        raise ContractError("REWARD_CONTRACT_MAPPING_MISMATCH")
    manifest["reward_contracts"] = expected_mapping
    contracts = _load_reward_contracts()
    for task in tasks:
        name = task["name"]
        for timeout_field in (
            "agent_timeout_seconds",
            "verifier_timeout_seconds",
        ):
            value = task.get(timeout_field)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value <= 0
            ):
                raise ContractError("INVALID_TASK_TIMEOUT_CONTRACT")
        contract = contracts.get(name)
        if contract is None:
            raise ContractError("MISSING_TASK_REWARD_CONTRACT")
        primary = contract["primary_field"]
        expected_primary = {
            "field": primary,
            **contract["metrics"][primary],
            "success": contract["success"],
        }
        if task.get("primary_reward") != expected_primary:
            raise ContractError("PRIMARY_REWARD_CONTRACT_MISMATCH")
        if (
            task.get("reward_contract") is not None
            and task["reward_contract"] != contract
        ):
            raise ContractError("REWARD_CONTRACT_MISMATCH")
        task["reward_contract"] = copy.deepcopy(contract)
    return manifest


def _installed_harbor_commit() -> str | None:
    direct_url = importlib.metadata.distribution("harbor").read_text("direct_url.json")
    if not direct_url:
        return None
    return json.loads(direct_url).get("vcs_info", {}).get("commit_id")


def verify_runtime(project_dir: Path) -> dict[str, str]:
    version = importlib.metadata.version("harbor")
    commit = _installed_harbor_commit()
    if version != HARBOR_VERSION or commit != HARBOR_COMMIT:
        raise ContractError(
            f"installed Harbor is {version}@{commit}; expected {HARBOR_VERSION}@{HARBOR_COMMIT}"
        )
    lock_path = project_dir / "uv.lock"
    lock_text = lock_path.read_text()
    if HARBOR_COMMIT not in lock_text:
        raise ContractError("uv.lock does not contain the pinned Harbor commit")
    return {
        "harbor_version": version,
        "harbor_commit": commit,
        "uv_lock_sha256": _sha256_file(lock_path),
    }


def _trial_dir(event: TrialHookEvent) -> Path:
    parsed = urlparse(event.result.trial_uri)
    if parsed.scheme != "file":
        raise ContractError(f"Harbor trial URI is not local: {event.result.trial_uri}")
    return Path(unquote(parsed.path))


def _freeze_file(
    source: Path, destination: Path, *, relative_path: str | None = None
) -> dict[str, Any]:
    if not source.is_file() or source.is_symlink():
        raise ContractError("SOURCE_TRAJECTORY_MISSING_OR_UNSAFE")
    if destination.exists() or destination.is_symlink():
        raise ContractError("OUTPUT_ALREADY_EXISTS")
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    before = os.fstat(source_fd)
    if before.st_size > MAX_TRAJECTORY_BYTES:
        os.close(source_fd)
        raise ContractError("source trajectory exceeds the 256 MiB raw limit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    temporary_path = Path(temporary)
    digest = hashlib.sha256()
    copied = 0
    try:
        with os.fdopen(source_fd, "rb") as src, os.fdopen(fd, "wb") as dst:
            while chunk := src.read(1024 * 1024):
                copied += len(chunk)
                if copied > MAX_TRAJECTORY_BYTES:
                    raise ContractError(
                        "source trajectory grew beyond the 256 MiB raw limit"
                    )
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        after = os.stat(source, follow_symlinks=False)
        identity_before = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        )
        identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if identity_before != identity_after or copied != after.st_size:
            raise ContractError("source trajectory changed while being frozen")
        try:
            os.link(temporary_path, destination)
        except FileExistsError as error:
            raise ContractError("OUTPUT_ALREADY_EXISTS") from error
        temporary_path.unlink()
        directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary_path.unlink(missing_ok=True)
    frozen_stat = destination.stat()
    return {
        "relative_path": relative_path or destination.name,
        "sha256": f"sha256:{digest.hexdigest()}",
        "size_bytes": copied,
        "file_identity": {
            "device": frozen_stat.st_dev,
            "inode": frozen_stat.st_ino,
        },
    }


@dataclass
class LifecycleRecorder:
    attempt_kind: str
    manifest_path: Path | None = None
    freeze_destination: Path | None = None
    freeze_relative_path: str | None = None
    replay_trajectory_destination: Path | None = None
    replay_trajectory_sha256: str | None = None
    states: dict[str, str] = field(default_factory=dict)
    records: list[dict[str, Any]] = field(default_factory=list)
    manifest: dict[str, Any] | None = None
    clock_ns: Callable[[], int] = time.perf_counter_ns
    run_started_ns: int | None = None
    agent_started_ns: int | None = None
    verification_started_ns: int | None = None
    setup_ms: float | None = None
    agent_ms: float | None = None
    verifier_ms: float | None = None
    trial_dir: Path | None = None

    def begin_run(self) -> None:
        if self.run_started_ns is not None:
            raise ContractError("run timing was started twice")
        self.run_started_ns = self.clock_ns()

    @staticmethod
    def _elapsed_ms(start_ns: int, end_ns: int) -> float:
        if end_ns < start_ns:
            raise ContractError("monotonic lifecycle clock moved backwards")
        return (end_ns - start_ns) / 1_000_000

    def phase_timings(self) -> dict[str, float]:
        if self.setup_ms is None or self.agent_ms is None or self.verifier_ms is None:
            raise ContractError("successful trial has incomplete phase timings")
        return {
            "setup_ms": self.setup_ms,
            "agent_ms": self.agent_ms,
            "verifier_ms": self.verifier_ms,
        }

    def interactions(self) -> dict[str, int]:
        if self.trial_dir is None:
            raise ContractError("successful trial has no observed trial directory")
        try:
            payload = json.loads(
                (self.trial_dir / "agent" / "trajectory.json").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, json.JSONDecodeError) as error:
            raise ContractError(
                "successful trial trajectory is absent or corrupt"
            ) from error
        steps = payload.get("steps") if isinstance(payload, dict) else None
        if not isinstance(steps, list):
            raise ContractError("successful trial trajectory has no ATIF steps")
        turns = 0
        tool_calls = 0
        for step in steps:
            if not isinstance(step, dict):
                raise ContractError(
                    "successful trial trajectory contains an invalid step"
                )
            turns += int(step.get("source") == "agent")
            calls = step.get("tool_calls", [])
            if calls is not None and not isinstance(calls, list):
                raise ContractError(
                    "successful trial trajectory contains invalid tool calls"
                )
            tool_calls += len(calls or [])
        return {"turns": turns, "tool_calls": tool_calls}

    def _record(self, event: TrialHookEvent, name: str) -> None:
        self.records.append(
            {
                "ordinal": len(self.records) + 1,
                "event": name,
                "timestamp": event.timestamp.isoformat(),
            }
        )

    async def on_agent_started(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if key in self.states:
            raise ContractError("agent-started event was duplicated or out of order")
        if self.run_started_ns is None:
            raise ContractError("agent-started event occurred before run timing began")
        self.agent_started_ns = self.clock_ns()
        self.trial_dir = _trial_dir(event)
        self.setup_ms = self._elapsed_ms(self.run_started_ns, self.agent_started_ns)
        await asyncio.to_thread(
            _notify_lifecycle, event, "agent_started", self.attempt_kind
        )
        self.states[key] = "agent-started"
        self._record(event, "agent_started")

    async def on_agent_ended(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if self.states.get(key) != "agent-started":
            raise ContractError("agent-ended event occurred before agent-started")
        if self.agent_started_ns is None:
            raise ContractError("agent timing was not started")
        agent_ended_ns = self.clock_ns()
        self.agent_ms = self._elapsed_ms(self.agent_started_ns, agent_ended_ns)
        await asyncio.to_thread(
            _notify_lifecycle, event, "agent_ended", self.attempt_kind
        )
        self.states[key] = "agent-ended"
        self._record(event, "agent_ended")

    async def on_verification_started(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if self.states.get(key) != "agent-ended":
            raise ContractError(
                "verification-started event occurred before agent-ended"
            )
        self.verification_started_ns = self.clock_ns()
        if self.attempt_kind == "replay":
            if (
                self.replay_trajectory_destination is None
                or self.freeze_relative_path is None
                or self.manifest_path is None
            ):
                raise ContractError("REPLAY_TRAJECTORY_OUTPUT_MISSING")
            frozen = _freeze_file(
                _trial_dir(event) / "agent" / "trajectory.json",
                self.replay_trajectory_destination,
                relative_path=self.freeze_relative_path,
            )
            self.replay_trajectory_sha256 = frozen["sha256"]
            self._record(event, "trajectory_materialized")
            self.states[key] = "verification-started"
            self._record(event, "verification_started")
            step_identities, agent_native = _step_identities(
                self.replay_trajectory_destination
            )
            self.manifest = {
                "schema_version": FREEZE_MANIFEST_SCHEMA,
                "adapter": {
                    "name": "harbor-codex",
                    "version": HARBOR_VERSION,
                    "commit": HARBOR_COMMIT,
                    "raw_reasoning_capture_disabled": True,
                },
                "source_attempt": {
                    "trial_id": str(event.trial_id),
                    "task_name": event.task_name,
                },
                "lifecycle": self.records,
                "cutoff": {
                    "agent_last_native_event_ordinal": agent_native,
                    "step_identities": step_identities,
                },
                "frozen_artifact": frozen,
            }
            _atomic_json(self.manifest_path, self.manifest, no_overwrite=True)
            return
        if (
            self.freeze_destination is None
            or self.freeze_relative_path is None
            or self.manifest_path is None
        ):
            raise ContractError("SOURCE_FREEZE_OUTPUTS_MISSING")
        frozen = _freeze_file(
            _trial_dir(event) / "agent" / "trajectory.json",
            self.freeze_destination,
            relative_path=self.freeze_relative_path,
        )
        self._record(event, "trajectory_materialized")
        self.states[key] = "verification-started"
        self._record(event, "verification_started")
        step_identities, agent_native = _step_identities(self.freeze_destination)
        self.manifest = {
            "schema_version": FREEZE_MANIFEST_SCHEMA,
            "adapter": {
                "name": "harbor-codex",
                "version": HARBOR_VERSION,
                "commit": HARBOR_COMMIT,
                "raw_reasoning_capture_disabled": True,
            },
            "source_attempt": {
                "trial_id": str(event.trial_id),
                "task_name": event.task_name,
            },
            "lifecycle": self.records,
            "cutoff": {
                "agent_last_native_event_ordinal": agent_native,
                "step_identities": step_identities,
            },
            "frozen_artifact": frozen,
        }
        _atomic_json(self.manifest_path, self.manifest, no_overwrite=True)

    async def on_trial_ended(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if self.states.get(key) != "verification-started":
            raise ContractError(
                "trial-ended event occurred before verification-started"
            )
        if self.verification_started_ns is None:
            raise ContractError("verifier timing was not started")
        self.verifier_ms = self._elapsed_ms(
            self.verification_started_ns, self.clock_ns()
        )
        await asyncio.to_thread(
            _notify_lifecycle, event, "trial_ended", self.attempt_kind
        )
        self.states[key] = "trial-ended"
        self._record(event, "trial_ended")

    async def on_trial_cancelled(self, event: TrialHookEvent) -> None:
        await asyncio.to_thread(
            _notify_lifecycle, event, "trial_cancelled", self.attempt_kind
        )


def _step_identities(path: Path) -> tuple[list[dict[str, Any]], int | None]:
    try:
        root = json.loads(path.read_bytes(), object_pairs_hook=_reject_duplicate_pairs)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ContractError("INVALID_FROZEN_TRAJECTORY_JSON") from error
    if not isinstance(root, dict) or not isinstance(root.get("steps"), list):
        raise ContractError("INVALID_FROZEN_TRAJECTORY_STEPS")
    identities: list[dict[str, Any]] = []
    native_ordinals: list[int] = []
    for index, step in enumerate(root["steps"], start=1):
        if not isinstance(step, dict) or step.get("step_id") != index:
            raise ContractError("INVALID_FROZEN_TRAJECTORY_STEPS")
        extra = step.get("extra")
        native = step.get("last_native_event_ordinal")
        if native is None and isinstance(extra, dict):
            native = extra.get("last_native_event_ordinal")
        if native is not None:
            if not isinstance(native, int) or isinstance(native, bool) or native < 1:
                raise ContractError("INVALID_NATIVE_EVENT_ORDINAL")
            if native_ordinals and native <= native_ordinals[-1]:
                raise ContractError("NON_MONOTONIC_NATIVE_EVENT_ORDINAL")
            native_ordinals.append(native)
        identity_input = f"{index}:{native if native is not None else 'none'}".encode()
        identities.append(
            {
                "step_id": index,
                "identity_sha256": (
                    f"sha256:{hashlib.sha256(identity_input).hexdigest()}"
                ),
                "last_native_event_ordinal": native,
            }
        )
    if native_ordinals and len(native_ordinals) != len(identities):
        raise ContractError("INCOMPLETE_NATIVE_EVENT_ORDINALS")
    return identities, native_ordinals[-1] if native_ordinals else None


def _strict_request(path: Path) -> dict[str, Any]:
    request = json.loads(path.read_text(), object_pairs_hook=_reject_duplicate_pairs)
    if not isinstance(request, dict):
        raise ContractError("RUN_REQUEST_NOT_OBJECT")
    allowed = {
        "schema_version",
        "attempt_kind",
        "task_name",
        "task_image",
        "job_config",
        "corpus_manifest",
        "run_root",
        "codex_version",
        "codex_binary_sha256",
        "codex_code_mode_host_sha256",
        "freeze_manifest_path",
        "freeze_trajectory_to",
        "replay_trajectory_path",
        "result_path",
        "developer_instructions_sha256",
    }
    unknown = set(request) - allowed
    if unknown:
        raise ContractError("UNKNOWN_RUN_REQUEST_KEY")
    required = allowed - {
        "result_path",
        "freeze_manifest_path",
        "freeze_trajectory_to",
        "replay_trajectory_path",
        "developer_instructions_sha256",
    }
    missing = required - set(request)
    if missing:
        raise ContractError("MISSING_RUN_REQUEST_KEY")
    if request["schema_version"] != RUN_REQUEST_SCHEMA:
        raise ContractError("unsupported run request schema")
    if not isinstance(request["job_config"], dict):
        raise ContractError("INVALID_JOB_CONFIG")
    if not isinstance(request["codex_version"], str) or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", request["codex_version"]
    ):
        raise ContractError("INVALID_CODEX_VERSION")
    if not isinstance(request["codex_binary_sha256"], str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", request["codex_binary_sha256"]
    ):
        raise ContractError("INVALID_CODEX_BINARY_DIGEST")
    if not isinstance(request["codex_code_mode_host_sha256"], str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", request["codex_code_mode_host_sha256"]
    ):
        raise ContractError("INVALID_CODE_MODE_HOST_DIGEST")
    if request.get("attempt_kind") not in {"source", "replay"}:
        raise ContractError("INVALID_ATTEMPT_KIND")
    if not isinstance(request["task_image"], str) or not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9./:_-]*[a-z0-9])?@sha256:[a-f0-9]{64}",
        request["task_image"],
    ):
        raise ContractError("INVALID_TASK_IMAGE")
    freeze_fields = {"freeze_manifest_path", "freeze_trajectory_to"} & set(request)
    if request["attempt_kind"] == "source" and freeze_fields != {
        "freeze_manifest_path",
        "freeze_trajectory_to",
    }:
        raise ContractError("SOURCE_FREEZE_OUTPUTS_REQUIRED")
    if request["attempt_kind"] == "source" and "replay_trajectory_path" in request:
        raise ContractError("SOURCE_REPLAY_TRAJECTORY_FORBIDDEN")
    developer_instructions_sha256 = request.get("developer_instructions_sha256")
    if developer_instructions_sha256 is not None and (
        not isinstance(developer_instructions_sha256, str)
        or not re.fullmatch(r"[a-f0-9]{64}", developer_instructions_sha256)
    ):
        raise ContractError("INVALID_DEVELOPER_INSTRUCTIONS_DIGEST")
    if request["attempt_kind"] == "replay" and "replay_trajectory_path" not in request:
        raise ContractError("REPLAY_TRAJECTORY_OUTPUT_REQUIRED")
    if request["attempt_kind"] == "replay" and freeze_fields != {
        "freeze_manifest_path"
    }:
        raise ContractError("REPLAY_FREEZE_MANIFEST_REQUIRED")
    return request


def _validated_run_root(value: Any) -> Path:
    if not isinstance(value, str) or not value:
        raise ContractError("INVALID_RUN_ROOT")
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.is_symlink():
        raise ContractError("INVALID_RUN_ROOT")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_dir():
        raise ContractError("INVALID_RUN_ROOT")
    return resolved


def _output_beneath(run_root: Path, value: Any) -> tuple[Path, str]:
    if not isinstance(value, str) or not value:
        raise ContractError("INVALID_OUTPUT_PATH")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts or relative == Path("."):
        raise ContractError("INVALID_OUTPUT_PATH")
    destination = (run_root / relative).resolve(strict=False)
    if not destination.is_relative_to(run_root):
        raise ContractError("INVALID_OUTPUT_PATH")
    current = run_root
    for component in relative.parts[:-1]:
        current /= component
        if current.exists() and (current.is_symlink() or not current.is_dir()):
            raise ContractError("UNSAFE_OUTPUT_PARENT")
    if destination.exists() or destination.is_symlink():
        raise ContractError("OUTPUT_ALREADY_EXISTS")
    return destination, relative.as_posix()


def _strict_nested_config(
    value: Any, allowed: frozenset[str], reason: str
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - allowed:
        raise ContractError(reason)
    return value


def _validate_empty_env(value: Any, reason: str) -> None:
    if not isinstance(value, dict) or value:
        raise ContractError(reason)


def _validate_codex_agent_env(value: Any) -> None:
    if not isinstance(value, dict) or set(value) - CODEX_AGENT_ENV_FIELDS:
        raise ContractError("DISALLOWED_AGENT_ENV")
    if any(not isinstance(item, str) or not item for item in value.values()):
        raise ContractError("INVALID_AGENT_ENV")
    if value.get("OPENAI_API_KEY", "${OPENAI_API_KEY}") != "${OPENAI_API_KEY}":
        raise ContractError("INVALID_CODEX_PROVIDER_CREDENTIAL")
    if (
        value.get("KOED_BENCHMARK_MCP_TOKEN", "${KOED_BENCHMARK_MCP_TOKEN}")
        != "${KOED_BENCHMARK_MCP_TOKEN}"
    ):
        raise ContractError("INVALID_BENCHMARK_MCP_TOKEN_REFERENCE")


def _validate_extra_allowed_hosts(value: Any) -> None:
    def allowed(item: str) -> bool:
        if item in CODEX_EXTRA_ALLOWED_HOSTS:
            return True
        try:
            address = ipaddress.ip_address(item)
        except ValueError:
            return False
        return (
            isinstance(address, ipaddress.IPv4Address)
            and address.is_private
            and not address.is_loopback
            and not address.is_link_local
        )

    if (
        not isinstance(value, list)
        or any(not isinstance(item, str) for item in value)
        or any(not allowed(item) for item in value)
    ):
        raise ContractError("DISALLOWED_EXTRA_ALLOWED_HOST")


def _validate_codex_kwargs(
    value: Any, developer_instructions_sha256: str | None = None
) -> str | None:
    kwargs = _strict_nested_config(
        value, frozenset({"config", "version"}), "DISALLOWED_CODEX_KWARG"
    )
    if not isinstance(kwargs.get("version"), str) or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", kwargs["version"]
    ):
        raise ContractError("INVALID_CODEX_VERSION")
    config = _strict_nested_config(
        kwargs.get("config"), SAFE_CODEX_CONFIG_FIELDS, "DISALLOWED_CODEX_CONFIG_FIELD"
    )
    required = SAFE_CODEX_CONFIG_FIELDS - {"mcp_servers", "developer_instructions"}
    if not required.issubset(config):
        raise ContractError("INCOMPLETE_CODEX_CONFIG")
    if (
        config.get("approval_policy") != "never"
        or config.get("web_search") != "disabled"
    ):
        raise ContractError("UNSAFE_CODEX_CONFIG")
    if config.get("features") != {"mcp_2026_07_28": True}:
        raise ContractError("MCP_2026_PROTOCOL_REQUIRED")
    if config.get("suppress_unstable_features_warning") is not True:
        raise ContractError("UNSTABLE_FEATURE_WARNING_MUST_BE_SUPPRESSED")
    developer_instructions = config.get("developer_instructions")
    product_path_instructions = (
        "This is a product-path validation run. Before making changes, call the available "
        "memory_answer tool exactly once with a concise project-scoped query asking for prior "
        'experience relevant to the task. Explicitly set search_domain to "project" and '
        'response_detail to "answer_only". Use the answer if useful, then complete the task '
        "normally. Do not call memory_answer again."
    )
    if developer_instructions is not None:
        valid_product_path = developer_instructions == product_path_instructions
        valid_oracle_source = (
            developer_instructions_sha256 is not None
            and hashlib.sha256(developer_instructions.encode("utf-8")).hexdigest()
            == developer_instructions_sha256
        )
        if not valid_product_path and not valid_oracle_source:
            raise ContractError("UNSAFE_CODEX_DEVELOPER_INSTRUCTIONS")
    for key in (
        "include_permissions_instructions",
        "include_apps_instructions",
        "include_collaboration_mode_instructions",
        "include_environment_context",
    ):
        if config.get(key) is not False:
            raise ContractError("UNSAFE_CODEX_CONFIG")
    if config.get("project_doc_max_bytes") != 4096:
        raise ContractError("UNSAFE_CODEX_CONFIG")
    if config.get("agents") != {"enabled": False} or config.get("skills") != {
        "include_instructions": False
    }:
        raise ContractError("UNSAFE_CODEX_CONFIG")
    servers = config.get("mcp_servers")
    if servers is None:
        return None
    if not isinstance(servers, dict) or set(servers) != {"koed"}:
        raise ContractError("DISALLOWED_CODEX_MCP_CONFIG")
    koed = _strict_nested_config(
        servers["koed"],
        frozenset(
            {
                "url",
                "bearer_token_env_var",
                "enabled_tools",
                "required",
                "default_tools_approval_mode",
            }
        ),
        "DISALLOWED_CODEX_MCP_CONFIG",
    )
    url_match = (
        re.fullmatch(r"http://(?P<host>[^/:]+):[1-9][0-9]{0,4}", koed.get("url", ""))
        if isinstance(koed.get("url"), str)
        else None
    )
    mcp_host = url_match.group("host") if url_match else None
    if mcp_host not in {"127.0.0.1", "host.docker.internal"}:
        try:
            mcp_address = ipaddress.ip_address(mcp_host or "")
        except ValueError:
            mcp_address = None
        if not (
            isinstance(mcp_address, ipaddress.IPv4Address)
            and mcp_address.is_private
            and not mcp_address.is_loopback
            and not mcp_address.is_link_local
        ):
            raise ContractError("UNSAFE_CODEX_MCP_CONFIG")
    if (
        not url_match
        or koed.get("bearer_token_env_var") != "KOED_BENCHMARK_MCP_TOKEN"
        or koed.get("enabled_tools") != ["memory_answer"]
        or koed.get("required") is not True
        or koed.get("default_tools_approval_mode") != "approve"
    ):
        raise ContractError("UNSAFE_CODEX_MCP_CONFIG")
    return mcp_host


def _validate_job_config_allowlist(
    job_fields: dict[str, Any], developer_instructions_sha256: str | None = None
) -> None:
    if set(job_fields) - SAFE_JOB_CONFIG_FIELDS:
        raise ContractError("DISALLOWED_JOB_CONFIG_FIELD")
    if "retry" in job_fields:
        _strict_nested_config(
            job_fields["retry"],
            SAFE_RETRY_CONFIG_FIELDS,
            "DISALLOWED_RETRY_CONFIG_FIELD",
        )
    job_fields.setdefault("environment", {})
    if "environment" in job_fields:
        environment = _strict_nested_config(
            job_fields["environment"],
            SAFE_ENVIRONMENT_CONFIG_FIELDS,
            "DISALLOWED_ENVIRONMENT_CONFIG_FIELD",
        )
        if environment.get("delete", True) is not True:
            raise ContractError("ENVIRONMENT_DELETION_REQUIRED")
        if "env" in environment:
            _validate_empty_env(environment["env"], "DISALLOWED_ENVIRONMENT_ENV")
        if "extra_allowed_hosts" in environment:
            _validate_extra_allowed_hosts(environment["extra_allowed_hosts"])
        environment["delete"] = True
    job_fields.setdefault("verifier", {})
    if "verifier" in job_fields:
        verifier = _strict_nested_config(
            job_fields["verifier"],
            SAFE_VERIFIER_CONFIG_FIELDS,
            "DISALLOWED_VERIFIER_CONFIG_FIELD",
        )
        if verifier.get("disable", False) is not False:
            raise ContractError("VERIFIER_REQUIRED")
        if "env" in verifier:
            _validate_empty_env(verifier["env"], "DISALLOWED_VERIFIER_ENV")
        verifier["disable"] = False
    if "agents" in job_fields:
        agents = job_fields["agents"]
        if not isinstance(agents, list):
            raise ContractError("INVALID_AGENTS_CONFIG")
        for agent in agents:
            agent = _strict_nested_config(
                agent, SAFE_AGENT_CONFIG_FIELDS, "DISALLOWED_AGENT_CONFIG_FIELD"
            )
            mcp_host: str | None = None
            if "env" in agent:
                if agent.get("name") != CODEX_AGENT_NAME:
                    raise ContractError("DISALLOWED_AGENT_ENV")
                _validate_codex_agent_env(agent["env"])
            if "extra_allowed_hosts" in agent:
                if agent.get("name") != CODEX_AGENT_NAME:
                    raise ContractError("DISALLOWED_EXTRA_ALLOWED_HOST")
                _validate_extra_allowed_hosts(agent["extra_allowed_hosts"])
            if "kwargs" in agent:
                if agent.get("name") != CODEX_AGENT_NAME:
                    raise ContractError("DISALLOWED_AGENT_KWARGS")
                mcp_host = _validate_codex_kwargs(
                    agent["kwargs"], developer_instructions_sha256
                )
            private_hosts = {
                host
                for host in agent.get("extra_allowed_hosts", [])
                if host not in CODEX_EXTRA_ALLOWED_HOSTS
            }
            expected_private_hosts = (
                {mcp_host}
                if mcp_host not in {None, "127.0.0.1", "host.docker.internal"}
                else set()
            )
            if private_hosts != expected_private_hosts:
                raise ContractError("MCP_HOST_EGRESS_MISMATCH")
            if (
                mcp_host
                and mcp_host != "127.0.0.1"
                and mcp_host not in agent.get("extra_allowed_hosts", [])
            ):
                raise ContractError("MCP_HOST_EGRESS_MISMATCH")


def _verify_resolved_tasks(
    configs: list[TaskConfig],
    downloads: dict[Any, Any],
    manifest: dict[str, Any],
    task_name: str,
) -> Path:
    expected = {task["name"]: task for task in manifest["tasks"]}
    if task_name not in expected:
        raise ContractError(f"task {task_name!r} is not in the pinned corpus manifest")
    if len(configs) != 1:
        raise ContractError(
            f"Harbor resolved {len(configs)} tasks; a runner job must resolve one"
        )
    config = configs[0]
    task_id = config.get_task_id()
    download = downloads[task_id]
    record = expected[task_name]
    resolved_config = tomllib.loads((download.path / "task.toml").read_text())
    canonical_name = resolved_config.get("task", {}).get("name")
    actual_checksum = f"sha256:{dirhash(download.path, 'sha256')}"
    actual_digest = f"sha256:{Packager.compute_content_hash(download.path)[0]}"
    actual_commit = download.resolved_git_commit_id or config.git_commit_id
    actual_path = config.path.as_posix() if config.path else None
    mismatches = {
        "name": (canonical_name, task_name),
        "source_path": (actual_path, record["source_path"]),
        "harbor_task_checksum": (actual_checksum, record["harbor_task_checksum"]),
        "task_digest": (actual_digest, record["task_digest"]),
        "commit": (actual_commit, TB_COMMIT),
        "agent_timeout_seconds": (
            _task_timeout_seconds(
                resolved_config.get("agent"), "agent", task_name
            ),
            record["agent_timeout_seconds"],
        ),
        "verifier_timeout_seconds": (
            _task_timeout_seconds(
                resolved_config.get("verifier"), "verifier", task_name
            ),
            record["verifier_timeout_seconds"],
        ),
    }
    failed = {
        key: values for key, values in mismatches.items() if values[0] != values[1]
    }
    if failed:
        raise ContractError(
            f"resolved Harbor task differs from corpus manifest: {failed}"
        )
    return download.path


def _validate_pinned_task_image(task_image: str) -> None:
    if not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9./:_-]*[a-z0-9])?@sha256:[a-f0-9]{64}",
        task_image,
    ):
        raise ContractError("INVALID_TASK_IMAGE")


async def _await_codex_mcp_bridge(agent: Codex, environment: Any) -> None:
    servers = agent._base_config.get("mcp_servers")
    if not isinstance(servers, dict):
        return
    koed = servers.get("koed")
    if not isinstance(koed, dict) or not isinstance(koed.get("url"), str):
        return
    parsed = urlparse(koed["url"])
    if parsed.scheme != "http" or not parsed.hostname or parsed.port is None:
        raise ContractError("INVALID_CODEX_MCP_BRIDGE_URL")
    target = shlex.quote(f"exec 3<>/dev/tcp/{parsed.hostname}/{parsed.port}")
    readiness = (
        "deadline=$((SECONDS + 30)); "
        f"while ! timeout 2 bash -c {target} 2>/dev/null; do "
        "if [ \"$SECONDS\" -ge \"$deadline\" ]; then "
        "echo 'benchmark bridge was not reachable from the task container' >&2; "
        "exit 1; fi; "
        "sleep 0.25; "
        "done"
    )
    command = (
        "command -v bash >/dev/null 2>&1 && "
        "command -v timeout >/dev/null 2>&1 || "
        "{ echo 'benchmark bridge readiness tools are unavailable' >&2; exit 1; }; "
        f"bash -c {shlex.quote(readiness)}"
    )
    result = await agent.exec_as_agent(environment, command=command)
    if result.return_code != 0:
        raise ContractError("MCP_BRIDGE_CONTAINER_READINESS_FAILED")


@contextlib.contextmanager
def _pinned_task_image(task_image: str):
    """Bridge Harbor 0.21's missing public per-trial image override."""
    _validate_pinned_task_image(task_image)
    original = Trial._init_agent_environment
    original_factory_descriptor = EnvironmentFactory.__dict__[
        "create_environment_from_config"
    ]
    original_factory = EnvironmentFactory.create_environment_from_config

    def initialize(trial: Trial) -> None:
        def create_agent_environment(*args: Any, **kwargs: Any) -> Any:
            task_env_config = kwargs.get("task_env_config")
            if task_env_config is None:
                raise ContractError("HARBOR_AGENT_ENVIRONMENT_CONFIG_MISSING")
            kwargs["task_env_config"] = task_env_config.model_copy(
                deep=True,
                update={"docker_image": task_image},
            )
            return original_factory(*args, **kwargs)

        EnvironmentFactory.create_environment_from_config = staticmethod(
            create_agent_environment
        )
        try:
            original(trial)
        finally:
            EnvironmentFactory.create_environment_from_config = (
                original_factory_descriptor
            )

    Trial._init_agent_environment = initialize
    try:
        yield
    finally:
        Trial._init_agent_environment = original


@contextlib.contextmanager
def _pinned_codex_binary(request: dict[str, Any]):
    """Install the exact preflight-attested Linux Codex binary in the trial."""
    configured = os.environ.get("KOED_HARBOR_CODEX_BINARY")
    if not configured:
        raise ContractError("CODEX_BINARY_PATH_MISSING")
    binary = Path(configured)
    try:
        info = binary.lstat()
        resolved = binary.resolve(strict=True)
    except OSError as error:
        raise ContractError("CODEX_BINARY_UNAVAILABLE") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ContractError("CODEX_BINARY_UNSAFE")
    if _sha256_file(resolved) != request["codex_binary_sha256"]:
        raise ContractError("CODEX_BINARY_DIGEST_MISMATCH")
    helper = resolved.with_name("codex-code-mode-host")
    try:
        helper_info = helper.lstat()
        helper_resolved = helper.resolve(strict=True)
    except OSError as error:
        raise ContractError("CODE_MODE_HOST_UNAVAILABLE") from error
    if stat.S_ISLNK(helper_info.st_mode) or not stat.S_ISREG(helper_info.st_mode):
        raise ContractError("CODE_MODE_HOST_UNSAFE")
    if _sha256_file(helper_resolved) != request["codex_code_mode_host_sha256"]:
        raise ContractError("CODE_MODE_HOST_DIGEST_MISMATCH")
    try:
        guidance_info = AGENT_GUIDANCE_PATH.lstat()
        guidance_resolved = AGENT_GUIDANCE_PATH.resolve(strict=True)
    except OSError as error:
        raise ContractError("AGENT_GUIDANCE_UNAVAILABLE") from error
    if stat.S_ISLNK(guidance_info.st_mode) or not stat.S_ISREG(
        guidance_info.st_mode
    ):
        raise ContractError("AGENT_GUIDANCE_UNSAFE")
    guidance_sha256 = _sha256_file(guidance_resolved)

    original = Codex.install
    original_run = Codex.run

    async def install(agent: Codex, environment: Any) -> None:
        del agent
        temporary = "/tmp/koed-pinned-codex"
        helper_temporary = "/tmp/koed-pinned-codex-code-mode-host"
        guidance_temporary = "/tmp/koed-agent-guidance"
        await environment.upload_file(resolved, temporary)
        await environment.upload_file(helper_resolved, helper_temporary)
        await environment.upload_file(guidance_resolved, guidance_temporary)
        result = await environment.exec(
            command=(
                f"install -m 0755 {temporary} /usr/local/bin/codex && "
                f"install -m 0755 {helper_temporary} /usr/local/bin/codex-code-mode-host && "
                f"install -m 0644 {guidance_temporary} /app/AGENTS.md && "
                f"rm -f {temporary} {helper_temporary} {guidance_temporary} && "
                "sha256sum /usr/local/bin/codex /usr/local/bin/codex-code-mode-host "
                "/app/AGENTS.md && "
                "codex --version"
            ),
            user="root",
        )
        if result.return_code != 0:
            raise ContractError("PINNED_CODEX_INSTALL_FAILED")
        output = result.stdout or ""
        expected = request["codex_binary_sha256"].removeprefix("sha256:")
        helper_expected = request["codex_code_mode_host_sha256"].removeprefix("sha256:")
        if (
            expected not in output
            or helper_expected not in output
            or guidance_sha256.removeprefix("sha256:") not in output
            or request["codex_version"] not in output
        ):
            raise ContractError("PINNED_CODEX_ATTESTATION_FAILED")

    async def run(
        agent: Codex, instruction: str, environment: Any, context: Any
    ) -> None:
        await _await_codex_mcp_bridge(agent, environment)
        await original_run(agent, instruction, environment, context)

    Codex.install = install
    Codex.run = run
    try:
        yield
    finally:
        Codex.install = original
        Codex.run = original_run


@contextlib.contextmanager
def _suppress_process_stdout():
    """Reserve stdout for the runner's single JSON protocol response."""
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    try:
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink):
            os.dup2(sink.fileno(), 1)
            yield
            sink.flush()
    finally:
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


async def _compose_built_image_reference(environment: Any) -> str:
    result = await environment._run_docker_compose_command(
        ["images", "--format", "json"]
    )
    try:
        images = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE") from error
    if not isinstance(images, list) or len(images) != 1:
        raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE")
    image = images[0]
    if not isinstance(image, dict):
        raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE")
    image_id = image.get("ID")
    if not isinstance(image_id, str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", image_id
    ):
        raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE")
    return image_id


async def _prepare_separate_verifier_environment(trial: Trial) -> None:
    verifier = getattr(trial.task.config, "verifier", None)
    if (
        verifier is None
        or verifier.environment_mode != VerifierEnvironmentMode.SEPARATE
    ):
        return
    env_config = resolve_effective_verifier_env_config(trial.task.config, None)
    if env_config is None:
        raise ContractError("SEPARATE_VERIFIER_ENVIRONMENT_MISSING")
    trial.paths.verifier_dir.mkdir(parents=True, exist_ok=True)
    plan = trial._network_plan(None, env_config=env_config)
    async with trial._separate_verifier_env(
        env_config,
        key="preflight",
        plan=plan,
        step_cfg=None,
    ):
        pass


async def provision_task_image(
    manifest_path: Path,
    task_name: str,
    task_digest: str,
    registry: str,
    docker: str = "docker",
) -> dict[str, Any]:
    verify_runtime(Path(__file__).resolve().parent)
    bundled_manifest = (
        Path(__file__).resolve().parent.parent / "fixtures" / "tb3-v3.0.0.json"
    ).resolve()
    try:
        supplied_manifest = manifest_path.resolve(strict=True)
    except OSError as error:
        raise ContractError("INVALID_CORPUS_MANIFEST_PATH") from error
    if supplied_manifest != bundled_manifest:
        raise ContractError("INVALID_CORPUS_MANIFEST_PATH")
    manifest = load_and_verify_manifest(supplied_manifest)
    manifest_by_name = {task["name"]: task for task in manifest["tasks"]}
    record = manifest_by_name.get(task_name)
    if record is None:
        raise ContractError("TASK_NOT_IN_PINNED_CORPUS")
    if (
        not re.fullmatch(r"sha256:[a-f0-9]{64}", task_digest)
        or task_digest != record["task_digest"]
    ):
        raise ContractError("TASK_DIGEST_MISMATCH")
    repository = _registry_repository(registry, task_name)
    tag = f"{repository}:{task_digest.removeprefix('sha256:')}"
    task_selector = Path(record["source_path"]).name

    with tempfile.TemporaryDirectory(prefix="koed-harbor-image-") as temporary:
        root = Path(temporary).resolve()
        config = JobConfig.model_validate(
            {
                "job_name": f"preflight-{task_selector}",
                "jobs_dir": root / "jobs",
                "quiet": True,
                "n_attempts": 1,
                "n_concurrent_trials": 1,
                "retry": {"max_retries": 0},
                "environment": {"force_build": True, "delete": True},
                "verifier": {"disable": False},
                "agents": [{"name": "nop"}],
                "datasets": [
                    DatasetConfig(
                        repo=TB_REPO,
                        path=Path("tasks"),
                        task_names=[task_selector],
                    )
                ],
                "tasks": [],
                "source_jobs": [],
            }
        )
        job = await Job.create(config)
        if len(job) != 1:
            raise ContractError("HARBOR_IMAGE_JOB_NOT_SINGLE_TASK")
        _verify_resolved_tasks(
            job._task_configs,
            job._task_download_results,
            manifest,
            task_name,
        )
        trial_configs = job._trial_configs
        if len(trial_configs) != 1:
            raise ContractError("HARBOR_IMAGE_JOB_NOT_SINGLE_TASK")
        trial = await Trial.create(trial_configs[0])
        environment = trial.agent_environment
        dockerfile = trial.task.paths.environment_dir / "Dockerfile"
        dockerfile_sha256, base_references = _dockerfile_base_references(dockerfile)
        base_digests_before_build = _resolved_base_digests(docker, base_references)
        started = False
        try:
            await environment.start(force_build=True)
            started = True
            use_prebuilt = getattr(environment, "_use_prebuilt", None)
            if use_prebuilt is True:
                built_reference = trial.task.config.environment.docker_image
            elif use_prebuilt is False:
                built_reference = await _compose_built_image_reference(environment)
            else:
                raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE")
            if not isinstance(built_reference, str) or not built_reference:
                raise ContractError("HARBOR_IMAGE_IDENTITY_UNAVAILABLE")

            if _sha256_file(dockerfile) != dockerfile_sha256:
                raise ContractError("DOCKERFILE_CHANGED_DURING_BUILD")
            built = _docker_inspect(docker, built_reference)
            image_id = built["Id"]
            _run_docker(docker, ["tag", built_reference, tag])
            _run_docker(docker, ["push", tag], timeout=1800)
            pushed = _docker_inspect(docker, tag)
            if pushed["Id"] != image_id:
                raise ContractError("OCI_IMAGE_CHANGED_DURING_PUSH")
            immutable_candidates = {
                value
                for value in pushed["RepoDigests"]
                if value.startswith(f"{repository}@")
                and re.fullmatch(r"sha256:[a-f0-9]{64}", value.rsplit("@", 1)[1])
            }
            if len(immutable_candidates) != 1:
                raise ContractError("OCI_IMMUTABLE_IDENTITY_UNAVAILABLE")
            immutable_reference = next(iter(immutable_candidates))
            content_digest = immutable_reference.rsplit("@", 1)[1]
            immutable = _docker_inspect(docker, immutable_reference)
            if (
                immutable["Id"] != image_id
                or immutable_reference not in immutable["RepoDigests"]
            ):
                raise ContractError("OCI_IMMUTABLE_IDENTITY_MISMATCH")
            base_digests = _resolved_base_digests(docker, base_references)
            if base_digests != base_digests_before_build:
                raise ContractError("BASE_IMAGE_CHANGED_DURING_BUILD")
            docker_version, buildkit_version = _runtime_versions(docker)
            provenance_sha256 = _available_provenance_sha256(
                docker, immutable_reference
            )
            await _prepare_separate_verifier_environment(trial)
            return {
                "schema_version": TASK_IMAGE_SCHEMA,
                "task_name": task_name,
                "task_digest": task_digest,
                "immutable_reference": immutable_reference,
                "image_id": image_id,
                "content_digest": content_digest,
                "resolved_base_image_digests": base_digests,
                "dockerfile_sha256": dockerfile_sha256,
                "docker_version": docker_version,
                "buildkit_version": buildkit_version,
                "provenance_sha256": provenance_sha256,
            }
        finally:
            if started:
                await environment.stop(delete=True)


def _trial_lock_validator(record: dict[str, Any]):
    async def validate(event: TrialHookEvent) -> None:
        task = event.lock.task
        actual = {
            "digest": task.digest,
            "source_path": task.path.as_posix() if task.path else None,
            "commit": task.git_commit_id,
        }
        expected = {
            "digest": record["task_digest"],
            "source_path": record["source_path"],
            "commit": record.get("commit", TB_COMMIT),
        }
        if actual != expected:
            raise ContractError(
                f"Harbor trial lock differs from corpus manifest: {actual}"
            )

    return validate


async def run_request(request_path: Path) -> dict[str, Any]:
    request = _strict_request(request_path)
    run_root = _validated_run_root(request["run_root"])
    freeze_destination = freeze_relative = manifest_path = None
    replay_trajectory_destination = replay_trajectory_relative = None
    if request["attempt_kind"] == "source":
        freeze_destination, freeze_relative = _output_beneath(
            run_root, request["freeze_trajectory_to"]
        )
        manifest_path, _ = _output_beneath(run_root, request["freeze_manifest_path"])
    else:
        replay_trajectory_destination, replay_trajectory_relative = _output_beneath(
            run_root, request["replay_trajectory_path"]
        )
        manifest_path, _ = _output_beneath(run_root, request["freeze_manifest_path"])
    result_destination = None
    if request.get("result_path") is not None:
        result_destination, _ = _output_beneath(run_root, request["result_path"])
    project_dir = Path(__file__).resolve().parent
    runtime = verify_runtime(project_dir)
    manifest = load_and_verify_manifest(Path(request["corpus_manifest"]).resolve())
    task_name = request["task_name"]
    if not isinstance(task_name, str) or not re.fullmatch(
        r"terminal-bench/[a-z0-9][a-z0-9-]*", task_name
    ):
        raise ContractError("INVALID_TASK_NAME")
    manifest_by_name = {task["name"]: task for task in manifest["tasks"]}
    if task_name not in manifest_by_name:
        raise ContractError(f"task {task_name!r} is not in the pinned corpus manifest")
    task_selector = Path(manifest_by_name[task_name]["source_path"]).name
    job_fields = dict(request["job_config"])
    _validate_job_config_allowlist(
        job_fields, request.get("developer_instructions_sha256")
    )
    job_name = job_fields.get("job_name")
    if not isinstance(job_name, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_name
    ):
        raise ContractError("INVALID_JOB_NAME")
    job_dir, _ = _output_beneath(run_root, f"harbor-jobs/{job_name}")
    requested_outputs = [
        output
        for output in [
            freeze_destination,
            manifest_path,
            replay_trajectory_destination,
        ]
        if output is not None
    ]
    if result_destination is not None:
        requested_outputs.append(result_destination)
    if any(output.is_relative_to(job_dir) for output in requested_outputs):
        raise ContractError("OUTPUT_PATH_COLLIDES_WITH_JOB_DIR")
    dataset = DatasetConfig(
        repo=TB_REPO, path=Path("tasks"), task_names=[task_selector]
    )
    resolved_task_configs = await dataset.get_task_configs(disable_verification=False)
    task_client = TaskClient()
    task_ids = [task.get_task_id() for task in resolved_task_configs]
    resolved_downloads = dict(
        zip(
            task_ids,
            (
                await task_client.download_tasks(
                    task_ids=task_ids,
                    overwrite=any(task.overwrite for task in resolved_task_configs),
                    output_dir=next(
                        (
                            task.download_dir
                            for task in resolved_task_configs
                            if task.download_dir is not None
                        ),
                        None,
                    ),
                )
            ).results,
        )
    )
    resolved_task_path = _verify_resolved_tasks(
        resolved_task_configs, resolved_downloads, manifest, task_name
    )
    adapted_task_path, instruction_adaptation = _prepare_adapted_task(
        resolved_task_path, run_root, task_selector
    )
    adapted_task_digest = (
        f"sha256:{Packager.compute_content_hash(adapted_task_path)[0]}"
    )
    job_fields.update(
        {
            "jobs_dir": run_root / "harbor-jobs",
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "datasets": [],
            "tasks": [TaskConfig(path=adapted_task_path, source=TB_REPO)],
            "source_jobs": [],
        }
    )
    try:
        config = JobConfig.model_validate(job_fields)
    except Exception as error:
        raise ContractError("INVALID_JOB_CONFIG") from error
    if config.verifier.disable:
        raise ContractError("VERIFIER_REQUIRED")
    if not config.environment.delete:
        raise ContractError("ENVIRONMENT_DELETION_REQUIRED")
    if config.retry.max_retries != 0:
        raise ContractError("Harbor retries must remain disabled for scored attempts")
    job = await Job.create(config)
    if len(job) != 1:
        raise ContractError(
            f"Harbor job contains {len(job)} trials; expected exactly one"
        )
    docker = shutil.which("docker")
    if not docker:
        raise ContractError("DOCKER_NOT_FOUND")
    task_image = request["task_image"]
    inspected = _docker_inspect(docker, task_image)
    if task_image not in inspected["RepoDigests"]:
        raise ContractError("TASK_IMAGE_DIGEST_NOT_PRESENT")
    recorder = LifecycleRecorder(
        attempt_kind=request["attempt_kind"],
        manifest_path=manifest_path,
        freeze_destination=freeze_destination,
        freeze_relative_path=freeze_relative or replay_trajectory_relative,
        replay_trajectory_destination=replay_trajectory_destination,
    )
    job.on_trial_started(
        _trial_lock_validator(
            {
                "task_digest": adapted_task_digest,
                "source_path": str(adapted_task_path),
                "commit": None,
            }
        )
    )
    job.on_agent_started(recorder.on_agent_started)
    job.on_agent_ended(recorder.on_agent_ended)
    job.on_verification_started(recorder.on_verification_started)
    job.on_trial_ended(recorder.on_trial_ended)
    job.on_trial_cancelled(recorder.on_trial_cancelled)
    _guard_empty_harbor_progress_metrics(job)
    recorder.begin_run()
    try:
        with _pinned_task_image(task_image), _pinned_codex_binary(request):
            result = await job.run()
    except ContractError:
        raise
    except Exception as error:
        nested_contract_code = _nested_contract_code(error)
        if nested_contract_code is not None:
            raise ContractError(nested_contract_code) from error
        if recorder.verification_started_ns is not None:
            raise ContractError("HARBOR_POST_VERIFIER_FAILURE") from error
        if recorder.agent_started_ns is not None:
            raise ContractError("HARBOR_AGENT_PHASE_FAILURE") from error
        raise ContractError("HARBOR_PRE_AGENT_FAILURE") from error
    trial_results = []
    reward_contract = manifest_by_name[task_name]["reward_contract"]
    for trial in result.trial_results:
        exception_type = (
            trial.exception_info.exception_type
            if trial.exception_info is not None
            else None
        )
        validated_reward = (
            _validate_reward_values(trial.verifier_result.rewards, reward_contract)
            if trial.verifier_result is not None
            else None
        )
        outcome = _trial_outcome(
            validated_reward,
            exception_type,
            reward_contract["primary_field"],
        )
        trial_results.append(
            {
                "trial_id": str(trial.id),
                "task_name": trial.task_name,
                **outcome,
            }
        )
    output = {
        "schema_version": "koed-harbor-result-v1",
        "runtime": {
            **runtime,
            "task_instruction_adaptation": instruction_adaptation,
        },
        "job_lock_sha256": _sha256_file(job.job_dir / "lock.json"),
        "result": {
            "job_id": str(result.id),
            "n_total_trials": result.n_total_trials,
            "n_completed_trials": result.stats.n_completed_trials,
            "n_errored_trials": sum(
                1 for trial_result in trial_results if trial_result["errored"]
            ),
            "phase_timings": recorder.phase_timings(),
            "interactions": recorder.interactions(),
            "usage": {
                "input_tokens": result.stats.n_input_tokens,
                "cached_input_tokens": result.stats.n_cache_tokens,
                "output_tokens": result.stats.n_output_tokens,
                "cost_usd": result.stats.cost_usd,
            },
            "trials": trial_results,
        },
    }
    if request["attempt_kind"] == "source":
        assert manifest_path is not None
        output["freeze_manifest_sha256"] = _sha256_file(manifest_path)
    else:
        assert replay_trajectory_destination is not None
        assert manifest_path is not None
        if recorder.replay_trajectory_sha256 is None:
            raise ContractError(
                "replay attempt ended without a pre-verifier trajectory"
            )
        if (
            _sha256_file(replay_trajectory_destination)
            != recorder.replay_trajectory_sha256
        ):
            raise ContractError("REPLAY_TRAJECTORY_CHANGED_AFTER_CAPTURE")
        output["replay_trajectory_sha256"] = recorder.replay_trajectory_sha256
        output["freeze_manifest_sha256"] = _sha256_file(manifest_path)
    if result_destination is not None:
        _atomic_json(result_destination, output, no_overwrite=True)
    if request["attempt_kind"] == "source" and recorder.manifest is None:
        raise ContractError(
            "source attempt ended without a frozen pre-verifier trajectory"
        )
    return output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="run one locked Harbor trial")
    run.add_argument("--request", type=Path, required=True)
    manifest = subparsers.add_parser(
        "build-manifests", help="derive corpus fixtures from a pinned checkout"
    )
    manifest.add_argument("--source", type=Path, required=True)
    manifest.add_argument("--output-dir", type=Path, required=True)
    verify = subparsers.add_parser(
        "verify-manifest", help="validate a committed corpus manifest"
    )
    verify.add_argument("--manifest", type=Path, required=True)
    image = subparsers.add_parser(
        "provision-task-image",
        help="materialize one pinned task and publish an immutable OCI image",
    )
    image.add_argument("--manifest", type=Path, required=True)
    image.add_argument("--task-name", required=True)
    image.add_argument("--task-digest", required=True)
    image.add_argument("--registry", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "run":
            with _suppress_process_stdout():
                result = asyncio.run(run_request(args.request))
            print(json.dumps(result, sort_keys=True))
        elif args.command == "build-manifests":
            write_manifests(args.source, args.output_dir)
        elif args.command == "provision-task-image":
            docker = shutil.which("docker")
            if docker is None:
                raise ContractError("DOCKER_EXECUTABLE_UNAVAILABLE")
            print(
                json.dumps(
                    asyncio.run(
                        provision_task_image(
                            args.manifest,
                            args.task_name,
                            args.task_digest,
                            args.registry,
                            docker,
                        )
                    ),
                    sort_keys=True,
                )
            )
        else:
            load_and_verify_manifest(args.manifest)
            verify_runtime(Path(__file__).resolve().parent)
    except ContractError as error:
        code = str(error)
        if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", code):
            print(
                f"experience-replay Harbor contract error ({code})",
                file=sys.stderr,
            )
        else:
            print("experience-replay Harbor contract error", file=sys.stderr)
        return 2
    except (
        json.JSONDecodeError,
        OSError,
        subprocess.CalledProcessError,
    ):
        # Request content, paths, subprocess output, and nested Harbor models may
        # contain credentials. The CLI emits a stable non-sensitive failure only.
        print("experience-replay Harbor contract error", file=sys.stderr)
        return 2
    except Exception:
        print("experience-replay Harbor internal error", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

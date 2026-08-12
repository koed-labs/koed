#!/usr/bin/env python3
"""Locked, thin Harbor adapter and Terminal-Bench 3 corpus manifest tooling."""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import importlib.metadata
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from dirhash import dirhash
from harbor.job import Job
from harbor.models.job.config import DatasetConfig, JobConfig
from harbor.publisher.packager import Packager
from harbor.trial.hooks import TrialHookEvent

HARBOR_VERSION = "0.21.0"
HARBOR_COMMIT = "64afbbcb62165950301e1a6407c729aa26d844ff"
TB_VERSION = "v3.0.0"
TB_COMMIT = "2b0442c3c583b710ca8da14c8e601b99f2f1f244"
TB_REPO = f"harbor-framework/terminal-bench@{TB_COMMIT}"
TB_GIT_URL = "https://github.com/harbor-framework/terminal-bench.git"
CORPUS_TASK_COUNT = 74
MANIFEST_SCHEMA = "koed-terminal-bench-corpus-v1"
RUN_REQUEST_SCHEMA = "koed-harbor-run-v1"
FREEZE_MANIFEST_SCHEMA = "koed-harbor-freeze-v1"
MAX_TRAJECTORY_BYTES = 256 * 1024 * 1024
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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


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
            or not re.fullmatch(
                r"[A-Za-z][A-Za-z0-9_.-]{0,127}", metric_field
            )
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


def _load_reward_contracts(path: Path = REWARD_CONTRACTS_PATH) -> dict[str, dict[str, Any]]:
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


def _validate_reward_values(
    rewards: Any, contract: dict[str, Any]
) -> dict[str, Any]:
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


def _task_record(task_dir: Path) -> dict[str, Any]:
    config = tomllib.loads((task_dir / "task.toml").read_text())
    task = config.get("task", {})
    metadata = config.get("metadata", {})
    environment = config.get("environment", {})
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
        "resource_class": "gpu" if int(environment.get("gpus", 0)) > 0 else "cpu",
    }


def build_manifest(source: Path) -> dict[str, Any]:
    source = source.resolve()
    _verify_source_checkout(source)
    tasks_dir = source / "tasks"
    records = sorted(
        (_task_record(path) for path in tasks_dir.iterdir() if (path / "task.toml").is_file()),
        key=lambda record: record["name"],
    )
    if len(records) != CORPUS_TASK_COUNT:
        raise ContractError(f"resolved {len(records)} tasks; expected {CORPUS_TASK_COUNT}")
    names = [record["name"] for record in records]
    if len(names) != len(set(names)):
        raise ContractError("Terminal-Bench corpus contains duplicate task names")

    ranked = sorted(records, key=lambda record: (record["expert_time_seconds"], record["name"]))
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


def _subset_manifest(corpus: dict[str, Any], names: tuple[str, ...], profile: str) -> dict[str, Any]:
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
        "expert_time_quartile",
        "resource_class",
        "primary_reward",
        "reward_contract",
    )
    return {
        "schema_version": "koed-terminal-bench-subset-v1",
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
    _atomic_json(output_dir / "quick-12.json", _subset_manifest(corpus, QUICK_TASKS, "quick"))
    standard = QUICK_TASKS + STANDARD_EXTRA_TASKS
    _atomic_json(output_dir / "standard-24.json", _subset_manifest(corpus, standard, "standard"))


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
        raise ContractError("corpus manifest Terminal-Bench pin differs from the runner")
    dataset = terminal_bench.get("dataset", {})
    if dataset != {"kind": "implicit_git", "repo": TB_REPO, "path": "tasks"}:
        raise ContractError("corpus manifest does not use the pinned implicit Git dataset")
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
        if task.get("reward_contract") is not None and task["reward_contract"] != contract:
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
    return {"harbor_version": version, "harbor_commit": commit, "uv_lock_sha256": _sha256_file(lock_path)}


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
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary_path = Path(temporary)
    digest = hashlib.sha256()
    copied = 0
    try:
        with os.fdopen(source_fd, "rb") as src, os.fdopen(fd, "wb") as dst:
            while chunk := src.read(1024 * 1024):
                copied += len(chunk)
                if copied > MAX_TRAJECTORY_BYTES:
                    raise ContractError("source trajectory grew beyond the 256 MiB raw limit")
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        after = os.stat(source, follow_symlinks=False)
        identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
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
    manifest_path: Path
    freeze_destination: Path
    freeze_relative_path: str
    states: dict[str, str] = field(default_factory=dict)
    records: list[dict[str, Any]] = field(default_factory=list)
    manifest: dict[str, Any] | None = None

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
        self.states[key] = "agent-started"
        self._record(event, "agent_started")

    async def on_agent_ended(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if self.states.get(key) != "agent-started":
            raise ContractError("agent-ended event occurred before agent-started")
        self.states[key] = "agent-ended"
        self._record(event, "agent_ended")

    async def on_verification_started(self, event: TrialHookEvent) -> None:
        key = str(event.trial_id)
        if self.states.get(key) != "agent-ended":
            raise ContractError("verification-started event occurred before agent-ended")
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
        "task_name",
        "job_config",
        "corpus_manifest",
        "run_root",
        "freeze_manifest_path",
        "freeze_trajectory_to",
        "result_path",
    }
    unknown = set(request) - allowed
    if unknown:
        raise ContractError("UNKNOWN_RUN_REQUEST_KEY")
    required = allowed - {"result_path"}
    missing = required - set(request)
    if missing:
        raise ContractError("MISSING_RUN_REQUEST_KEY")
    if request["schema_version"] != RUN_REQUEST_SCHEMA:
        raise ContractError("unsupported run request schema")
    if not isinstance(request["job_config"], dict):
        raise ContractError("INVALID_JOB_CONFIG")
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


def _validate_job_config_allowlist(job_fields: dict[str, Any]) -> None:
    if set(job_fields) - SAFE_JOB_CONFIG_FIELDS:
        raise ContractError("DISALLOWED_JOB_CONFIG_FIELD")
    if "retry" in job_fields:
        _strict_nested_config(
            job_fields["retry"], SAFE_RETRY_CONFIG_FIELDS, "DISALLOWED_RETRY_CONFIG_FIELD"
        )
    if "environment" in job_fields:
        _strict_nested_config(
            job_fields["environment"],
            SAFE_ENVIRONMENT_CONFIG_FIELDS,
            "DISALLOWED_ENVIRONMENT_CONFIG_FIELD",
        )
    if "verifier" in job_fields:
        _strict_nested_config(
            job_fields["verifier"],
            SAFE_VERIFIER_CONFIG_FIELDS,
            "DISALLOWED_VERIFIER_CONFIG_FIELD",
        )
    if "agents" in job_fields:
        agents = job_fields["agents"]
        if not isinstance(agents, list):
            raise ContractError("INVALID_AGENTS_CONFIG")
        for agent in agents:
            _strict_nested_config(
                agent, SAFE_AGENT_CONFIG_FIELDS, "DISALLOWED_AGENT_CONFIG_FIELD"
            )


def _verify_resolved_tasks(job: Job, manifest: dict[str, Any], task_name: str) -> None:
    expected = {task["name"]: task for task in manifest["tasks"]}
    if task_name not in expected:
        raise ContractError(f"task {task_name!r} is not in the pinned corpus manifest")
    configs = job._task_configs  # Harbor has no public post-resolution task view in 0.21.
    downloads = job._task_download_results
    if len(configs) != 1:
        raise ContractError(f"Harbor resolved {len(configs)} tasks; a runner job must resolve one")
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
    }
    failed = {key: values for key, values in mismatches.items() if values[0] != values[1]}
    if failed:
        raise ContractError(f"resolved Harbor task differs from corpus manifest: {failed}")


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
            "commit": TB_COMMIT,
        }
        if actual != expected:
            raise ContractError(f"Harbor trial lock differs from corpus manifest: {actual}")

    return validate


async def run_request(request_path: Path) -> dict[str, Any]:
    request = _strict_request(request_path)
    run_root = _validated_run_root(request["run_root"])
    freeze_destination, freeze_relative = _output_beneath(
        run_root, request["freeze_trajectory_to"]
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
    _validate_job_config_allowlist(job_fields)
    job_name = job_fields.get("job_name")
    if not isinstance(job_name, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_name
    ):
        raise ContractError("INVALID_JOB_NAME")
    job_dir, _ = _output_beneath(run_root, f"harbor-jobs/{job_name}")
    requested_outputs = [freeze_destination, manifest_path]
    if result_destination is not None:
        requested_outputs.append(result_destination)
    if any(output.is_relative_to(job_dir) for output in requested_outputs):
        raise ContractError("OUTPUT_PATH_COLLIDES_WITH_JOB_DIR")
    job_fields.update(
        {
            "jobs_dir": run_root / "harbor-jobs",
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "datasets": [
                DatasetConfig(repo=TB_REPO, path=Path("tasks"), task_names=[task_selector])
            ],
            "tasks": [],
            "source_jobs": [],
        }
    )
    try:
        config = JobConfig.model_validate(job_fields)
    except Exception as error:
        raise ContractError("INVALID_JOB_CONFIG") from error
    if config.retry.max_retries != 0:
        raise ContractError("Harbor retries must remain disabled for scored attempts")
    job = await Job.create(config)
    if len(job) != 1:
        raise ContractError(f"Harbor job contains {len(job)} trials; expected exactly one")
    _verify_resolved_tasks(job, manifest, task_name)

    recorder = LifecycleRecorder(
        manifest_path=manifest_path,
        freeze_destination=freeze_destination,
        freeze_relative_path=freeze_relative,
    )
    job.on_trial_started(_trial_lock_validator(manifest_by_name[task_name]))
    job.on_agent_started(recorder.on_agent_started)
    job.on_agent_ended(recorder.on_agent_ended)
    job.on_verification_started(recorder.on_verification_started)
    result = await job.run()
    trial_results = []
    reward_contract = manifest_by_name[task_name]["reward_contract"]
    for trial in result.trial_results:
        validated_reward = _validate_reward_values(
            trial.verifier_result.rewards
            if trial.verifier_result is not None
            else None,
            reward_contract,
        )
        trial_results.append(
            {
                "trial_id": str(trial.id),
                "task_name": trial.task_name,
                "primary_reward": {
                    "field": validated_reward["primary_field"],
                    "value": validated_reward["primary_value"],
                    "passed": validated_reward["passed"],
                },
                "errored": trial.exception_info is not None,
            }
        )
    output = {
        "schema_version": "koed-harbor-result-v1",
        "runtime": runtime,
        "job_lock_sha256": _sha256_file(job.job_dir / "lock.json"),
        "freeze_manifest_sha256": _sha256_file(manifest_path),
        "result": {
            "job_id": str(result.id),
            "n_total_trials": result.n_total_trials,
            "n_completed_trials": result.stats.n_completed_trials,
            "n_errored_trials": result.stats.n_errored_trials,
            "trials": trial_results,
        },
    }
    if result_destination is not None:
        _atomic_json(result_destination, output, no_overwrite=True)
    if recorder.manifest is None:
        raise ContractError("source attempt ended without a frozen pre-verifier trajectory")
    return output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="run one locked Harbor trial")
    run.add_argument("--request", type=Path, required=True)
    manifest = subparsers.add_parser("build-manifests", help="derive corpus fixtures from a pinned checkout")
    manifest.add_argument("--source", type=Path, required=True)
    manifest.add_argument("--output-dir", type=Path, required=True)
    verify = subparsers.add_parser("verify-manifest", help="validate a committed corpus manifest")
    verify.add_argument("--manifest", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "run":
            print(json.dumps(asyncio.run(run_request(args.request)), sort_keys=True))
        elif args.command == "build-manifests":
            write_manifests(args.source, args.output_dir)
        else:
            load_and_verify_manifest(args.manifest)
            verify_runtime(Path(__file__).resolve().parent)
    except (ContractError, json.JSONDecodeError, OSError, subprocess.CalledProcessError):
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

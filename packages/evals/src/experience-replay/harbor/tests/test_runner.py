from __future__ import annotations

import hashlib
import asyncio
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

import runner


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def lifecycle_event(trial_dir: Path) -> SimpleNamespace:
    return SimpleNamespace(
        trial_id="trial-one",
        task_name="terminal-bench/cad-model",
        timestamp=datetime(2026, 8, 12, tzinfo=UTC),
        result=SimpleNamespace(trial_uri=trial_dir.as_uri()),
    )


def test_source_lifecycle_freezes_before_verification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    trial = tmp_path / "trial"
    trajectory = trial / "agent" / "trajectory.json"
    trajectory.parent.mkdir(parents=True)
    trajectory.write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.7",
                "steps": [
                    {
                        "step_id": 1,
                        "source": "agent",
                        "message": "done",
                        "extra": {"last_native_event_ordinal": 1},
                    }
                ],
            }
        )
    )
    notifications: list[str] = []
    monkeypatch.setattr(
        runner,
        "_notify_lifecycle",
        lambda _event, name, _kind: notifications.append(name),
    )
    recorder = runner.LifecycleRecorder(
        attempt_kind="source",
        manifest_path=tmp_path / "manifest.json",
        freeze_destination=tmp_path / "frozen.json",
        freeze_relative_path="source/frozen.json",
    )
    event = lifecycle_event(trial)
    async def exercise() -> None:
        await recorder.on_agent_started(event)
        await recorder.on_agent_ended(event)
        await recorder.on_verification_started(event)
        await recorder.on_trial_ended(event)

    asyncio.run(exercise())

    assert notifications == ["agent_started", "agent_ended", "trial_ended"]
    assert (tmp_path / "frozen.json").read_text() == trajectory.read_text()
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [entry["event"] for entry in manifest["lifecycle"]] == [
        "agent_started",
        "agent_ended",
        "trajectory_materialized",
        "verification_started",
    ]


def test_replay_lifecycle_never_freezes_trajectory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    notifications: list[str] = []
    monkeypatch.setattr(
        runner,
        "_notify_lifecycle",
        lambda _event, name, _kind: notifications.append(name),
    )
    recorder = runner.LifecycleRecorder(attempt_kind="replay")
    event = lifecycle_event(tmp_path)
    async def exercise() -> None:
        await recorder.on_agent_started(event)
        await recorder.on_agent_ended(event)
        await recorder.on_verification_started(event)
        await recorder.on_trial_ended(event)

    asyncio.run(exercise())

    assert notifications == ["agent_started", "agent_ended", "trial_ended"]
    assert recorder.manifest is None
    assert not list(tmp_path.glob("**/frozen*"))


def test_cancelled_agent_attempt_acknowledges_without_freezing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    notifications: list[str] = []
    monkeypatch.setattr(
        runner,
        "_notify_lifecycle",
        lambda _event, name, _kind: notifications.append(name),
    )
    recorder = runner.LifecycleRecorder(
        attempt_kind="source",
        manifest_path=tmp_path / "manifest.json",
        freeze_destination=tmp_path / "frozen.json",
        freeze_relative_path="source/frozen.json",
    )
    event = lifecycle_event(tmp_path)
    async def exercise() -> None:
        await recorder.on_agent_started(event)
        await recorder.on_trial_cancelled(event)

    asyncio.run(exercise())

    assert notifications == ["agent_started", "trial_cancelled"]
    assert not (tmp_path / "manifest.json").exists()
    assert not (tmp_path / "frozen.json").exists()


def test_committed_corpus_manifest_has_locked_pins_and_all_tasks() -> None:
    manifest = runner.load_and_verify_manifest(FIXTURES / "tb3-v3.0.0.json")

    assert manifest["task_count"] == 74
    assert manifest["terminal_bench"]["dataset"] == {
        "kind": "implicit_git",
        "repo": f"harbor-framework/terminal-bench@{runner.TB_COMMIT}",
        "path": "tasks",
    }
    assert all(task["harbor_task_checksum"].startswith("sha256:") for task in manifest["tasks"])
    assert all(task["task_digest"].startswith("sha256:") for task in manifest["tasks"])
    assert all("reward_contract" in task for task in manifest["tasks"])
    assert manifest["reward_contracts"]["sha256"] == runner._sha256_file(
        runner.REWARD_CONTRACTS_PATH
    )


def test_subset_manifests_are_exact_ordered_profiles() -> None:
    quick = json.loads((FIXTURES / "quick-12.json").read_text())
    standard = json.loads((FIXTURES / "standard-24.json").read_text())

    assert tuple(task["name"] for task in quick["tasks"]) == runner.QUICK_TASKS
    assert tuple(task["name"] for task in standard["tasks"]) == (
        runner.QUICK_TASKS + runner.STANDARD_EXTRA_TASKS
    )
    assert all(task["resource_class"] == "cpu" for task in standard["tasks"])


def test_freeze_file_is_durable_and_content_addressed(tmp_path: Path) -> None:
    source = tmp_path / "trajectory.json"
    destination = tmp_path / "frozen" / "trajectory.json"
    payload = b'{"schema_version":"ATIF-v1.7","steps":[]}\n'
    source.write_bytes(payload)

    frozen = runner._freeze_file(source, destination)

    assert destination.read_bytes() == payload
    assert frozen["relative_path"] == "trajectory.json"
    assert frozen["sha256"] == f"sha256:{hashlib.sha256(payload).hexdigest()}"
    assert frozen["size_bytes"] == len(payload)
    assert frozen["file_identity"]["device"] == destination.stat().st_dev
    assert frozen["file_identity"]["inode"] == destination.stat().st_ino


def test_freeze_file_rejects_symlink(tmp_path: Path) -> None:
    source = tmp_path / "trajectory.json"
    actual = tmp_path / "actual.json"
    actual.write_text("{}")
    source.symlink_to(actual)

    with pytest.raises(runner.ContractError, match="MISSING_OR_UNSAFE"):
        runner._freeze_file(source, tmp_path / "frozen.json")


def test_run_request_rejects_unknown_top_level_key(tmp_path: Path) -> None:
    request = {
        "schema_version": runner.RUN_REQUEST_SCHEMA,
        "task_name": "terminal-bench/cad-model",
        "job_config": {},
        "corpus_manifest": "manifest.json",
        "lifecycle_path": "lifecycle.json",
        "surprise": True,
    }
    path = tmp_path / "request.json"
    path.write_text(json.dumps(request))

    with pytest.raises(runner.ContractError, match="UNKNOWN_RUN_REQUEST_KEY"):
        runner._strict_request(path)


def test_freeze_file_never_overwrites_existing_artifact(tmp_path: Path) -> None:
    source = tmp_path / "trajectory.json"
    destination = tmp_path / "frozen.json"
    source.write_text('{"steps":[]}')
    destination.write_text("keep-me")

    with pytest.raises(runner.ContractError, match="OUTPUT_ALREADY_EXISTS"):
        runner._freeze_file(source, destination)

    assert destination.read_text() == "keep-me"


def test_output_paths_are_relative_confined_and_no_overwrite(tmp_path: Path) -> None:
    root = tmp_path / "run"
    root.mkdir()
    assert runner._validated_run_root(str(root)) == root.resolve()
    destination, relative = runner._output_beneath(root, "proof/freeze.json")
    assert destination == root / "proof" / "freeze.json"
    assert relative == "proof/freeze.json"

    for unsafe in ["/tmp/result.json", "../escape.json", "proof/../../escape"]:
        with pytest.raises(runner.ContractError, match="INVALID_OUTPUT_PATH"):
            runner._output_beneath(root, unsafe)

    existing = root / "existing.json"
    existing.write_text("do-not-overwrite")
    with pytest.raises(runner.ContractError, match="OUTPUT_ALREADY_EXISTS"):
        runner._output_beneath(root, "existing.json")


def test_native_step_identities_are_bound_and_all_or_none(tmp_path: Path) -> None:
    trajectory = tmp_path / "trajectory.json"
    trajectory.write_text(
        json.dumps(
            {
                "steps": [
                    {
                        "step_id": 1,
                        "source": "user",
                        "message": "x",
                        "extra": {"last_native_event_ordinal": 4},
                    },
                    {
                        "step_id": 2,
                        "source": "agent",
                        "message": "y",
                        "extra": {"last_native_event_ordinal": 9},
                    },
                ]
            }
        )
    )
    identities, cutoff = runner._step_identities(trajectory)
    assert cutoff == 9
    assert [item["last_native_event_ordinal"] for item in identities] == [4, 9]
    assert all(item["identity_sha256"].startswith("sha256:") for item in identities)

    broken = json.loads(trajectory.read_text())
    del broken["steps"][1]["extra"]["last_native_event_ordinal"]
    trajectory.write_text(json.dumps(broken))
    with pytest.raises(runner.ContractError, match="INCOMPLETE_NATIVE_EVENT_ORDINALS"):
        runner._step_identities(trajectory)


@pytest.mark.parametrize("field", ["upload", "share", "publish", "jobs_dir", "extra_instruction_paths"])
def test_job_config_allowlist_excludes_publish_and_path_surfaces(field: str) -> None:
    assert field not in runner.SAFE_JOB_CONFIG_FIELDS


@pytest.mark.parametrize(
    ("section", "value", "reason"),
    [
        ("agents", [{"name": "codex", "load_trajectory": "/tmp/raw.json"}], "AGENT"),
        ("environment", {"mounts": [{"source": "/", "target": "/host"}]}, "ENVIRONMENT"),
        ("verifier", {"import_path": "/tmp/verifier.py"}, "VERIFIER"),
    ],
)
def test_nested_job_config_rejects_arbitrary_path_surfaces(
    section: str, value: object, reason: str
) -> None:
    with pytest.raises(runner.ContractError, match=reason):
        runner._validate_job_config_allowlist({"job_name": "safe", section: value})


@pytest.mark.parametrize(
    "config",
    [
        {"environment": {"delete": False}},
        {"verifier": {"disable": True}},
    ],
)
def test_scored_run_cannot_keep_environment_or_disable_verifier(
    config: dict[str, object],
) -> None:
    with pytest.raises(
        runner.ContractError, match="ENVIRONMENT_DELETION_REQUIRED|VERIFIER_REQUIRED"
    ):
        runner._validate_job_config_allowlist({"job_name": "safe", **config})


def test_scored_run_pins_mandatory_cleanup_and_verification() -> None:
    config: dict[str, object] = {"job_name": "safe"}

    runner._validate_job_config_allowlist(config)

    assert config["environment"] == {"delete": True}
    assert config["verifier"] == {"disable": False}


@pytest.mark.parametrize(
    "config",
    [
        {"environment": {"env": {"HOME": "/host"}}},
        {"verifier": {"env": {"OPENAI_API_KEY": "secret"}}},
        {"agents": [{"name": "codex", "env": {"HOME": "/host"}}]},
        {
            "agents": [
                {
                    "name": "codex",
                    "extra_allowed_hosts": ["attacker.example"],
                }
            ]
        },
        {"environment": {"extra_allowed_hosts": ["169.254.169.254"]}},
        {
            "agents": [
                {
                    "name": "oracle",
                    "env": {"KOED_BENCHMARK_MCP_TOKEN": "token"},
                }
            ]
        },
    ],
)
def test_scored_run_rejects_arbitrary_env_and_network_egress(
    config: dict[str, object],
) -> None:
    with pytest.raises(runner.ContractError, match="ENV|HOST"):
        runner._validate_job_config_allowlist({"job_name": "safe", **config})


def test_codex_allows_only_modeled_provider_and_mcp_bridge_values() -> None:
    config = {
        "job_name": "safe",
        "environment": {
            "extra_allowed_hosts": ["host.docker.internal"],
        },
        "agents": [
            {
                "name": "codex",
                "env": {
                    "OPENAI_API_KEY": "${OPENAI_API_KEY}",
                    "KOED_BENCHMARK_MCP_TOKEN": "${KOED_BENCHMARK_MCP_TOKEN}",
                },
                "extra_allowed_hosts": [
                    "api.openai.com",
                    "host.docker.internal",
                ],
            }
        ],
    }

    runner._validate_job_config_allowlist(config)

    assert config["environment"]["delete"] is True
    assert config["verifier"]["disable"] is False
    assert (
        config["agents"][0]["env"]["KOED_BENCHMARK_MCP_TOKEN"]
        == "${KOED_BENCHMARK_MCP_TOKEN}"
    )


@pytest.mark.parametrize(
    "env",
    [
        {"OPENAI_API_KEY": "literal-or-wrong-provider-secret"},
        {"OPENAI_API_KEY": "${AWS_SECRET_ACCESS_KEY}"},
        {"KOED_BENCHMARK_MCP_TOKEN": "not-a-real-bridge-token"},
        {"KOED_BENCHMARK_MCP_TOKEN": "t" * 43},
    ],
)
def test_codex_rejects_unmodeled_credential_values(env: dict[str, str]) -> None:
    with pytest.raises(runner.ContractError, match="CREDENTIAL|MCP_TOKEN"):
        runner._validate_job_config_allowlist(
            {"job_name": "safe", "agents": [{"name": "codex", "env": env}]}
        )


def test_strict_request_does_not_echo_secret_unknown_keys(tmp_path: Path) -> None:
    secret = "x-api-key-sk-supersecretvalue"
    path = tmp_path / "request.json"
    path.write_text(json.dumps({secret: True}))
    with pytest.raises(runner.ContractError) as raised:
        runner._strict_request(path)
    assert secret not in str(raised.value)


def test_non_binary_multi_metric_reward_contract_is_evaluated_from_primary_field() -> None:
    contract = {
        "metrics": {
            "quality": {"minimum": -2.0, "maximum": 3.0},
            "latency_ms": {"minimum": 0.0, "maximum": 5000.0},
        },
        "primary_field": "quality",
        "success": {"operator": "greater_than_or_equal", "value": 1.25},
    }

    result = runner._validate_reward_values(
        {"quality": 1.5, "latency_ms": 230.0}, contract
    )

    assert result == {
        "values": {"quality": 1.5, "latency_ms": 230.0},
        "primary_field": "quality",
        "primary_value": 1.5,
        "passed": True,
    }


@pytest.mark.parametrize(
    ("rewards", "reason"),
    [
        ({"quality": 1.0}, "REWARD_FIELDS_MISMATCH"),
        (
            {"quality": 1.0, "latency_ms": 10.0, "surprise": 0.0},
            "REWARD_FIELDS_MISMATCH",
        ),
        ({"quality": math.nan, "latency_ms": 10.0}, "INVALID_REWARD_VALUE"),
        ({"quality": math.inf, "latency_ms": 10.0}, "INVALID_REWARD_VALUE"),
        ({"quality": 3.01, "latency_ms": 10.0}, "REWARD_OUT_OF_RANGE"),
    ],
)
def test_reward_validation_rejects_absent_extra_nonfinite_and_out_of_range(
    rewards: dict[str, float], reason: str
) -> None:
    contract = {
        "metrics": {
            "quality": {"minimum": -2.0, "maximum": 3.0},
            "latency_ms": {"minimum": 0.0, "maximum": 5000.0},
        },
        "primary_field": "quality",
        "success": {"operator": "greater_than", "value": 0.5},
    }
    with pytest.raises(runner.ContractError, match=reason):
        runner._validate_reward_values(rewards, contract)


def test_reward_contract_mapping_is_complete_and_keeps_graded_semantics() -> None:
    contracts = runner._load_reward_contracts()
    assert len(contracts) == runner.CORPUS_TASK_COUNT
    assert contracts["terminal-bench/kv-live-surgery"]["success"] == {
        "operator": "greater_than",
        "value": 0.0,
    }

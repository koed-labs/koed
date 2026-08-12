from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import pytest

import runner


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


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

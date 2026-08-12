const REQUIRED_STEPS = Object.freeze([
  "feed_validation",
  "no_automatic_download",
  "manual_check",
  "user_download",
  "restart_install",
  "relaunch_version",
  "shutdown_order",
  "data_preservation"
]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const assertHash = (value, label) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
};

const assertArtifact = (artifact, index) => {
  if (!isRecord(artifact))
    throw new Error(`artifacts[${index}] must be an object`);
  assertString(artifact.version, `artifacts[${index}].version`);
  assertString(artifact.path, `artifacts[${index}].path`);
  assertHash(artifact.sha256, `artifacts[${index}].sha256`);
  if (artifact.kind !== "n_minus_1" && artifact.kind !== "n") {
    throw new Error(`artifacts[${index}].kind must be n_minus_1 or n`);
  }
};

const assertInventory = (inventory, label) => {
  if (!Array.isArray(inventory)) throw new Error(`${label} must be an array`);
  for (const [index, entry] of inventory.entries()) {
    if (!isRecord(entry))
      throw new Error(`${label}[${index}] must be an object`);
    assertString(entry.path, `${label}[${index}].path`);
    assertHash(entry.sha256, `${label}[${index}].sha256`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`${label}[${index}].size must be a non-negative integer`);
    }
  }
};

export const REQUIRED_DESKTOP_UPDATE_EVIDENCE_STEPS = REQUIRED_STEPS;

export const validateDesktopUpdateEvidence = (manifest) => {
  if (!isRecord(manifest))
    throw new Error("Evidence manifest must be an object");
  assertString(manifest.task_id, "task_id");
  assertString(manifest.generated_at, "generated_at");
  if (manifest.evidence_mode !== "fresh_for_this_snapshot") {
    throw new Error("evidence_mode must be fresh_for_this_snapshot");
  }
  if (!isRecord(manifest.versions))
    throw new Error("versions must be an object");
  assertString(manifest.versions.n_minus_1, "versions.n_minus_1");
  assertString(manifest.versions.n, "versions.n");
  if (manifest.versions.n_minus_1 === manifest.versions.n) {
    throw new Error("N-1 and N versions must be distinct");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 2) {
    throw new Error("artifacts must contain N-1 and N outputs");
  }
  manifest.artifacts.forEach(assertArtifact);
  const artifactKinds = new Set(
    manifest.artifacts.map((artifact) => artifact.kind)
  );
  if (
    artifactKinds.size !== 2 ||
    !artifactKinds.has("n_minus_1") ||
    !artifactKinds.has("n")
  ) {
    throw new Error(
      "artifacts must contain exactly one n_minus_1 and one n output"
    );
  }
  const artifactVersions = new Set(
    manifest.artifacts.map((artifact) => artifact.version)
  );
  if (
    !artifactVersions.has(manifest.versions.n_minus_1) ||
    !artifactVersions.has(manifest.versions.n)
  ) {
    throw new Error(
      "artifact versions do not match versions.n_minus_1 and versions.n"
    );
  }
  if (
    !isRecord(manifest.feed_validation) ||
    manifest.feed_validation.ok !== true
  ) {
    throw new Error("feed_validation.ok must be true");
  }
  assertString(manifest.feed_validation.feed_url, "feed_validation.feed_url");
  if (!Array.isArray(manifest.steps)) throw new Error("steps must be an array");
  const seenSteps = new Set();
  for (const [index, step] of manifest.steps.entries()) {
    if (!isRecord(step)) throw new Error(`steps[${index}] must be an object`);
    assertString(step.name, `steps[${index}].name`);
    if (!REQUIRED_STEPS.includes(step.name))
      throw new Error(`Unknown evidence step ${step.name}`);
    if (seenSteps.has(step.name))
      throw new Error(`Duplicate evidence step ${step.name}`);
    seenSteps.add(step.name);
    if (step.ok !== true)
      throw new Error(`Evidence step ${step.name} did not pass`);
  }
  for (const required of REQUIRED_STEPS) {
    if (!seenSteps.has(required))
      throw new Error(`Missing required evidence step ${required}`);
  }
  if (!Array.isArray(manifest.action_timeline)) {
    throw new Error("action_timeline must be an array");
  }
  const actions = new Set(
    manifest.action_timeline.map((entry) => entry?.action)
  );
  for (const action of [
    "launch_n_minus_1",
    "automatic_check_window",
    "manual_check",
    "user_download",
    "download_ready",
    "restart_install",
    "relaunch"
  ]) {
    if (!actions.has(action))
      throw new Error(`Missing action timeline entry ${action}`);
  }
  const launch = manifest.action_timeline.find(
    (entry) => entry.action === "launch_n_minus_1"
  );
  if (launch.version !== manifest.versions.n_minus_1) {
    throw new Error("launch_n_minus_1 version must equal versions.n_minus_1");
  }
  const relaunchAction = manifest.action_timeline.find(
    (entry) => entry.action === "relaunch"
  );
  if (relaunchAction.version !== manifest.versions.n) {
    throw new Error("relaunch action version must equal versions.n");
  }
  assertInventory(manifest.before_inventory, "before_inventory");
  assertInventory(manifest.after_inventory, "after_inventory");
  if (
    !isRecord(manifest.shutdown) ||
    manifest.shutdown.updater_driven !== true
  ) {
    throw new Error("shutdown.updater_driven must be true");
  }
  if (
    manifest.shutdown.app_process_exited !== true ||
    manifest.shutdown.service_pids_stopped !== true
  ) {
    throw new Error("shutdown must prove app exit and service PID shutdown");
  }
  if (
    !isRecord(manifest.shutdown.service_pids_before_install) ||
    Object.keys(manifest.shutdown.service_pids_before_install).length === 0
  ) {
    throw new Error(
      "shutdown.service_pids_before_install must contain owned service PIDs"
    );
  }
  if (
    !isRecord(manifest.data_preservation) ||
    manifest.data_preservation.ok !== true
  ) {
    throw new Error("data_preservation.ok must be true");
  }
  for (const [index, query] of manifest.data_preservation.queries.entries()) {
    if (
      !isRecord(query) ||
      !/^2\d\d$/.test(String(query.status)) ||
      query.sentinelPresent !== true
    ) {
      throw new Error(
        `data_preservation.queries[${index}] must prove a successful sentinel query`
      );
    }
  }
  if (!isRecord(manifest.data_preservation.sentinels)) {
    throw new Error(
      "data_preservation.sentinels must contain byte/hash sentinels"
    );
  }
  for (const name of ["config", "api_token_reference", "model", "data"]) {
    assertHash(
      manifest.data_preservation.sentinels[name],
      `data_preservation.sentinels.${name}`
    );
  }
  if (
    !Array.isArray(manifest.data_preservation.queries) ||
    manifest.data_preservation.queries.length < 1
  ) {
    throw new Error(
      "data_preservation.queries must contain a real runtime query"
    );
  }
  assertString(
    manifest.relaunch?.reported_version,
    "relaunch.reported_version"
  );
  if (manifest.relaunch.reported_version !== manifest.versions.n) {
    throw new Error("relaunch.reported_version must equal versions.n");
  }
  return { ok: true, requiredSteps: [...REQUIRED_STEPS] };
};

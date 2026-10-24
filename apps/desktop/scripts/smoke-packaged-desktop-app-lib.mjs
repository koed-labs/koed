import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  setTimeout as setTimer,
  clearTimeout as clearTimer
} from "node:timers";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// Authenticated lifecycle selection rejects symlink ancestors (including /var and /tmp on macOS).
export const createSmokeHome = (prefix, root = tmpdir()) =>
  realpathSync(mkdtempSync(resolve(root, prefix)));

export const withSmokeFailureDiagnostics = async (work, preserve) => {
  try {
    return await work();
  } catch (error) {
    let diagnostics;
    try {
      diagnostics = preserve();
    } catch (diagnosticError) {
      diagnostics = `Could not preserve smoke diagnostics: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n${diagnostics}`,
      { cause: error }
    );
  }
};

const confirmedLocalDoctorRateLimit = (json) => {
  const checks = json?.checks;
  if (!Array.isArray(checks)) return false;
  if (
    checks.find((check) => check.id === "apiToken")?.details?.httpStatus !== 429
  )
    return false;
  if (
    checks.some((check) => {
      if (["apiToken", "mcpServer"].includes(check.id)) return false;
      // These diagnostics depend on the same throttled capability-read request.
      if (
        check.id?.startsWith("aiClientFlow:") &&
        /^AI Client instance ".+" is unavailable for .+\.$/.test(
          check.message ?? ""
        )
      )
        return false;
      return ![
        "healthy",
        "not_configured",
        "not_required",
        "disabled"
      ].includes(check.state);
    })
  )
    return false;
  const stderr = checks.find((check) => check.id === "mcpServer")?.details
    ?.stderr;
  try {
    return (
      JSON.parse(stderr).error ===
      "Local Koed API request limit reached. Retry later."
    );
  } catch {
    return false;
  }
};

const doctorFailure = (result) =>
  `doctor --json failed with ${result.status}: ${result.stderr || result.stdout}`;

const runBeforeDeadline = async (run, deadline, now) => {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Smoke doctor deadline expired");
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimer(
          () => reject(new Error("Smoke doctor deadline expired")),
          remaining
        );
      })
    ]);
    if (now() >= deadline) throw new Error("Smoke doctor deadline expired");
    return result;
  } finally {
    clearTimer(timer);
  }
};

export const runSmokeDoctor = async ({
  run,
  isAlive,
  now = Date.now,
  wait = delay,
  timeoutMs = 180_000
}) => {
  const deadline = now() + timeoutMs;
  const first = await runBeforeDeadline(run, deadline, now);
  if (first.status === 0 && first.json.ok === true) return first;
  if (!confirmedLocalDoctorRateLimit(first.json))
    throw new Error(doctorFailure(first));
  // Doctor omits Retry-After. Local control quota uses a fixed 60-second window.
  const cooldownMs = 61_000;
  const assertRetryAllowed = () => {
    if (!isAlive() || now() >= deadline)
      throw new Error(
        `${doctorFailure(first)}; supervisor stopped or doctor retry deadline expired`
      );
  };
  assertRetryAllowed();
  if (now() + cooldownMs >= deadline)
    throw new Error(
      `${doctorFailure(first)}; insufficient doctor retry deadline`
    );
  await runBeforeDeadline(() => wait(cooldownMs), deadline, now);
  assertRetryAllowed();
  try {
    const final = await runBeforeDeadline(run, deadline, now);
    assertRetryAllowed();
    if (final.status === 0 && final.json.ok === true) return final;
    throw new Error(doctorFailure(final));
  } catch (error) {
    throw new Error(
      `${doctorFailure(first)}; retry failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

export const PACKAGED_NATIVE_ASSET_DIRECTORIES = ["postgres", "llama.cpp"];

export const smokeExecutionPlan = ({ missingAssets }) => ({
  collaborationBroker: !missingAssets,
  rendererFaults: !missingAssets,
  missingAssets: Boolean(missingAssets),
  healthyDaemon: !missingAssets
});

export const removeSmokeHome = (koedHome, remove = rmSync) =>
  remove(koedHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });

export const withPackagedNativeAssetsMasked = async ({ runtimeRoot, work }) => {
  const entries = PACKAGED_NATIVE_ASSET_DIRECTORIES.map((entry) => ({
    entry,
    source: resolve(runtimeRoot, entry)
  })).filter(({ source }) => existsSync(source));
  if (entries.length === 0) {
    return work({ maskedEntries: [] });
  }

  const stagingRoot = resolve(
    runtimeRoot,
    `.koed-smoke-masked-native-assets-${randomUUID()}`
  );
  mkdirSync(stagingRoot, { recursive: false });
  const moved = [];
  try {
    for (const item of entries) {
      const target = resolve(stagingRoot, item.entry);
      renameSync(item.source, target);
      moved.push({ ...item, target });
    }
  } catch (error) {
    for (const item of moved.toReversed()) {
      if (!existsSync(item.source) && existsSync(item.target)) {
        renameSync(item.target, item.source);
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  let result;
  let workError;
  const restoreErrors = [];
  try {
    result = await work({ maskedEntries: moved.map(({ entry }) => entry) });
  } catch (error) {
    workError = error;
  } finally {
    for (const item of moved.toReversed()) {
      if (existsSync(item.source)) {
        restoreErrors.push(
          new Error(
            `Cannot restore masked packaged native assets because ${item.source} already exists. Backup remains at ${item.target}.`
          )
        );
        continue;
      }
      try {
        renameSync(item.target, item.source);
      } catch (error) {
        restoreErrors.push(error);
      }
    }
    if (restoreErrors.length === 0) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  if (restoreErrors.length > 0) {
    throw new AggregateError(
      workError ? [workError, ...restoreErrors] : restoreErrors,
      `Failed to restore packaged native assets from ${stagingRoot}.`
    );
  }
  if (workError) throw workError;
  return result;
};

import {
  removeCodexIntegration,
  repairCodexIntegration,
  setupCodex,
  setupCore
} from "./setup.js";
import { removePi, setupPi } from "./pi-setup.js";
import { removeClaude, setupClaude } from "./claude-setup.js";
import {
  collectKoedServerDoctor,
  collectKoedServerStartupStatus,
  collectKoedServerStatus
} from "./status.js";
import { restartKoedServer } from "./restart.js";
import { startKoedServer } from "./start.js";
import { stopKoedServer } from "./stop.js";
import { resolveKoedServerPaths } from "./paths.js";
import { invalidateUpstreamEnrollmentReferences } from "./upstream-enrollment.js";
import {
  inspectDeviceIdentityStatus,
  rotateDeviceIdentity
} from "./device-identity.js";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { startKoedServerDaemon } from "./daemon-start.js";

export const createCliServiceContext = ({
  collectStatus = collectKoedServerStatus,
  collectStartupStatus = collectKoedServerStartupStatus,
  collectDoctor = collectKoedServerDoctor,
  inspectDeviceIdentity = inspectDeviceIdentityStatus,
  rotateDeviceIdentity: rotateIdentity = rotateDeviceIdentity,
  invalidateUpstreamEnrollmentReferences:
    invalidateEnrollmentReferences = invalidateUpstreamEnrollmentReferences,
  start = startKoedServer,
  startDaemon = startKoedServerDaemon,
  stop = stopKoedServer,
  restart = restartKoedServer,
  setupCore: setupCoreIntegration = setupCore,
  setupCodex: setup = setupCodex,
  setupClaude: setupClaudeIntegration = setupClaude,
  setupPi: setupPiIntegration = setupPi,
  removeClaude: removeClaudeIntegration = removeClaude,
  removePi: removePiIntegration = removePi,
  removeCodex: removeCodexIntegrationFn = removeCodexIntegration,
  repairCodex = repairCodexIntegration,
  resolvePaths = resolveKoedServerPaths,
  stdout = process.stdout,
  stderr = process.stderr,
  desktopRuntimeCapability,
  supervisorInvocation
}: KoedServerCliDependencies = {}) => {
  if (desktopRuntimeCapability) {
    // Desktop authority selects the Desktop-owned generation for the same
    // shared lifecycle and setup functions used by standalone installations.
    const authority = { desktopRuntimeCapability };
    const [
      status,
      startupStatus,
      doctor,
      foreground,
      restartServer,
      stopServer
    ] = [
      collectStatus,
      collectStartupStatus,
      collectDoctor,
      start,
      restart,
      stop
    ];
    const [core, codex, claude, pi, codexRepair] = [
      setupCoreIntegration,
      setup,
      setupClaudeIntegration,
      setupPiIntegration,
      repairCodex
    ];
    const daemon = startDaemon;
    collectStatus = (environment, dependencies, options) =>
      status(environment, { ...dependencies, ...authority }, options);
    collectStartupStatus = (environment, dependencies) =>
      startupStatus(environment, { ...dependencies, ...authority });
    collectDoctor = (environment, dependencies) =>
      doctor(environment, { ...dependencies, ...authority });
    start = (options) => foreground({ ...options, ...authority });
    stop = (options = {}) => stopServer({ ...options, ...authority });
    restart = (options) =>
      restartServer({ ...options, ...authority, ...supervisorStart() });
    startDaemon = (options) => daemon({ ...options, ...supervisorStart() });
    setupCoreIntegration = (options) => core({ ...options, ...authority });
    setup = (options) => codex({ ...options, ...authority });
    repairCodex = (options) => codexRepair({ ...options, ...authority });
    setupClaudeIntegration = (environment, spawnSync, options) =>
      claude(environment, spawnSync, { ...options, ...authority });
    setupPiIntegration = (environment, spawnSync, options) =>
      pi(environment, spawnSync, { ...options, ...authority });
  }
  function supervisorStart() {
    if (!supervisorInvocation)
      throw new Error("Verified Desktop supervisor command is unavailable.");
    return supervisorInvocation;
  }

  return {
    collectStatus,
    collectStartupStatus,
    collectDoctor,
    inspectDeviceIdentity,
    rotateIdentity,
    invalidateEnrollmentReferences,
    start,
    startDaemon,
    stop,
    restart,
    setupCoreIntegration,
    setup,
    setupClaudeIntegration,
    setupPiIntegration,
    removeClaudeIntegration,
    removePiIntegration,
    removeCodexIntegrationFn,
    repairCodex,
    resolvePaths,
    stdout,
    stderr,
    desktopRuntimeCapability
  };
};

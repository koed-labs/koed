import type { deviceRequestCommand } from "./personal-device-request.js";
// Shared invocation contract. These imports are erased from the emitted JavaScript.
import type { loadRepoEnv } from "./env-file.js";
import type {
  removeCodexIntegration,
  repairCodexIntegration,
  setupCodex,
  setupCore
} from "./setup.js";
import type { removePi, setupPi } from "./pi-setup.js";
import type { removeClaude, setupClaude } from "./claude-setup.js";
import type {
  collectKoedServerDoctor,
  collectKoedServerStartupStatus,
  collectKoedServerStatus
} from "./status.js";
import type { restartKoedServer } from "./restart.js";
import type { startKoedServer } from "./start.js";
import type { stopKoedServer } from "./stop.js";
import type {
  collectLocalModelStatus,
  installLocalModel
} from "./local-models-runtime.js";
import type {
  collectPrivacyModelStatus,
  installPrivacyModel
} from "./privacy-model-runtime.js";
import type {
  collectHomebrewRuntimeStatus,
  installHomebrewRuntime
} from "./runtime-homebrew.js";
import type {
  collectPackagedRuntimeStatus,
  installPackagedRuntime
} from "./runtime-packaged.js";
import type {
  activateServerPackage,
  cleanupServerPackages,
  collectServerPackageStatus,
  installServerPackage
} from "./package-runtime.js";
import type { resolveKoedServerPaths } from "./paths.js";
import type {
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  removeUpstreamBackend,
  setActiveUpstreamBackend,
  updateUpstreamBackendRoutePolicy
} from "./upstream-registry.js";
import type {
  getProjectTeamWorkspaceLink,
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks,
  removeProjectTeamWorkspaceLink
} from "./project-team-workspace-links.js";
import type {
  discoverProjectMetadata,
  forgetProjectMetadata,
  getProjectMetadataForCwd,
  listProjectMetadata
} from "./project-metadata.js";
import type {
  cancelUpstreamEnrollment,
  disconnectUpstreamBackendEnrollment,
  getUpstreamEnrollmentStatus,
  invalidateUpstreamEnrollmentReferences,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";
import type {
  inspectDeviceIdentityStatus,
  rotateDeviceIdentity
} from "./device-identity.js";
import type { runPersonalSyncCommand } from "./personal-sync.js";
import type { runRemoteMcpCommand } from "./remote-mcp-client.js";
import type { DesktopRuntimeCapability } from "./desktop-runtime-capability.js";
import type { startKoedServerDaemon } from "./daemon-start.js";

export interface KoedServerCliDependencies {
  deviceRequest?: typeof deviceRequestCommand;
  runRemoteMcp?: typeof runRemoteMcpCommand;
  /** Environment forwarded by the retained remote diagnostic entrypoint. */
  remoteEnvironment?: NodeJS.ProcessEnv;
  collectStatus?: typeof collectKoedServerStatus;
  collectStartupStatus?: typeof collectKoedServerStartupStatus;
  collectDoctor?: typeof collectKoedServerDoctor;
  inspectDeviceIdentity?: typeof inspectDeviceIdentityStatus;
  rotateDeviceIdentity?: typeof rotateDeviceIdentity;
  invalidateUpstreamEnrollmentReferences?: typeof invalidateUpstreamEnrollmentReferences;
  start?: typeof startKoedServer;
  startDaemon?: typeof startKoedServerDaemon;
  stop?: typeof stopKoedServer;
  restart?: typeof restartKoedServer;
  setupCore?: typeof setupCore;
  setupCodex?: typeof setupCodex;
  setupClaude?: typeof setupClaude;
  setupPi?: typeof setupPi;
  removeClaude?: typeof removeClaude;
  removePi?: typeof removePi;
  removeCodex?: typeof removeCodexIntegration;
  repairCodex?: typeof repairCodexIntegration;
  collectModelStatus?: typeof collectLocalModelStatus;
  installModel?: typeof installLocalModel;
  collectPrivacyModelStatus?: typeof collectPrivacyModelStatus;
  installPrivacyModel?: typeof installPrivacyModel;
  collectRuntimeStatus?: typeof collectHomebrewRuntimeStatus;
  installRuntime?: typeof installHomebrewRuntime;
  collectPackagedRuntimeStatus?: typeof collectPackagedRuntimeStatus;
  installPackagedRuntime?: typeof installPackagedRuntime;
  collectPackageStatus?: typeof collectServerPackageStatus;
  installPackage?: typeof installServerPackage;
  activatePackage?: typeof activateServerPackage;
  cleanupPackages?: typeof cleanupServerPackages;
  listUpstreams?: typeof listUpstreamBackends;
  registerUpstream?: typeof registerUpstreamBackend;
  refreshUpstream?: typeof refreshUpstreamBackendCapabilities;
  updateUpstreamPolicy?: typeof updateUpstreamBackendRoutePolicy;
  activateUpstream?: typeof setActiveUpstreamBackend;
  removeUpstream?: typeof removeUpstreamBackend;
  startUpstreamEnroll?: typeof startUpstreamEnrollment;
  getUpstreamEnrollStatus?: typeof getUpstreamEnrollmentStatus;
  cancelUpstreamEnroll?: typeof cancelUpstreamEnrollment;
  disconnectUpstream?: typeof disconnectUpstreamBackendEnrollment;
  linkProjectTeamWorkspace?: typeof linkProjectTeamWorkspace;
  listProjectTeamWorkspaceLinks?: typeof listProjectTeamWorkspaceLinks;
  getProjectTeamWorkspaceLink?: typeof getProjectTeamWorkspaceLink;
  removeProjectTeamWorkspaceLink?: typeof removeProjectTeamWorkspaceLink;
  discoverProjectMetadata?: typeof discoverProjectMetadata;
  listProjectMetadata?: typeof listProjectMetadata;
  getProjectMetadataForCwd?: typeof getProjectMetadataForCwd;
  forgetProjectMetadata?: typeof forgetProjectMetadata;
  runPersonalSync?: typeof runPersonalSyncCommand;
  loadEnvironment?: typeof loadRepoEnv;
  resolvePaths?: typeof resolveKoedServerPaths;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Issued only by the verified packaged Desktop CLI entrypoint. */
  desktopRuntimeCapability?: DesktopRuntimeCapability;
  /** Verified supervisor command for detached starts; never taken from argv. */
  supervisorInvocation?: { startCommand: string; cwd: string };
}

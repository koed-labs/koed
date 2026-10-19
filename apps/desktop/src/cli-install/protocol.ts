export const cliInstallCommandChannel = "koed:cli-install:command";
export const cliInstallProgressChannel = "koed:cli-install:progress";

export interface PrivacyInstallStatus {
  available: boolean;
  state: "not_installed" | "ready" | "installing" | "failed" | "unavailable";
  message: string;
}

export interface PrivacyInstallProgress {
  requestId: string;
  completedBytes: number | null;
  message: string;
  stage: string;
  totalBytes: number | null;
}

export interface PrivacyOfflineSource {
  archivePath: string;
  manifestPath: string;
  signaturePath: string;
}

export interface PrivacyInstallBridge {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(options: {
    consent: true;
    offlineSource?: PrivacyOfflineSource;
    onProgress(progress: PrivacyInstallProgress): void;
  }): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<PrivacyOfflineSource | null>;
}

export interface CliInstallManager {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(
    consent: boolean,
    offlineSource?: PrivacyOfflineSource
  ): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<PrivacyOfflineSource | null>;
}

export type CliInstallCommand =
  | { operation: "status" }
  | {
      operation: "install";
      consent: boolean;
      offlineSource?: PrivacyOfflineSource;
    }
  | { operation: "cancel" }
  | { operation: "select-offline" }
  | { operation: "launcher-inspect" }
  | { operation: "launcher-install"; consent: boolean; destination?: string }
  | { operation: "launcher-remove" }
  | {
      operation: "path-update";
      operationKind: "add" | "remove";
      consent: boolean;
    };

export interface CliInstallProgressEnvelope {
  requestId: string;
  completedBytes: number | null;
  message: string;
  stage: string;
  totalBytes: number | null;
}

export interface CliInstallApi {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(
    consent: boolean,
    offlineSource?: PrivacyOfflineSource
  ): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<PrivacyOfflineSource | null>;
  launcher(
    operation: "inspect" | "install" | "remove",
    options?: { consent?: boolean; destination?: string }
  ): Promise<LauncherStatus>;
  updatePath(operation: "add" | "remove", consent: boolean): Promise<void>;
  subscribe(
    listener: (progress: CliInstallProgressEnvelope) => void
  ): () => void;
}

import type { LauncherStatus } from "./launcher.js";

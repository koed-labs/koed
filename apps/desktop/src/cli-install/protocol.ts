export const cliInstallCommandChannel = "koed:cli-install:command";
export const cliInstallProgressChannel = "koed:cli-install:progress";

export interface PrivacyInstallStatus {
  available: boolean;
  state: "not_installed" | "ready" | "installing" | "failed" | "unavailable";
  message: string;
}

export interface PrivacyInstallProgress {
  completedBytes: number | null;
  message: string;
  stage: string;
  totalBytes: number | null;
}

export interface PrivacyInstallBridge {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(options: {
    consent: true;
    offlinePath?: string;
    onProgress(progress: PrivacyInstallProgress): void;
  }): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<string | null>;
}

export interface CliInstallManager {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(
    consent: boolean,
    offlinePath?: string
  ): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<string | null>;
}

export type CliInstallCommand =
  | { operation: "status" }
  | { operation: "install"; consent: boolean; offlinePath?: string }
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
  completedBytes: number | null;
  message: string;
  stage: string;
  totalBytes: number | null;
}

export interface CliInstallApi {
  getStatus(): Promise<PrivacyInstallStatus>;
  installPrivacy(
    consent: boolean,
    offlinePath?: string
  ): Promise<PrivacyInstallStatus>;
  cancel(): Promise<void>;
  selectOffline(): Promise<string | null>;
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

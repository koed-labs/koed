export interface PiPackageFileSystem {
  copy(source: string, target: string): void;
  exists(target: string): boolean;
  mkdir(target: string): unknown;
  rename(source: string, target: string): void;
  remove(target: string): void;
}

export interface PiPackageTransactionResult {
  ok: boolean;
  hadPrevious: boolean;
  installResult?: unknown;
  error?: string;
  registrationError?: string;
  registrationResult?: unknown;
  restorationError?: string;
  backupPath?: string;
}

export const piPackageFileSystem: PiPackageFileSystem;

export function installPiPackageTransaction(input: {
  source: string;
  target: string;
  install(target: string): unknown;
  installSucceeded(result: unknown): boolean;
  fileSystem?: PiPackageFileSystem;
  suffix?: string;
}): PiPackageTransactionResult;

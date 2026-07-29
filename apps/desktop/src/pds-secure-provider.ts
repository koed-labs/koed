import { safeStorage } from "electron";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface PdsDesktopSecretStore {
  readonly providerKind?: "native_os" | "windows_dpapi_wsl";
  get(reference: string): Promise<string | null>;
  put(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

/**
 * Warms the small, fixed PDS secret set once during trusted main-process
 * bootstrap. Child API/Worker reads then avoid repeatedly crossing an OS
 * keychain boundary, while writes and deletes remain durable-first.
 */
export const createCachedPdsDesktopSecretStore = async (
  store: PdsDesktopSecretStore,
  references: string[]
): Promise<PdsDesktopSecretStore> => {
  const cache = new Map<string, string | null>();
  for (const reference of references) {
    if (!validReference(reference)) {
      throw new Error("Invalid PDS secret reference.");
    }
    cache.set(reference, await store.get(reference));
  }
  return {
    providerKind: store.providerKind,
    async get(reference) {
      if (!validReference(reference)) return null;
      if (cache.has(reference)) return cache.get(reference) ?? null;
      const value = await store.get(reference);
      cache.set(reference, value);
      return value;
    },
    async put(reference, value) {
      await store.put(reference, value);
      cache.set(reference, value);
    },
    async delete(reference) {
      await store.delete(reference);
      cache.set(reference, null);
    }
  };
};

type SafeStorage = Pick<
  typeof safeStorage,
  "decryptString" | "encryptString" | "isEncryptionAvailable"
> & {
  getSelectedStorageBackend?: () => string;
  encryptStringAsync?: (value: string) => Promise<Buffer>;
  decryptStringAsync?: (
    value: Buffer
  ) => Promise<{ result: string; shouldReEncrypt: boolean }>;
};

const maxSecretBytes = 2_000_000;
const validReference = (value: string): boolean =>
  /^[A-Za-z0-9._-]{1,240}$/.test(value);

const isSafeSecretStore = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
};

const isSafeSecretDirectory = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
};

const secureStorageAvailable = (storage: SafeStorage): boolean => {
  if (!storage.isEncryptionAvailable()) return false;
  const backend = storage.getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
};

const readEncrypted = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  if (!isSafeSecretStore(path)) throw new Error("Unsafe PDS secret store.");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid PDS secret store.");
  }
  const entries = Object.entries(parsed);
  if (
    entries.length > 1_024 ||
    entries.some(
      ([reference, value]) =>
        !validReference(reference) ||
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > maxSecretBytes * 2
    )
  ) {
    throw new Error("Invalid PDS secret store.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

const writeEncrypted = (path: string, values: Record<string, string>): void => {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isSafeSecretDirectory(directory)) {
    throw new Error("Unsafe PDS secret directory.");
  }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(values)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup only.
    }
    throw error;
  }
};

const isWsl = (): boolean => {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
};

interface WslWindowsHost {
  cscPath: string;
  cscWindowsDirectory: string;
  localAppData: string;
}

const windowsPathToWsl = (path: string): string | null => {
  const match = /^([A-Za-z]):\\(.*)$/.exec(path.trim());
  if (!match) return null;
  const [, drive, remainder] = match;
  if (!drive || remainder === undefined) return null;
  return resolve(
    "/mnt",
    drive.toLowerCase(),
    ...remainder.split("\\").filter(Boolean)
  );
};

const linuxPathToWindows = (path: string): string | null => {
  const match = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(resolve(path));
  if (!match) return null;
  const [, drive, remainder] = match;
  return drive && remainder !== undefined
    ? `${drive.toUpperCase()}:\\${remainder.replaceAll("/", "\\")}`
    : null;
};

const resolveWslWindowsHost = (): WslWindowsHost | null => {
  if (!isWsl()) return null;
  try {
    for (const mount of readdirSync("/mnt")) {
      const windowsRoot = resolve("/mnt", mount, "Windows");
      const frameworkDirectory = resolve(
        windowsRoot,
        "Microsoft.NET/Framework64/v4.0.30319"
      );
      const cscPath = resolve(frameworkDirectory, "csc.exe");
      const commandPath = resolve(windowsRoot, "System32/cmd.exe");
      if (!existsSync(cscPath) || !existsSync(commandPath)) continue;
      const localAppDataResult = spawnSync(
        commandPath,
        ["/d", "/s", "/c", "echo %LOCALAPPDATA%"],
        {
          cwd: "/tmp",
          encoding: "utf8",
          timeout: 2_000,
          windowsHide: true
        }
      );
      const localAppDataWindows = localAppDataResult.stdout?.trim();
      const localAppData = localAppDataWindows
        ? windowsPathToWsl(localAppDataWindows)
        : null;
      const cscWindowsDirectory = linuxPathToWindows(frameworkDirectory);
      if (
        localAppDataResult.status === 0 &&
        localAppData &&
        cscWindowsDirectory
      ) {
        return {
          cscPath,
          cscWindowsDirectory,
          localAppData
        };
      }
    }
  } catch {
    // A missing /mnt mount means Windows host interop is unavailable.
  }
  return null;
};

const wslDpapiHelperSource = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class KoedDpapiHelper
{
    private const int MaxSecretBytes = 2097152;
    private const int MaxStoreChars = 4194304;

    private static bool ValidReference(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 240) return false;
        foreach (char character in value)
        {
            if (!(Char.IsLetterOrDigit(character) || character == '.' || character == '_' || character == '-'))
                return false;
        }
        return true;
    }

    private static Dictionary<string, string> ReadStore(string path, JavaScriptSerializer serializer)
    {
        if (!File.Exists(path)) return new Dictionary<string, string>();
        var info = new FileInfo(path);
        if (info.Length > MaxStoreChars) throw new InvalidDataException("store too large");
        var values = serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path, Encoding.UTF8));
        if (values == null || values.Count > 1024) throw new InvalidDataException("invalid store");
        foreach (var entry in values)
        {
            if (!ValidReference(entry.Key) || entry.Value == null || entry.Value.Length > MaxStoreChars)
                throw new InvalidDataException("invalid store");
        }
        return values;
    }

    private static void WriteStore(string path, Dictionary<string, string> values, JavaScriptSerializer serializer)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var bytes = new UTF8Encoding(false).GetBytes(serializer.Serialize(values));
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        if (File.Exists(path)) File.Replace(temporary, path, null, true);
        else File.Move(temporary, path);
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !ValidReference(args[1])) return 2;
            var operation = args[0];
            if (operation != "get" && operation != "put" && operation != "delete") return 2;
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Koed");
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, "pds-secrets.json");
            var sid = WindowsIdentity.GetCurrent().User.Value;
            using (var mutex = new Mutex(false, @"Local\KoedPdsSecrets-" + sid))
            {
                if (!mutex.WaitOne(TimeSpan.FromSeconds(10))) return 4;
                try
                {
                    var serializer = new JavaScriptSerializer { MaxJsonLength = MaxStoreChars };
                    var values = ReadStore(path, serializer);
                    if (operation == "get")
                    {
                        string encrypted;
                        if (!values.TryGetValue(args[1], out encrypted)) return 3;
                        var cipher = Convert.FromBase64String(encrypted);
                        var plain = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser);
                        if (plain.Length > MaxSecretBytes) return 2;
                        Console.Out.Write(Convert.ToBase64String(plain));
                        return 0;
                    }
                    if (operation == "put")
                    {
                        using (var input = new MemoryStream())
                        {
                            Console.OpenStandardInput().CopyTo(input);
                            if (input.Length > MaxSecretBytes) return 2;
                            values[args[1]] = Convert.ToBase64String(
                                ProtectedData.Protect(input.ToArray(), null, DataProtectionScope.CurrentUser)
                            );
                        }
                    }
                    else values.Remove(args[1]);
                    WriteStore(path, values, serializer);
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch { return 1; }
    }
}
`;

const ensureWslDpapiHelper = (
  host: WslWindowsHost
): { executable: string } | null => {
  const sourceHash = createHash("sha256")
    .update(wslDpapiHelperSource)
    .digest("hex")
    .slice(0, 16);
  const helperDirectory = resolve(host.localAppData, "Koed", "bin");
  mkdirSync(helperDirectory, { recursive: true });
  const sourcePath = resolve(
    helperDirectory,
    `koed-dpapi-helper-${sourceHash}.cs`
  );
  const executable = resolve(
    helperDirectory,
    `koed-dpapi-helper-${sourceHash}.exe`
  );
  if (!existsSync(executable)) {
    writeFileSync(sourcePath, wslDpapiHelperSource, {
      encoding: "utf8",
      mode: 0o600
    });
    const sourceWindowsPath = linuxPathToWindows(sourcePath);
    const executableWindowsPath = linuxPathToWindows(executable);
    if (!sourceWindowsPath || !executableWindowsPath) return null;
    const compilation = spawnSync(
      host.cscPath,
      [
        "/nologo",
        "/target:exe",
        "/optimize+",
        `/r:${host.cscWindowsDirectory}\\System.Security.dll`,
        `/r:${host.cscWindowsDirectory}\\System.Web.Extensions.dll`,
        `/out:${executableWindowsPath}`,
        sourceWindowsPath
      ],
      {
        cwd: "/tmp",
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true
      }
    );
    if (compilation.status !== 0 || !existsSync(executable)) return null;
  }
  return { executable };
};

const runWslDpapiHelper = (
  executable: string,
  operation: "get" | "put" | "delete",
  reference: string,
  value?: string
): { ok: boolean; value?: string | null } => {
  const result = spawnSync(executable, [operation, reference], {
    cwd: "/tmp",
    encoding: "buffer",
    input: value === undefined ? undefined : Buffer.from(value, "utf8"),
    maxBuffer: maxSecretBytes + 1024,
    timeout: 12_000,
    windowsHide: true
  });
  if (operation === "get" && result.status === 3) {
    return { ok: true, value: null };
  }
  if (result.status !== 0) return { ok: false };
  if (operation !== "get") return { ok: true };
  try {
    const plain = Buffer.from(result.stdout.toString("ascii"), "base64");
    return plain.byteLength <= maxSecretBytes
      ? { ok: true, value: plain.toString("utf8") }
      : { ok: false };
  } catch {
    return { ok: false };
  }
};

const createWslDpapiStore = (
  profilePath: string
): PdsDesktopSecretStore | null => {
  const host = resolveWslWindowsHost();
  if (!host) return null;
  const helper = ensureWslDpapiHelper(host);
  if (!helper) return null;
  const namespace = createHash("sha256")
    .update(resolve(profilePath))
    .digest("base64url")
    .slice(0, 22);
  const namespacedReference = (reference: string): string =>
    `${namespace}.${reference}`;
  const request = (
    operation: "get" | "put" | "delete",
    reference: string,
    value?: string
  ) =>
    runWslDpapiHelper(
      helper.executable,
      operation,
      namespacedReference(reference),
      value
    );
  return {
    providerKind: "windows_dpapi_wsl",
    async get(reference) {
      if (!validReference(reference)) return null;
      const response = request("get", reference);
      if (response?.ok !== true) {
        throw new Error("Windows DPAPI secret storage failed.");
      }
      if (
        response.value !== null &&
        (typeof response.value !== "string" ||
          Buffer.byteLength(response.value, "utf8") > maxSecretBytes)
      ) {
        throw new Error("Windows DPAPI secret storage failed.");
      }
      return response.value as string | null;
    },
    async put(reference, value) {
      if (
        !validReference(reference) ||
        Buffer.byteLength(value, "utf8") > maxSecretBytes
      ) {
        throw new Error("Invalid PDS secret.");
      }
      if (request("put", reference, value)?.ok !== true) {
        throw new Error("Windows DPAPI secret storage failed.");
      }
    },
    async delete(reference) {
      if (!validReference(reference))
        throw new Error("Invalid PDS secret reference.");
      if (request("delete", reference)?.ok !== true) {
        throw new Error("Windows DPAPI secret storage failed.");
      }
    }
  };
};

/**
 * Main-process-only store. Electron safeStorage maps to Keychain on macOS,
 * DPAPI on Windows, and a configured Secret Service/KWallet backend on Linux.
 * The insecure Linux basic_text backend is never accepted.
 */
export const createPdsDesktopSecretStore = (input: {
  userDataPath: string;
  storage?: SafeStorage;
}): PdsDesktopSecretStore | null => {
  const storage: SafeStorage = input.storage ?? (safeStorage as SafeStorage);
  if (!secureStorageAvailable(storage)) {
    return input.storage ? null : createWslDpapiStore(input.userDataPath);
  }
  const storePath = resolve(input.userDataPath, "pds-secrets.json");
  let serialOperation = Promise.resolve();
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = serialOperation.then(operation, operation);
    serialOperation = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  };
  return {
    providerKind: "native_os",
    async get(reference) {
      if (!validReference(reference)) return null;
      return await serial(async () => {
        try {
          const value = readEncrypted(storePath)[reference];
          if (!value) return null;
          const encrypted = Buffer.from(value, "base64url");
          const asyncResult = storage.decryptStringAsync
            ? await storage.decryptStringAsync(encrypted)
            : null;
          const decrypted =
            asyncResult?.result ?? storage.decryptString(encrypted);
          if (asyncResult?.shouldReEncrypt) {
            const values = readEncrypted(storePath);
            values[reference] = (
              storage.encryptStringAsync
                ? await storage.encryptStringAsync(decrypted)
                : storage.encryptString(decrypted)
            ).toString("base64url");
            writeEncrypted(storePath, values);
          }
          return Buffer.byteLength(decrypted, "utf8") <= maxSecretBytes
            ? decrypted
            : null;
        } catch {
          return null;
        }
      });
    },
    async put(reference, value) {
      if (
        !validReference(reference) ||
        Buffer.byteLength(value, "utf8") > maxSecretBytes
      ) {
        throw new Error("Invalid PDS secret.");
      }
      await serial(async () => {
        const values = readEncrypted(storePath);
        values[reference] = (
          storage.encryptStringAsync
            ? await storage.encryptStringAsync(value)
            : storage.encryptString(value)
        ).toString("base64url");
        writeEncrypted(storePath, values);
      });
    },
    async delete(reference) {
      if (!validReference(reference))
        throw new Error("Invalid PDS secret reference.");
      await serial(async () => {
        const values = readEncrypted(storePath);
        if (!(reference in values)) return;
        delete values[reference];
        writeEncrypted(storePath, values);
      });
    }
  };
};

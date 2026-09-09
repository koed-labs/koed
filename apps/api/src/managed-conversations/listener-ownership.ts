import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maximumProcesses = 2_048;
const socketLinkPattern = /^socket:\[(\d+)]$/;

type ProcessPair = { pid: number; parentPid: number };

const descendants = (rootPid: number, pairs: ProcessPair[]): Set<number> => {
  const byParent = new Map<number, number[]>();
  for (const pair of pairs) {
    const children = byParent.get(pair.parentPid) ?? [];
    children.push(pair.pid);
    byParent.set(pair.parentPid, children);
  }
  const result = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0 && result.size < maximumProcesses) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...(byParent.get(current) ?? []));
  }
  return result;
};

export const parseUnixProcessPairs = (value: string): ProcessPair[] =>
  value
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]) }));

const linuxLoopbackHex = new Set([
  "0100007F",
  "00000000000000000000000001000000",
  "0000000000000000FFFF00000100007F"
]);

export const parseLinuxLoopbackListenerInodes = (
  value: string,
  port: number
): Set<string> => {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const line of value.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [address, encodedPort] = (fields[1] ?? "").split(":");
    if (
      encodedPort?.toUpperCase() === expectedPort &&
      address &&
      linuxLoopbackHex.has(address.toUpperCase()) &&
      /^\d+$/.test(fields[9] ?? "")
    ) {
      inodes.add(fields[9]!);
    }
  }
  return inodes;
};

export const parseLsofLoopbackListenerPids = (
  value: string,
  port: number
): Set<number> => {
  const result = new Set<number>();
  let currentPid: number | null = null;
  for (const line of value.split("\n")) {
    if (/^p\d+$/.test(line)) {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith("n") || currentPid === null) continue;
    const address = line.slice(1).replace(/\s+\(LISTEN\)$/, "");
    if (
      address === `127.0.0.1:${port}` ||
      address === `[::1]:${port}` ||
      address === `localhost:${port}`
    ) {
      result.add(currentPid);
    }
  }
  return result;
};

export const parseWindowsLoopbackListenerPids = (
  value: string,
  port: number
): Set<number> => {
  const result = new Set<number>();
  for (const line of value.split("\n")) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const local = match[1]!;
    const separator = local.lastIndexOf(":");
    const host = local.slice(0, separator).replace(/^\[|]$/g, "");
    const localPort = Number(local.slice(separator + 1));
    if (localPort === port && (host === "127.0.0.1" || host === "::1")) {
      result.add(Number(match[2]));
    }
  }
  return result;
};

const verifyLinux = async (rootPid: number, port: number): Promise<boolean> => {
  const pending = [rootPid];
  const pids = new Set<number>();
  while (pending.length > 0 && pids.size < maximumProcesses) {
    const pid = pending.pop()!;
    if (pids.has(pid)) continue;
    pids.add(pid);
    const children = await readFile(
      `/proc/${pid}/task/${pid}/children`,
      "utf8"
    ).catch(() => "");
    for (const child of children.trim().split(/\s+/)) {
      if (/^\d+$/.test(child)) pending.push(Number(child));
    }
  }
  const [tcp, tcp6] = await Promise.all([
    readFile("/proc/net/tcp", "utf8").catch(() => ""),
    readFile("/proc/net/tcp6", "utf8").catch(() => "")
  ]);
  const listening = new Set([
    ...parseLinuxLoopbackListenerInodes(tcp, port),
    ...parseLinuxLoopbackListenerInodes(tcp6, port)
  ]);
  if (listening.size === 0) return false;
  for (const pid of pids) {
    const fdPath = `/proc/${pid}/fd`;
    const fds = await readdir(fdPath).catch(() => []);
    for (const fd of fds.slice(0, 8_192)) {
      const target = await readlink(`${fdPath}/${fd}`).catch(() => "");
      const inode = socketLinkPattern.exec(target)?.[1];
      if (inode && listening.has(inode)) return true;
    }
  }
  return false;
};

const unixProcessPairs = async (): Promise<ProcessPair[]> => {
  const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 3_000
  });
  return parseUnixProcessPairs(stdout);
};

const verifyDarwin = async (
  rootPid: number,
  port: number
): Promise<boolean> => {
  const [pairs, lsof] = await Promise.all([
    unixProcessPairs(),
    execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 3_000 }
    ).catch(() => ({ stdout: "" }))
  ]);
  const allowed = descendants(rootPid, pairs);
  return [...parseLsofLoopbackListenerPids(lsof.stdout, port)].some((pid) =>
    allowed.has(pid)
  );
};

const verifyWindows = async (
  rootPid: number,
  port: number
): Promise<boolean> => {
  const [netstat, processes] = await Promise.all([
    execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3_000,
      windowsHide: true
    }),
    execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5_000,
        windowsHide: true
      }
    )
  ]);
  const pairs = processes.stdout
    .split("\n")
    .map((line) => /^"?(\d+)"?,"?(\d+)"?\s*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]) }));
  const allowed = descendants(rootPid, pairs);
  return [...parseWindowsLoopbackListenerPids(netstat.stdout, port)].some(
    (pid) => allowed.has(pid)
  );
};

export const verifyLoopbackListenerOwnership = async (input: {
  rootPid: number;
  port: number;
  platform?: NodeJS.Platform;
}): Promise<boolean> => {
  if (!Number.isSafeInteger(input.rootPid) || input.rootPid < 1) return false;
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  )
    return false;
  const platform = input.platform ?? hostPlatform();
  if (platform === "linux") return verifyLinux(input.rootPid, input.port);
  if (platform === "darwin") return verifyDarwin(input.rootPid, input.port);
  if (platform === "win32") return verifyWindows(input.rootPid, input.port);
  return false;
};

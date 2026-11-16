import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import { resolveProcessIdentity } from "../supervisor-lock.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import {
  publishControlDiscovery,
  reconcileStaleControlDiscovery,
  readControlDiscovery,
  removeControlDiscovery
} from "./discovery.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
function fixture() {
  const root = realpathSync(
    mkdtempSync(resolve(tmpdir(), "koed-control-discovery-"))
  );
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  const admission = acquireControlPlaneAdmission(paths)!;
  const record = {
    schemaVersion: 1 as const,
    home: root,
    instanceId: admission.instanceId,
    installationId: "install",
    productVersion: "1.0.0",
    socketPath: resolve(root, "socket"),
    pid: process.pid,
    processIdentity: resolveProcessIdentity(process.pid)!
  };
  return {
    paths,
    admission,
    record,
    path: resolve(paths.runDir, "control-plane.json")
  };
}
describe("control-plane discovery", () => {
  it("publishes private metadata and removes only its own instance", () => {
    const f = fixture();
    try {
      publishControlDiscovery(f.paths, f.admission, f.record);
      expect(readControlDiscovery(f.paths)).toEqual(f.record);
      expect(() =>
        removeControlDiscovery(f.paths, f.admission, "other")
      ).toThrow();
      expect(existsSync(f.path)).toBe(true);
      removeControlDiscovery(f.paths, f.admission, f.record.instanceId);
      expect(readControlDiscovery(f.paths)).toBeUndefined();
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("refuses existing or symlinked discovery rather than replacing it", () => {
    const f = fixture();
    try {
      const outside = resolve(f.record.home, "outside");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, f.path);
      expect(() =>
        publishControlDiscovery(f.paths, f.admission, f.record)
      ).toThrow();
      expect(() => readControlDiscovery(f.paths)).toThrow();
      expect(existsSync(outside)).toBe(true);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("rejects a FIFO discovery file without waiting for a writer", () => {
    const f = fixture();
    try {
      execFileSync("/usr/bin/mkfifo", [f.path]);
      expect(() => readControlDiscovery(f.paths)).toThrow();
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("refuses to replace discovery while the recorded process is alive", () => {
    const f = fixture();
    try {
      publishControlDiscovery(f.paths, f.admission, f.record);
      expect(() =>
        publishControlDiscovery(f.paths, f.admission, f.record)
      ).toThrow(/may still be running/);
      expect(readControlDiscovery(f.paths)).toEqual(f.record);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("replaces metadata of a definitively exited process without touching its socket", () => {
    const f = fixture();
    try {
      writeFileSync(
        f.path,
        JSON.stringify({ ...f.record, pid: 99999999, instanceId: "previous" }),
        { mode: 0o600 }
      );
      publishControlDiscovery(f.paths, f.admission, f.record);
      expect(readControlDiscovery(f.paths)).toEqual(f.record);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("removes dead routing metadata without removing its old socket", () => {
    const f = fixture();
    try {
      const socket = resolve(f.paths.runDir, "control.sock");
      execFileSync("python3", [
        "-c",
        "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
        socket
      ]);
      writeFileSync(
        f.path,
        JSON.stringify({
          ...f.record,
          socketPath: socket,
          pid: 99999999,
          instanceId: "previous"
        }),
        { mode: 0o600 }
      );
      reconcileStaleControlDiscovery(f.paths, f.admission, socket);
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(f.path)).toBe(false);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("removes dead discovery when the old socket is already absent", () => {
    const f = fixture();
    try {
      const socket = resolve(f.paths.runDir, "control.sock");
      writeFileSync(
        f.path,
        JSON.stringify({
          ...f.record,
          socketPath: socket,
          pid: 99999999,
          instanceId: "previous"
        }),
        { mode: 0o600 }
      );
      reconcileStaleControlDiscovery(f.paths, f.admission, socket);
      expect(existsSync(f.path)).toBe(false);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("preserves discovery when its recorded owner is alive", () => {
    const f = fixture();
    try {
      const socket = resolve(f.paths.runDir, "control.sock");
      writeFileSync(
        f.path,
        JSON.stringify({ ...f.record, socketPath: socket }),
        { mode: 0o600 }
      );
      expect(() =>
        reconcileStaleControlDiscovery(f.paths, f.admission, socket)
      ).toThrow("may still be running");
      expect(existsSync(f.path)).toBe(true);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("leaves a non-socket artifact alone when replacing dead metadata", () => {
    const f = fixture();
    try {
      const socket = resolve(f.paths.runDir, "control.sock");
      writeFileSync(socket, "keep");
      writeFileSync(
        f.path,
        JSON.stringify({
          ...f.record,
          socketPath: socket,
          pid: 99999999,
          instanceId: "previous"
        }),
        { mode: 0o600 }
      );
      reconcileStaleControlDiscovery(f.paths, f.admission, socket);
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(f.path)).toBe(false);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });
  it("cannot remove another instance's discovery even if its ID is supplied", () => {
    const f = fixture();
    try {
      writeFileSync(
        f.path,
        JSON.stringify({ ...f.record, instanceId: "previous" }),
        { mode: 0o600 }
      );
      expect(() =>
        removeControlDiscovery(f.paths, f.admission, "previous")
      ).toThrow();
      expect(existsSync(f.path)).toBe(true);
    } finally {
      releaseControlPlaneAdmission(f.admission);
    }
  });

  it("rejects metadata for a different home and a released admission", () => {
    const f = fixture();
    expect(() =>
      publishControlDiscovery(f.paths, f.admission, {
        ...f.record,
        home: "/other"
      })
    ).toThrow();
    expect(() =>
      publishControlDiscovery(f.paths, f.admission, {
        ...f.record,
        instanceId: "wrong"
      })
    ).toThrow();
    expect(() =>
      publishControlDiscovery(f.paths, f.admission, {
        ...f.record,
        processIdentity: "wrong"
      })
    ).toThrow();
    releaseControlPlaneAdmission(f.admission);
    expect(() =>
      publishControlDiscovery(f.paths, f.admission, f.record)
    ).toThrow();
  });
});

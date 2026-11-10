import { accessSync, constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNvidiaSmi } from "./nvidia-smi.js";

const { files } = vi.hoisted(() => ({
  files: new Map<string, "file" | "directory" | "denied">()
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  statSync: vi.fn((path: string) => {
    if (!files.has(path)) throw new Error("ENOENT");
    return { isFile: () => files.get(path) !== "directory" };
  }),
  accessSync: vi.fn((path: string) => {
    if (files.get(path) === "denied") throw new Error("EACCES");
  })
}));

describe("NVIDIA tool discovery", () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
  });

  it.each([
    "/usr/bin/nvidia-smi",
    "/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
    "/usr/local/nvidia/bin/nvidia-smi",
    "/usr/lib/wsl/lib/nvidia-smi"
  ])("finds an executable at %s without a shell PATH", (path) => {
    files.set(path, "file");
    expect(resolveNvidiaSmi()).toBe(path);
    expect(accessSync).toHaveBeenCalledWith(path, constants.X_OK);
  });

  it.each(["directory", "denied"] as const)(
    "skips a native %s and finds the executable supplied by WSL",
    (kind) => {
      files.set("/usr/bin/nvidia-smi", kind);
      files.set("/usr/lib/wsl/lib/nvidia-smi", "file");
      expect(resolveNvidiaSmi()).toBe("/usr/lib/wsl/lib/nvidia-smi");
    }
  );

  it("prefers the native executable when both locations exist", () => {
    files.set("/usr/bin/nvidia-smi", "file");
    files.set("/usr/lib/wsl/lib/nvidia-smi", "file");
    expect(resolveNvidiaSmi()).toBe("/usr/bin/nvidia-smi");
  });

  it("reports missing tools rather than returning a bare command", () => {
    expect(resolveNvidiaSmi()).toBeNull();
    expect(accessSync).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import { allocateAndPersistLocalPorts } from "./ports.js";

const roots: string[] = [];

const createPaths = (name: string) => {
  const root = mkdtempSync(resolve(tmpdir(), `koed-ports-${name}-`));
  roots.push(root);
  return resolveKoedServerPaths({ KOED_HOME: resolve(root, "home") });
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("allocateAndPersistLocalPorts", () => {
  it("leases distinct port sets to concurrently active local homes", async () => {
    const registryPath = resolve(
      mkdtempSync(resolve(tmpdir(), "koed-port-registry-")),
      "leases.json"
    );
    roots.push(resolve(registryPath, ".."));
    const activePids = new Set([101, 202]);
    const dependencies = {
      canListen: async () => true,
      isProcessRunning: (pid: number) => activePids.has(pid),
      leaseRegistryPath: registryPath
    };

    const [first, second] = await Promise.all([
      allocateAndPersistLocalPorts(
        createPaths("first"),
        { KOED_AUTO_PORTS: "1" },
        { ...dependencies, processId: 101 }
      ),
      allocateAndPersistLocalPorts(
        createPaths("second"),
        { KOED_AUTO_PORTS: "1" },
        { ...dependencies, processId: 202 }
      )
    ]);

    expect(first.API_HOST_PORT).not.toBe(second.API_HOST_PORT);
    expect(first.POSTGRES_HOST_PORT).not.toBe(second.POSTGRES_HOST_PORT);
    expect(first.EMBEDDING_SERVICE_HOST_PORT).not.toBe(
      second.EMBEDDING_SERVICE_HOST_PORT
    );
  });

  it("treats generated environment ports as preferences in automatic mode", async () => {
    const registryPath = resolve(
      mkdtempSync(resolve(tmpdir(), "koed-port-registry-")),
      "leases.json"
    );
    roots.push(resolve(registryPath, ".."));
    const activePids = new Set([101, 202]);
    const dependencies = {
      canListen: async () => true,
      isProcessRunning: (pid: number) => activePids.has(pid),
      leaseRegistryPath: registryPath
    };
    const generatedEnvironment = {
      KOED_AUTO_PORTS: "1",
      API_HOST_PORT: "3300",
      POSTGRES_HOST_PORT: "15432",
      EMBEDDING_SERVICE_HOST_PORT: "3800",
      EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT: "18080",
      EMBEDDING_LLAMA_RERANKER_SERVER_PORT: "18081"
    };

    const first = await allocateAndPersistLocalPorts(
      createPaths("generated-first"),
      generatedEnvironment,
      { ...dependencies, processId: 101 }
    );
    const second = await allocateAndPersistLocalPorts(
      createPaths("generated-second"),
      generatedEnvironment,
      { ...dependencies, processId: 202 }
    );

    expect(first.API_HOST_PORT).toBe("3300");
    expect(second.API_HOST_PORT).toBe("3301");
    expect(first.POSTGRES_HOST_PORT).toBe("15432");
    expect(second.POSTGRES_HOST_PORT).toBe("15433");
    expect(first.EMBEDDING_SERVICE_HOST_PORT).toBe("3800");
    expect(second.EMBEDDING_SERVICE_HOST_PORT).toBe("3801");
    expect(first.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT).toBe("18080");
    expect(second.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT).toBe("18082");
    expect(first.EMBEDDING_LLAMA_RERANKER_SERVER_PORT).toBe("18081");
    expect(second.EMBEDDING_LLAMA_RERANKER_SERVER_PORT).toBe("18083");
  });
});

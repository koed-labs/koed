import assert from "node:assert/strict";
import test from "node:test";
import {
  assertElectronVersionMatchesLock,
  componentRuntimeDeclarations,
  validatedElectronRuntime
} from "./koed-component-runtime-policy.mjs";

test("requires installed Electron to match pnpm-lock.yaml", () => {
  assertElectronVersionMatchesLock({
    lockVersion: "45.2.3",
    installedVersion: "45.2.3"
  });
  assert.throws(
    () =>
      assertElectronVersionMatchesLock({
        lockVersion: "45.2.4",
        installedVersion: "45.2.3"
      }),
    /does not match pnpm-lock.yaml/
  );
});

test("declares N-API Node 24–26 and exact validated Electron runtimes", () => {
  assert.deepEqual(
    componentRuntimeDeclarations({
      nodeModulesAbi: "137",
      electronIdentity: validatedElectronRuntime
    }),
    [
      {
        kind: "node",
        runtimeRange: ">=24 <27",
        nodeRange: ">=24 <27",
        minimumNapi: 10
      },
      {
        kind: "electron",
        runtimeRange: "=45.2.3",
        nodeRange: "=24.22.2",
        modulesAbi: "150",
        minimumNapi: 10
      }
    ]
  );
});

test("keeps Electron 45 compatibility closed when its measured identity changes", () => {
  for (const changed of [
    { ...validatedElectronRuntime, version: "45.2.4" },
    { ...validatedElectronRuntime, nodeVersion: "24.22.3" },
    { ...validatedElectronRuntime, modulesAbi: "151" },
    { ...validatedElectronRuntime, napiVersion: 11 }
  ]) {
    assert.throws(
      () =>
        componentRuntimeDeclarations({
          nodeModulesAbi: "137",
          electronIdentity: changed
        }),
      /Electron compatibility is not validated/
    );
  }
});

test("does not add Electron claims to targets without a measured Electron runtime", () => {
  assert.deepEqual(componentRuntimeDeclarations({ nodeModulesAbi: "137" }), [
    {
      kind: "node",
      runtimeRange: ">=24 <27",
      nodeRange: ">=24 <27",
      minimumNapi: 10
    }
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertElectronVersionMatchesLock,
  componentRuntimeDeclarations,
  validatedElectronRuntime
} from "./koed-component-runtime-policy.mjs";

test("requires installed Electron to match pnpm-lock.yaml", () => {
  assertElectronVersionMatchesLock({
    lockVersion: "39.8.10",
    installedVersion: "39.8.10"
  });
  assert.throws(
    () =>
      assertElectronVersionMatchesLock({
        lockVersion: "39.8.11",
        installedVersion: "39.8.10"
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
        runtimeRange: "=39.8.10",
        nodeRange: "=22.22.1",
        modulesAbi: "140",
        minimumNapi: 10
      }
    ]
  );
});

test("keeps Electron 39 compatibility closed when its measured identity changes", () => {
  for (const changed of [
    { ...validatedElectronRuntime, version: "39.8.11" },
    { ...validatedElectronRuntime, nodeVersion: "22.22.2" },
    { ...validatedElectronRuntime, modulesAbi: "141" },
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

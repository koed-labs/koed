import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrivacyInferenceProbe } from "./privacy-inference-probe.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = (mode: string) => {
  const parent = resolve("scratch");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "privacy-probe-fixture-"));
  roots.push(root);
  const modules = resolve(root, "node_modules/@koed/privacy-service/dist");
  mkdirSync(modules, { recursive: true });
  writeFileSync(resolve(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    resolve(modules, "config.js"),
    `export const resolveConfig = () => ({mode:${JSON.stringify(mode)}});`
  );
  writeFileSync(
    resolve(modules, "runtime-factory.js"),
    `import {writeFileSync,appendFileSync} from 'node:fs';
export const createPrivacyRuntime=(config, provider, verification)=>({provider, config,
  async load(){appendFileSync(${JSON.stringify(resolve(root, "calls"))},provider+'\\n'); if(provider==='cuda' && config.mode==='fail') throw new Error('synthetic CUDA failure');},
  isReady(){return true;}, async dispose(){writeFileSync(verification.profilePrefix+'_profile.json', JSON.stringify([{cat:'Node',args:{provider:provider==='cuda' && config.mode!=='silent-cpu'?'CUDAExecutionProvider':'CPUExecutionProvider'}}]));}
});`
  );
  writeFileSync(
    resolve(modules, "runtime-manager.js"),
    `export const parityOutput = async (runtime) => [{maskedText: runtime.provider==='cuda' && runtime.config.mode==='mismatch'?'mismatched CUDA mask':'Email <PRIVATE> and call <PRIVATE>.', spans:'["synthetic"]'}];`
  );
  const work = resolve(root, "profiles");
  mkdirSync(work);
  return { root, work };
};
describe("Privacy inference provider recovery (controlled fixtures)", () => {
  it.each(["fail", "silent-cpu", "mismatch"])(
    "runs CPU again after CUDA %s and records fallback",
    async (mode) => {
      const { root, work } = fixture(mode);
      const output = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await runPrivacyInferenceProbe([root, root, "cuda", work]);
      expect(readFileSync(resolve(root, "calls"), "utf8")).toBe(
        "cpu\ncuda\ncpu\n"
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining(
          '"fallbackReason":"cuda_initialization_or_inference_failed"'
        )
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('"activeProvider":"cpu"')
      );
    }
  );
  it("records CUDA only when executed kernels and masking parity agree", async () => {
    const { root, work } = fixture("success");
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runPrivacyInferenceProbe([root, root, "cuda", work]);
    expect(readFileSync(resolve(root, "calls"), "utf8")).toBe("cpu\ncuda\n");
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"activeProvider":"cuda"')
    );
    expect(String(output.mock.calls[0]?.[0])).not.toContain("fallbackReason");
  });
});

import { describe, expect, it } from "vitest";
import { createReadCoalescer } from "./read-coalescer.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("read coalescer", () => {
  it("shares one in-flight read between callers", async () => {
    const reads = createReadCoalescer(1_000);
    let calls = 0;
    const gate = deferred<string>();
    const load = () => {
      calls += 1;
      return gate.promise;
    };
    const first = reads.read("list", load);
    const second = reads.read("list", load);
    gate.resolve("rows");
    expect(await first).toBe("rows");
    expect(await second).toBe("rows");
    expect(calls).toBe(1);
  });

  it("reuses a fresh answer, then reads again once it is old", async () => {
    let clock = 0;
    const reads = createReadCoalescer(1_000, () => clock);
    let calls = 0;
    const load = async () => ++calls;
    expect(await reads.read("list", load)).toBe(1);
    clock = 500;
    expect(await reads.read("list", load)).toBe(1);
    clock = 1_600;
    expect(await reads.read("list", load)).toBe(2);
  });

  it("does not keep failures", async () => {
    const reads = createReadCoalescer(1_000);
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("busy");
      return "rows";
    };
    await expect(reads.read("list", load)).rejects.toThrow("busy");
    expect(await reads.read("list", load)).toBe("rows");
  });

  it("forgets everything after a write, including reads in flight", async () => {
    const reads = createReadCoalescer(10_000);
    let calls = 0;
    const gate = deferred<number>();
    const first = reads.read("list", () => {
      calls += 1;
      return gate.promise;
    });
    reads.clear();
    gate.resolve(1);
    await first;
    expect(await reads.read("list", async () => ++calls)).toBe(2);
  });

  it("keeps different reads apart", async () => {
    const reads = createReadCoalescer(1_000);
    expect(await reads.read("a", async () => "a")).toBe("a");
    expect(await reads.read("b", async () => "b")).toBe("b");
  });
});

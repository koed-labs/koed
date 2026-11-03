import { expect, it, vi } from "vitest";
import { modelProgressReader } from "./model-progress.js";

it("reads fragmented progress and ignores malformed or unrelated stderr", () => {
  const callback = vi.fn();
  const read = modelProgressReader(callback);
  read('warning\nKOED_MODEL_PROGRESS {"phase":"downloading",');
  expect(callback).not.toHaveBeenCalled();
  read('"completedBytes":25,"totalBytes":100}\n');
  read(
    'KOED_MODEL_PROGRESS {"phase":"downloading","completedBytes":-1,"totalBytes":100}\n'
  );
  read("KOED_MODEL_PROGRESS invalid\n");
  read(
    'KOED_MODEL_PROGRESS {"phase":"downloading","completedBytes":30,"totalBytes":null}\n'
  );
  expect(callback.mock.calls.map(([value]) => value)).toEqual([
    { phase: "downloading", completedBytes: 25, totalBytes: 100 },
    { phase: "downloading", completedBytes: 30, totalBytes: null }
  ]);
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// Node's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { dismissProjectMoveNotice, hasDismissedProjectMoveNotice, shouldConfirmProjectMove, shouldKeepProjectMoveNoticeIntent, shouldShowProjectMoveInstructionsNotice } from "./project-move-preference.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("dismissed instructions preference never suppresses source-edit confirmation", () => {
  assert.equal(hasDismissedProjectMoveNotice(), false);
  assert.equal(shouldShowProjectMoveInstructionsNotice(), true);
  assert.equal(shouldConfirmProjectMove("unknown"), true);
  assert.equal(shouldConfirmProjectMove("changed"), true);
  assert.equal(shouldConfirmProjectMove("clean"), true);

  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value)
      }
    }
  });

  dismissProjectMoveNotice();
  assert.equal(hasDismissedProjectMoveNotice(), true);
  assert.equal(shouldShowProjectMoveInstructionsNotice(), false);
  assert.equal(shouldConfirmProjectMove("unknown"), true);
  assert.equal(shouldConfirmProjectMove("changed"), true);
  assert.equal(shouldConfirmProjectMove("clean"), false);
});

test("notice intent is retained only for accepted move states", () => {
  assert.equal(shouldKeepProjectMoveNoticeIntent("pending"), true);
  assert.equal(shouldKeepProjectMoveNoticeIntent("claimed"), true);
  assert.equal(shouldKeepProjectMoveNoticeIntent("completed"), true);
  assert.equal(shouldKeepProjectMoveNoticeIntent("failed"), false);
  assert.equal(shouldKeepProjectMoveNoticeIntent("cancelled"), false);
});

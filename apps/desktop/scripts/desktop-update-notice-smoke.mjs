import assert from "node:assert/strict";
import { desktopUpdateStateSchema } from "@koed/shared/desktop-update-contract";

export const assertPackagedNoticeState = (value) => {
  const state = desktopUpdateStateSchema.parse(value);
  assert.equal(
    state.status,
    "disabled",
    "Private smoke must not check public update metadata."
  );
  assert.equal(state.checkedAt, null);
  assert.equal(state.release, null);
  return state;
};

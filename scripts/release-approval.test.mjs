import assert from "node:assert/strict";
import test from "node:test";
import { verifyApproval } from "./release-approval.mjs";

const context = {
  actor: "initiator",
  triggeringActor: "initiator",
  attempt: "1",
  version: "1.2.3"
};
const approval = {
  state: "approved",
  user: { login: "reviewer", type: "User" },
  environments: [{ name: "production" }]
};

test("independent production approvals authorize any valid workflow attempt", () => {
  for (const attempt of ["1", "2", "17"])
    assert.equal(verifyApproval({ ...context, attempt }, [approval]), true);
});

test("publication still rejects invalid attempts and non-independent approval evidence", () => {
  for (const [ctx, evidence] of [
    [{ ...context, attempt: "0" }, [approval]],
    [{ ...context, attempt: "01" }, [approval]],
    [{ ...context, attempt: "2.5" }, [approval]],
    [{ ...context, attempt: 2 }, [approval]],
    [{ ...context, version: "1.2.3-beta.1" }, [approval]],
    [{ ...context, actor: "" }, [approval]],
    [{ ...context, triggeringActor: "" }, [approval]],
    [context, []],
    [context, [{ ...approval, state: "rejected" }]],
    [context, [{ ...approval, environments: [{ name: "other" }] }]],
    [context, [{ ...approval, user: { login: "initiator", type: "User" } }]],
    [context, [{ ...approval, user: { login: "reviewer", type: "Bot" } }]],
    [context, null]
  ])
    assert.throws(() => verifyApproval(ctx, evidence));
});

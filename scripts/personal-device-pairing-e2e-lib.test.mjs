import assert from "node:assert/strict";
import test from "node:test";

import { reconcileJoiningDeviceDatabase } from "./personal-device-pairing-e2e-lib.mjs";

const groupId = "group-test";
const reconciliation = {
  local_device_id: "device-b",
  group: { group_id: groupId },
  statements: [],
  certificates: []
};

test("reconciles and verifies the joining device through a distinct local API", async () => {
  const calls = [];
  const result = await reconcileJoiningDeviceDatabase({
    authorityControlUrl: "http://127.0.0.1:3300",
    joiningControlUrl: "http://127.0.0.1:4300",
    browserCookie: "cm_session=joining",
    groupId,
    localGroupReconciliation: reconciliation,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? {
                local_user_id: "user-b",
                group: { group_id: groupId }
              }
            : { group: { group_id: groupId } }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  assert.equal(result.localUserId, "user-b");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.cookie, "cm_session=joining");
  assert.equal(calls[0].init.headers.origin, "http://127.0.0.1:4300");
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:4300/v1/personal-device-sync/local-group-reconciliation"
  );
});

test("rejects a one-database pairing fixture", async () => {
  await assert.rejects(
    reconcileJoiningDeviceDatabase({
      authorityControlUrl: "http://127.0.0.1:3300",
      joiningControlUrl: "http://127.0.0.1:3300/",
      browserCookie: "cm_session=joining",
      groupId,
      localGroupReconciliation: reconciliation,
      fetch: async () => {
        throw new Error("must not fetch");
      }
    }),
    /distinct local API origins/
  );
});

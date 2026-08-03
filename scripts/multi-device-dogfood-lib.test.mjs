import assert from "node:assert/strict";
import test from "node:test";
import { runMultiDeviceElectronDogfood } from "./multi-device-dogfood-lib.mjs";

const personalThread = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "notes_to_self"
};

const createHarness = ({
  backendByPort = {},
  codexConfigByPort = {
    9224: "/tmp/codex-a/config.toml",
    9225: "/tmp/codex-b/config.toml"
  }
} = {}) => {
  const channels = [];
  const messages = [];
  const clients = new Map();
  const connect = async ({ port }) => {
    const client = {
      port,
      closed: false,
      async evaluate(_fn, args = []) {
        if (args.length === 0) {
          return {
            codex: {
              details: {
                codexConfigPath: codexConfigByPort[port]
              }
            }
          };
        }
        const [command, input] = args;
        if (command === "collaboration.load") {
          return {
            ok: true,
            command,
            data: {
              snapshot: {
                connection: {
                  state: "live",
                  backendId: backendByPort[port] ?? "team-vps"
                },
                navigation: {
                  personal: {
                    notesToSelf: personalThread,
                    channels: [...channels]
                  }
                },
                view: { messages: { items: [...messages] } }
              }
            }
          };
        }
        if (command === "collaboration.send_message") {
          messages.push({ body: input.body });
          return {
            ok: true,
            command,
            data: { durableSend: { state: "queued", body: input.body } }
          };
        }
        if (command === "collaboration.select") {
          return {
            ok: true,
            command,
            data: {
              snapshot: {
                navigation: {
                  personal: {
                    notesToSelf: personalThread,
                    channels: [...channels]
                  }
                },
                view: { messages: { items: [...messages] } }
              }
            }
          };
        }
        if (command === "collaboration.create_personal_channel") {
          const thread = {
            id: "10000000-0000-4000-8000-000000000002",
            kind: "personal_channel",
            name: input.name
          };
          channels.push(thread);
          return { ok: true, command, data: { thread } };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      async waitForCollaborationEvent() {
        return { type: "update" };
      },
      diagnostics() {
        return {
          consoleEvents: [],
          runtimeExceptions: [],
          networkFailures: []
        };
      },
      async reload() {},
      close() {
        this.closed = true;
      }
    };
    clients.set(port, client);
    return client;
  };
  return { connect, clients };
};

test("multi-device dogfood proves bidirectional Personal realtime and channels", async () => {
  const harness = createHarness();
  const result = await runMultiDeviceElectronDogfood({
    deviceAPort: 9224,
    deviceBPort: 9225,
    expectedBackendId: "team-vps",
    markerPrefix: "test-marker",
    connect: harness.connect,
    ensureSetup: async () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.backendId, "team-vps");
  assert.equal(result.isolatedCodexProfiles, true);
  assert.equal(result.flows.aToB.eventType, "update");
  assert.equal(result.flows.bToA.eventType, "update");
  assert.equal(result.flows.channelBToA.eventType, "update");
  assert.equal(result.flows.rendererReloadCatchUp.recovered, true);
  assert.equal(result.personalChannel.observedEventType, "update");
  assert.equal(harness.clients.get(9224).closed, true);
  assert.equal(harness.clients.get(9225).closed, true);
});

test("multi-device dogfood rejects the operator Codex profile", async () => {
  const harness = createHarness({
    codexConfigByPort: {
      9224: "/home/test/.codex/config.toml",
      9225: "/tmp/codex-b/config.toml"
    }
  });

  await assert.rejects(
    () =>
      runMultiDeviceElectronDogfood({
        deviceAPort: 9224,
        deviceBPort: 9225,
        connect: harness.connect,
        ensureSetup: async () => {}
      }),
    /default operator profile is forbidden/
  );
  assert.equal(harness.clients.get(9224).closed, true);
  assert.equal(harness.clients.get(9225).closed, true);
});

test("multi-device dogfood rejects devices attached to different authorities", async () => {
  const harness = createHarness({
    backendByPort: { 9224: "team-vps", 9225: "other-vps" }
  });

  await assert.rejects(
    () =>
      runMultiDeviceElectronDogfood({
        deviceAPort: 9224,
        deviceBPort: 9225,
        connect: harness.connect,
        ensureSetup: async () => {}
      }),
    /do not share the expected live backend/
  );
  assert.equal(harness.clients.get(9224).closed, true);
  assert.equal(harness.clients.get(9225).closed, true);
});

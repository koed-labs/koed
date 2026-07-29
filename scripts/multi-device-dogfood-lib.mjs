/* global window */

import { randomUUID } from "node:crypto";
import {
  connectElectronCdp,
  ensureKoedElectronSetup
} from "./electron-cdp-lib.mjs";

const collaborationCommand = (client, command, input) =>
  client.evaluate(
    async (commandName, commandInput) =>
      window.koedDesktop.collaboration.command({
        contractVersion: 1,
        requestId: crypto.randomUUID(),
        command: commandName,
        input: commandInput
      }),
    [command, input]
  );

const desktopStatus = (client) =>
  client.evaluate(async () => window.koedDesktop.invoke("status"));

const requireIsolatedCodexProfiles = async (deviceA, deviceB) => {
  const [statusA, statusB] = await Promise.all([
    desktopStatus(deviceA),
    desktopStatus(deviceB)
  ]);
  const configPathA = statusA?.codex?.details?.codexConfigPath;
  const configPathB = statusB?.codex?.details?.codexConfigPath;
  if (
    typeof configPathA !== "string" ||
    typeof configPathB !== "string" ||
    configPathA === configPathB ||
    /[/\\]\.codex[/\\]config\.toml$/.test(configPathA) ||
    /[/\\]\.codex[/\\]config\.toml$/.test(configPathB)
  ) {
    throw new Error(
      "Multi-device dogfood requires two distinct synthetic Codex profiles; the default operator profile is forbidden."
    );
  }
  return true;
};

const requireSuccess = (result, command, label = command) => {
  if (!result?.ok || result.command !== command) {
    throw new Error(
      `${label} failed: ${result?.error?.code ?? "invalid_result"} (${result?.command ?? "missing_command"})`
    );
  }
  return result;
};

const personalThreadReference = (threadId) => ({
  scope: "personal",
  threadId
});

const waitForMarker = (client, marker, timeoutMs) =>
  client.waitForCollaborationEvent(
    (event, expectedMarker) => JSON.stringify(event).includes(expectedMarker),
    [marker],
    timeoutMs
  );

const sendAndObserve = async ({
  flow,
  sender,
  receiver,
  threadId,
  marker,
  timeoutMs
}) => {
  const eventPromise = waitForMarker(receiver, marker, timeoutMs);
  try {
    const result = requireSuccess(
      await collaborationCommand(sender, "collaboration.send_message", {
        thread: personalThreadReference(threadId),
        clientMessageId: randomUUID(),
        body: marker
      }),
      "collaboration.send_message",
      `${flow}: collaboration.send_message`
    );
    const event = await eventPromise;
    return {
      marker,
      initialDeliveryState:
        result.data.durableSend?.state ?? result.data.message?.delivery ?? null,
      eventType: event.type
    };
  } catch (error) {
    await eventPromise.catch(() => {});
    throw error;
  }
};

const relevantDiagnostics = (diagnostics) => ({
  runtimeExceptions: diagnostics.runtimeExceptions,
  networkFailures: diagnostics.networkFailures.filter(
    (failure) => failure.canceled !== true
  ),
  consoleErrors: diagnostics.consoleEvents.filter((event) =>
    ["error", "warning"].includes(event.type)
  )
});

export const runMultiDeviceElectronDogfood = async ({
  deviceAPort,
  deviceBPort,
  expectedBackendId,
  timeoutMs = 15_000,
  markerPrefix = `koed-multi-device-${Date.now()}`,
  connect = connectElectronCdp,
  ensureSetup = ensureKoedElectronSetup
}) => {
  const deviceA = await connect({ port: deviceAPort, timeoutMs });
  const deviceB = await connect({ port: deviceBPort, timeoutMs });
  try {
    await ensureSetup(deviceA, { timeoutMs });
    await ensureSetup(deviceB, { timeoutMs });
    const isolatedCodexProfiles = await requireIsolatedCodexProfiles(
      deviceA,
      deviceB
    );

    const loadA = requireSuccess(
      await collaborationCommand(deviceA, "collaboration.load", {}),
      "collaboration.load"
    );
    const loadB = requireSuccess(
      await collaborationCommand(deviceB, "collaboration.load", {}),
      "collaboration.load"
    );
    const snapshotA = loadA.data.snapshot;
    const snapshotB = loadB.data.snapshot;
    const backendIdA = snapshotA.connection.backendId;
    const backendIdB = snapshotB.connection.backendId;
    if (
      snapshotA.connection.state !== "live" ||
      snapshotB.connection.state !== "live" ||
      backendIdA !== backendIdB ||
      (expectedBackendId && backendIdA !== expectedBackendId)
    ) {
      throw new Error(
        "Electron devices do not share the expected live backend."
      );
    }

    const notesA = snapshotA.navigation.personal.notesToSelf;
    const notesB = snapshotB.navigation.personal.notesToSelf;
    if (!notesA || !notesB || notesA.id !== notesB.id) {
      throw new Error(
        "Electron devices do not resolve the same Notes-to-self thread."
      );
    }

    const aToB = await sendAndObserve({
      flow: "notes A to B",
      sender: deviceA,
      receiver: deviceB,
      threadId: notesA.id,
      marker: `${markerPrefix}-a-to-b`,
      timeoutMs
    });
    const bToA = await sendAndObserve({
      flow: "notes B to A",
      sender: deviceB,
      receiver: deviceA,
      threadId: notesA.id,
      marker: `${markerPrefix}-b-to-a`,
      timeoutMs
    });

    const channelName = `dogfood-${randomUUID().slice(0, 8)}`;
    const channelEvent = waitForMarker(deviceB, channelName, timeoutMs);
    const createChannel = requireSuccess(
      await collaborationCommand(
        deviceA,
        "collaboration.create_personal_channel",
        {
          name: channelName,
          topic: `${markerPrefix}-channel`
        }
      ),
      "collaboration.create_personal_channel"
    );
    const channel = createChannel.data.thread;
    const observedChannelEvent = await channelEvent;
    if (channel.kind !== "personal_channel") {
      throw new Error("Personal channel creation returned an invalid thread.");
    }
    const refreshedB = requireSuccess(
      await collaborationCommand(deviceB, "collaboration.load", {}),
      "collaboration.load",
      "channel refresh: collaboration.load"
    ).data.snapshot;
    if (
      !refreshedB.navigation.personal.channels.some(
        (candidate) => candidate.id === channel.id
      )
    ) {
      throw new Error(
        "Created Personal channel is absent after Device B refresh."
      );
    }

    const channelBToA = await sendAndObserve({
      flow: "Personal channel B to A",
      sender: deviceB,
      receiver: deviceA,
      threadId: channel.id,
      marker: `${markerPrefix}-channel-b-to-a`,
      timeoutMs
    });

    const finalA = requireSuccess(
      await collaborationCommand(deviceA, "collaboration.load", {}),
      "collaboration.load"
    ).data.snapshot;
    const finalB = requireSuccess(
      await collaborationCommand(deviceB, "collaboration.load", {}),
      "collaboration.load"
    ).data.snapshot;
    const channelVisibleOnBoth = [finalA, finalB].every((snapshot) =>
      snapshot.navigation.personal.channels.some(
        (candidate) =>
          candidate.id === channel.id && candidate.name === channelName
      )
    );
    if (!channelVisibleOnBoth) {
      throw new Error(
        "Created Personal channel is not visible on both devices."
      );
    }
    const selectOnBoth = async (selection) =>
      Promise.all(
        [deviceA, deviceB].map(async (device) =>
          requireSuccess(
            await collaborationCommand(device, "collaboration.select", {
              selection
            }),
            "collaboration.select"
          )
        )
      );
    const notesSnapshots = await selectOnBoth({ kind: "notes_to_self" });
    for (const marker of [aToB.marker, bToA.marker]) {
      if (
        notesSnapshots.some(
          (result) => !JSON.stringify(result.data.snapshot).includes(marker)
        )
      ) {
        throw new Error(
          `Persisted Notes snapshot is missing marker ${marker}.`
        );
      }
    }
    const channelSnapshots = await selectOnBoth({
      kind: "personal_channel",
      threadId: channel.id
    });
    if (
      channelSnapshots.some(
        (result) =>
          !JSON.stringify(result.data.snapshot).includes(channelBToA.marker)
      )
    ) {
      throw new Error(
        `Persisted Personal channel snapshot is missing marker ${channelBToA.marker}.`
      );
    }

    const catchUpMarker = `${markerPrefix}-renderer-reload-catch-up`;
    const reload = deviceB.reload(timeoutMs);
    const catchUpSend = requireSuccess(
      await collaborationCommand(deviceA, "collaboration.send_message", {
        thread: personalThreadReference(notesA.id),
        clientMessageId: randomUUID(),
        body: catchUpMarker
      }),
      "collaboration.send_message",
      "renderer reload catch-up: collaboration.send_message"
    );
    await reload;
    await ensureSetup(deviceB, { timeoutMs });
    const caughtUp = requireSuccess(
      await collaborationCommand(deviceB, "collaboration.select", {
        selection: { kind: "notes_to_self" }
      }),
      "collaboration.select",
      "renderer reload catch-up: collaboration.select"
    );
    if (!JSON.stringify(caughtUp.data.snapshot).includes(catchUpMarker)) {
      throw new Error(
        "Device B did not catch up the message sent during renderer reload."
      );
    }

    const diagnostics = {
      deviceA: relevantDiagnostics(deviceA.diagnostics()),
      deviceB: relevantDiagnostics(deviceB.diagnostics())
    };
    if (
      diagnostics.deviceA.runtimeExceptions.length > 0 ||
      diagnostics.deviceB.runtimeExceptions.length > 0 ||
      diagnostics.deviceA.networkFailures.length > 0 ||
      diagnostics.deviceB.networkFailures.length > 0
    ) {
      throw Object.assign(
        new Error("Electron CDP reported runtime or network failures."),
        { diagnostics }
      );
    }

    return {
      ok: true,
      markerPrefix,
      backendId: backendIdA,
      isolatedCodexProfiles,
      notesThreadId: notesA.id,
      personalChannel: {
        id: channel.id,
        name: channelName,
        observedEventType: observedChannelEvent.type
      },
      flows: {
        aToB,
        bToA,
        channelBToA,
        rendererReloadCatchUp: {
          marker: catchUpMarker,
          initialDeliveryState:
            catchUpSend.data.durableSend?.state ??
            catchUpSend.data.message?.delivery ??
            null,
          recovered: true
        }
      },
      diagnostics
    };
  } finally {
    deviceA.close();
    deviceB.close();
  }
};

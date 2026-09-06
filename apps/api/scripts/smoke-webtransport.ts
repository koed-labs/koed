import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLABORATION_CONTRACT_VERSION,
  type WebTransportSessionAdmission
} from "@koed/shared";
import {
  encodeDurableRealtimeStreamFrame,
  readFirstBoundedDurableRealtimeFrame
} from "@koed/shared/durable-realtime";
import { WebTransport } from "quico";
import type { RealtimeTransportAdmissionService } from "../src/realtime-transport/service.js";
import type { WebTransportDurableEventAdapter } from "../src/realtime-transport/webtransport-durable-adapter.js";
import { startWebTransportGateway } from "../src/realtime-transport/webtransport-gateway.js";

const run = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))
    );
  });

const port = Number.parseInt(
  process.env.KOED_WEBTRANSPORT_SMOKE_PORT ?? "45443",
  10
);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("KOED_WEBTRANSPORT_SMOKE_PORT is invalid");
}

const directory = await mkdtemp(join(tmpdir(), "koed-webtransport-smoke-"));
const keyPath = join(directory, "server.key");
const certificatePath = join(directory, "server.crt");
let gateway: Awaited<ReturnType<typeof startWebTransportGateway>> | null = null;
let session: WebTransport | null = null;

try {
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath
  ]);
  const userId = randomUUID();
  const ticketId = randomUUID();
  const connectionId = randomUUID();
  const clientInstanceId = `lcb1.${"a".repeat(43)}`;
  const admissionRecord = {
    ticketId,
    ownerUserId: userId,
    authKind: "device_credential" as const,
    userSessionId: null,
    deviceCredentialId: randomUUID(),
    transport: "webtransport" as const,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    operationFamilies: ["personal_collaboration_read" as const],
    consumedAt: new Date().toISOString()
  };
  const admissionService = {
    adapters: () => [],
    registerAdapter: () => () => undefined,
    issueTicket: async () => {
      throw new Error("not used");
    },
    consumeTicket: async () => admissionRecord,
    reauthenticate: async () => ({
      user: { id: userId, email: "smoke@example.test", displayName: "Smoke" },
      operationFamilies: admissionRecord.operationFamilies
    })
  } satisfies RealtimeTransportAdmissionService;
  const durableAdapter = {
    descriptor: {
      transport: "webtransport" as const,
      protocolVersions: [COLLABORATION_CONTRACT_VERSION] as const,
      endpoint: `https://localhost:${port}/v1/realtime/webtransport`
    },
    async accept(input) {
      const writer = input.stream.writable.getWriter();
      await writer.write(
        encodeDurableRealtimeStreamFrame(
          {
            event: "ready",
            id: null,
            data: JSON.stringify({ transport: "webtransport" })
          },
          16 * 1024
        )
      );
      await writer.close();
      writer.releaseLock();
      return { subscriptionId: randomUUID(), closed: Promise.resolve() };
    }
  } satisfies WebTransportDurableEventAdapter;
  gateway = await startWebTransportGateway({
    endpoint: durableAdapter.descriptor.endpoint,
    listenHost: "127.0.0.1",
    listenPort: port,
    tlsCertificate: await readFile(certificatePath),
    tlsKey: await readFile(keyPath),
    admissionService,
    durableAdapter,
    maxSessions: 2,
    maxStreamsPerSession: 4,
    maxDatagramBytes: 900
  });

  session = new WebTransport(durableAdapter.descriptor.endpoint, {
    rejectUnauthorized: false
  });
  await session.ready;
  const control = await session.createBidirectionalStream();
  const controlWriter = control.writable.getWriter();
  const admission: WebTransportSessionAdmission = {
    frameVersion: 1,
    type: "session.admit",
    ticket: `rtt1_${ticketId}.${"b".repeat(43)}`,
    connectionId,
    clientInstanceId,
    clientKind: "native",
    nativeDeviceInstanceId: `device.${"c".repeat(32)}`
  };
  await controlWriter.write(
    encodeDurableRealtimeStreamFrame(
      { event: "attach", id: null, data: JSON.stringify(admission) },
      16 * 1024
    )
  );
  const controlReady = await readFirstBoundedDurableRealtimeFrame({
    body: control.readable,
    signal: new AbortController().signal,
    maxFrameBytes: 16 * 1024
  });
  if (controlReady.frame.event !== "session_ready") {
    throw new Error("WebTransport session was not admitted");
  }

  const durable = await session.createBidirectionalStream();
  const durableWriter = durable.writable.getWriter();
  await durableWriter.write(
    encodeDurableRealtimeStreamFrame(
      {
        event: "attach",
        id: null,
        data: JSON.stringify({
          frameVersion: 1,
          type: "durable_events.attach",
          subscriptionKey: `subscription.${"d".repeat(32)}`,
          cursor: `crt1.${"e".repeat(64)}`,
          scope: "personal"
        })
      },
      16 * 1024
    )
  );
  await durableWriter.close();
  const durableReady = await readFirstBoundedDurableRealtimeFrame({
    body: durable.readable,
    signal: new AbortController().signal,
    maxFrameBytes: 16 * 1024
  });
  if (durableReady.frame.event !== "ready") {
    throw new Error("WebTransport durable stream did not produce ready");
  }
  const metrics = gateway.inspect();
  if (metrics.sessionsAccepted !== 1 || metrics.durableStreamsAccepted !== 1) {
    throw new Error(
      "WebTransport runtime metrics did not record the smoke path"
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      transport: "webtransport",
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      metrics
    })}\n`
  );
  await controlWriter.close();
} finally {
  session?.close({ closeCode: 0, reason: "smoke complete" });
  await gateway?.close();
  await rm(directory, { recursive: true, force: true });
}

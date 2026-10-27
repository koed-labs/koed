/**
 * The phone gateway's HTTP listener.
 *
 * It binds concrete private-network addresses only (home or office Wi-Fi,
 * Tailscale), never a wildcard or public address, the same rule as Personal
 * device pairing. Everything except /hello and /pair needs a paired phone's
 * bearer token. Bodies are small JSON, requests are rate limited per phone
 * and per address, and live updates are one Server-Sent Events stream.
 *
 * There is no TLS on this listener: on a LAN, traffic between the phone and
 * the Mac is readable by others on that network. Tailscale encrypts it.
 * Documented in docs/phone-gateway.md.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { ZodError } from "zod";
import {
  PHONE_API_PREFIX,
  PHONE_API_VERSION,
  phoneAskRequestSchema,
  phoneControlRequestSchema,
  phoneEditionAssignSchema,
  phoneJobEditRequestSchema,
  phoneJobPauseRequestSchema,
  phoneJobRunActionSchema,
  phoneMessageRequestSchema,
  phonePairRequestSchema,
  phoneProposalRespondSchema,
  phonePushRequestSchema,
  phoneRespondRequestSchema,
  type PhoneLiveEvent,
  type PhonePairRequest
} from "./contract.js";
import { PhoneGatewayError, type PhoneGatewayService } from "./service.js";
import type { PairedPhone } from "./store.js";

const MAXIMUM_BODY_BYTES = 300 * 1024;
const REQUESTS_PER_MINUTE = 240;
const PAIR_ATTEMPTS_PER_MINUTE = 10;

export type PhoneGatewayRequestContext = {
  phone: PairedPhone | null;
  remoteAddress: string;
};

export type PhoneGatewayRoutes = {
  hello: () => { app: "koed"; api: number; name: string; pairing: boolean };
  pair: (
    request: PhonePairRequest,
    remoteAddress: string
  ) => Promise<{ token: string; phoneId: string; macName: string }>;
  authenticate: (token: string) => Promise<PairedPhone | null>;
  service: PhoneGatewayService;
  setPushToken: (phoneId: string, token: string | null) => Promise<void>;
  unpair: (phoneId: string) => Promise<void>;
  /** Live events for one phone. Returns a function that stops them. */
  subscribe: (
    phoneId: string,
    send: (event: PhoneLiveEvent) => void
  ) => () => void;
};

type Json = Record<string, unknown> | unknown[];
type Handled = { status: number; body: Json };

const segment = (value: string | undefined): string => {
  if (!value) throw new PhoneGatewayError(404, "Not found.");
  const decoded = decodeURIComponent(value);
  if (
    !decoded ||
    decoded.length > 512 ||
    [...decoded].some((character) => character.charCodeAt(0) < 0x20)
  )
    throw new PhoneGatewayError(400, "Invalid identifier.");
  return decoded;
};

/** Route one authenticated request. Kept free of node:http so it can be tested directly. */
export const routePhoneRequest = async (
  routes: PhoneGatewayRoutes,
  method: string,
  path: string,
  body: unknown,
  context: PhoneGatewayRequestContext
): Promise<Handled> => {
  if (!path.startsWith(`${PHONE_API_PREFIX}/`))
    throw new PhoneGatewayError(404, "Not found.");
  const parts = path.slice(PHONE_API_PREFIX.length + 1).split("/");
  const [a, b, c, d, e, f] = parts;
  const route = `${method} ${a ?? ""}`;

  if (route === "GET hello") return { status: 200, body: routes.hello() };
  if (route === "POST pair") {
    const request = phonePairRequestSchema.parse(body);
    return {
      status: 200,
      body: await routes.pair(request, context.remoteAddress)
    };
  }

  const phone = context.phone;
  if (!phone)
    throw new PhoneGatewayError(
      401,
      "This phone isn't paired with Koed on this Mac."
    );
  const service = routes.service;

  switch (route) {
    case "GET home":
      return { status: 200, body: await service.home() };
    case "GET chief":
      if (b === "timeline" && !c)
        return { status: 200, body: await service.chiefTimeline() };
      break;
    case "POST chief":
      if (b === "messages" && !c) {
        const request = phoneMessageRequestSchema.parse(body);
        return {
          status: 202,
          body: await service.sendToChief(request.text, request.clientMessageId)
        };
      }
      if (b === "new" && !c) {
        await service.newChiefConversation();
        return { status: 200, body: { ok: true } };
      }
      break;
    case "GET conversations":
      if (!b)
        return {
          status: 200,
          body: { conversations: await service.recentConversations() }
        };
      if (c && !d)
        return {
          status: 200,
          body: await service.conversationTimeline(segment(b), segment(c))
        };
      break;
    case "POST conversations":
      if (b && c && d === "messages" && !e) {
        const request = phoneMessageRequestSchema.parse(body);
        return {
          status: 202,
          body: await service.sendToConversation(
            segment(b),
            segment(c),
            request.text,
            request.clientMessageId
          )
        };
      }
      break;
    case "GET executions":
      if (b && !c) return { status: 200, body: await service.run(segment(b)) };
      break;
    case "POST executions":
      if (b && c === "control" && !d) {
        const request = phoneControlRequestSchema.parse(body);
        return {
          status: 202,
          body: await service.control(segment(b), request.action)
        };
      }
      break;
    case "POST needs":
      if (b === "respond" && !c)
        return {
          status: 200,
          body: await service.respond(phoneRespondRequestSchema.parse(body))
        };
      break;
    case "POST proposals":
      if (b === "respond" && !c)
        return {
          status: 200,
          body: await service.resolveProposal(
            phoneProposalRespondSchema.parse(body)
          )
        };
      break;
    case "GET collection":
      if (!b) return { status: 200, body: await service.collection() };
      break;
    case "PUT editions":
      if (b && !c)
        return {
          status: 200,
          body: await service.assignEdition(
            segment(b),
            phoneEditionAssignSchema.parse(body).agentId
          )
        };
      break;
    case "POST editions":
      if (b && c === "seen" && !d)
        return { status: 200, body: await service.markSeen(segment(b)) };
      break;
    case "GET jobs":
      if (!b) return { status: 200, body: { jobs: await service.jobs() } };
      if (!c) return { status: 200, body: await service.job(segment(b)) };
      break;
    case "POST jobs":
      if (b && c === "pause" && !d)
        return {
          status: 200,
          body: await service.pauseJob(
            segment(b),
            phoneJobPauseRequestSchema.parse(body).paused
          )
        };
      if (b && c === "edit" && !d)
        return {
          status: 200,
          body: await service.editJob(
            segment(b),
            phoneJobEditRequestSchema.parse(body)
          )
        };
      if (b && c === "run-now" && !d)
        return { status: 202, body: await service.runJobNow(segment(b)) };
      if (b && c === "runs" && d && e && !f)
        return {
          status: 200,
          body: await service.resolveRun(
            segment(b),
            segment(d),
            phoneJobRunActionSchema.parse(e)
          )
        };
      break;
    case "POST ask":
      if (!b) {
        const request = phoneAskRequestSchema.parse(body);
        return {
          status: 202,
          body: await service.ask(
            request.query,
            request.clientRequestId,
            request.askThreadId
          )
        };
      }
      break;
    case "GET ask":
      if (b && !c)
        return {
          status: 200,
          body: { turns: await service.askThread(segment(b)) }
        };
      break;
    case "GET computer":
      if (!b) return { status: 200, body: await service.computer() };
      break;
    case "PUT push":
      if (!b) {
        await routes.setPushToken(
          phone.id,
          phonePushRequestSchema.parse(body).expoPushToken
        );
        return { status: 200, body: { ok: true } };
      }
      break;
    case "DELETE session":
      if (!b) {
        await routes.unpair(phone.id);
        return { status: 200, body: { ok: true } };
      }
      break;
  }
  throw new PhoneGatewayError(404, "Not found.");
};

/* ---------- node:http ---------- */

class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number
  ) {}
  allow(key: string): boolean {
    const time = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => time - at < 60_000
    );
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(time);
    this.hits.set(key, recent);
    if (this.hits.size > 2_000) this.hits.clear();
    return true;
  }
}

const readBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) {
        reject(new PhoneGatewayError(413, "Request too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) return resolve(undefined);
      if (!/^application\/json\b/iu.test(request.headers["content-type"] ?? ""))
        return reject(new PhoneGatewayError(415, "JSON only."));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new PhoneGatewayError(400, "Invalid JSON."));
      }
    });
    request.on("error", reject);
  });

const send = (response: ServerResponse, status: number, body: Json) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
};

const bearer = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header);
  return match ? match[1]! : null;
};

export type PhoneGatewayListener = {
  addresses: string[];
  port: number;
  close(): Promise<void>;
};

export const startPhoneGatewayListener = async (input: {
  hosts: readonly string[];
  port: number;
  routes: PhoneGatewayRoutes;
  now?: () => number;
  onError?: (error: unknown) => void;
}): Promise<PhoneGatewayListener> => {
  const now = input.now ?? Date.now;
  const requests = new Limiter(REQUESTS_PER_MINUTE, now);
  const pairing = new Limiter(PAIR_ATTEMPTS_PER_MINUTE, now);
  const streams = new Set<ServerResponse>();

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse
  ) => {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    try {
      const url = new URL(request.url ?? "/", "http://phone.invalid");
      const method = request.method ?? "GET";
      if (
        url.pathname === `${PHONE_API_PREFIX}/pair` &&
        !pairing.allow(remoteAddress)
      )
        throw new PhoneGatewayError(
          429,
          "Too many pairing attempts. Wait a minute."
        );
      const token = bearer(request);
      const phone = token ? await input.routes.authenticate(token) : null;
      if (token && !phone)
        throw new PhoneGatewayError(
          401,
          "This phone isn't paired with Koed on this Mac."
        );
      if (!requests.allow(phone?.id ?? remoteAddress))
        throw new PhoneGatewayError(
          429,
          "Too many requests. Slow down a little."
        );

      if (method === "GET" && url.pathname === `${PHONE_API_PREFIX}/events`) {
        if (!phone)
          throw new PhoneGatewayError(
            401,
            "This phone isn't paired with Koed on this Mac."
          );
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        response.write(`: koed phone events v${PHONE_API_VERSION}\n\n`);
        streams.add(response);
        const stop = input.routes.subscribe(phone.id, (event) => {
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          );
        });
        const heartbeat = setInterval(
          () => response.write(": ping\n\n"),
          20_000
        );
        request.on("close", () => {
          clearInterval(heartbeat);
          stop();
          streams.delete(response);
        });
        return;
      }

      const body =
        method === "GET" || method === "DELETE"
          ? undefined
          : await readBody(request);
      const handled = await routePhoneRequest(
        input.routes,
        method,
        url.pathname,
        body,
        { phone, remoteAddress }
      );
      send(response, handled.status, handled.body);
    } catch (error) {
      if (error instanceof PhoneGatewayError)
        return send(response, error.status, { error: error.message });
      if (error instanceof ZodError)
        return send(response, 400, { error: "The request isn't valid." });
      input.onError?.(error);
      send(response, 500, { error: "Koed couldn't do that right now." });
    }
  };

  const servers: Server[] = [];
  const addresses: string[] = [];
  for (const host of input.hosts) {
    const server = createServer(
      (request, response) => void handler(request, response)
    );
    server.headersTimeout = 15_000;
    server.requestTimeout = 120_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: input.port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    }).then(
      () => {
        servers.push(server);
        const address = server.address() as AddressInfo;
        addresses.push(`http://${address.address}:${address.port}`);
      },
      (error: unknown) => input.onError?.(error)
    );
  }
  if (servers.length === 0)
    throw new Error(
      "The phone gateway couldn't listen on any private network address."
    );
  const port = (servers[0]!.address() as AddressInfo).port;

  return {
    addresses,
    port,
    close: async () => {
      for (const stream of streams) stream.end();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve()))
        )
      );
    }
  };
};

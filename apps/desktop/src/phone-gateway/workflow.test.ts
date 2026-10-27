/**
 * The phone's normal workflow, end to end over HTTP: the real phone gateway
 * (listener, pairing, auth, live events, push, ranks and editions) over a
 * simulated Koed (fake-koed.testkit.ts). Each step depends on the ones
 * before it, like a person using the app for the first time.
 */
import { createServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeKoed,
  FAKE_IDS,
  type FakeKoed
} from "./fake-koed.testkit.js";
import { createPhoneGateway, type PhoneGateway } from "./index.js";
import type { PhonePush } from "./push.js";
import { createPhoneGatewayStore } from "./store.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const until = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 8_000
): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out; last value: ${JSON.stringify(value).slice(0, 400)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

let koed: FakeKoed;
let gateway: PhoneGateway;
let base = "";
let token = "";
let pixelToken = "";
const pushes: PhonePush[] = [];
const secrets = new Map<string, string>();
const errors: unknown[] = [];

type Reply = { status: number; body: any };
const call = async (
  method: string,
  path: string,
  body?: unknown,
  bearer: string | null = token
): Promise<Reply> => {
  const response = await fetch(`${base}/koed-phone/v1${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null)
  };
};

/** The phone's live event stream, collected. */
const listen = (bearer: string) => {
  const events: any[] = [];
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${base}/koed-phone/v1/events`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch(() => undefined);
  return { events, close: () => controller.abort() };
};

const home = async () => (await call("GET", "/home")).body;

beforeAll(async () => {
  koed = createFakeKoed({ replyMs: 600, noChief: true });
  const secretStore = {
    get: async (key: string) => secrets.get(key) ?? null,
    put: async (key: string, value: string) => void secrets.set(key, value),
    delete: async (key: string) => void secrets.delete(key)
  };
  const store = createPhoneGatewayStore(secretStore);
  const port = await freePort();
  await store.update((state) => ({ ...state, port }));
  gateway = createPhoneGateway({
    deps: koed.deps,
    secrets: secretStore,
    store,
    hosts: () => ["127.0.0.1"],
    push: async (messages) => void pushes.push(...messages),
    pollMs: 150,
    onError: (cause) => errors.push(cause)
  });
  const status = await gateway.setEnabled(true);
  expect(status.listening).toEqual([`http://127.0.0.1:${port}`]);
  base = status.listening[0]!;
});

afterAll(async () => {
  await gateway.stop();
});

describe("phone workflow: pairing", () => {
  it("answers hello without a token, with no pairing on offer yet", async () => {
    const hello = await call("GET", "/hello", undefined, null);
    expect(hello).toEqual({
      status: 200,
      body: { app: "koed", api: 1, name: "Jacobo's MacBook", pairing: false }
    });
  });

  it("refuses a wrong code, and withdraws the code after five wrong tries", async () => {
    const { pairing } = await gateway.beginPairing();
    expect(pairing?.code).toMatch(/^\d{6}$/u);
    const wrong = pairing!.code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await call(
        "POST",
        "/pair",
        { code: wrong, deviceName: "Jacobo's iPhone", platform: "ios" },
        null
      );
      expect(reply.status).toBe(403);
      expect(reply.body.error).toMatch(/doesn't match/u);
    }
    // The right code no longer works: the offer was withdrawn.
    const late = await call(
      "POST",
      "/pair",
      { code: pairing!.code, deviceName: "Jacobo's iPhone", platform: "ios" },
      null
    );
    expect(late.status).toBe(410);
  });

  it("pairs with the typed code from a fresh offer, once", async () => {
    const { pairing } = await gateway.beginPairing();
    const reply = await call(
      "POST",
      "/pair",
      { code: pairing!.code, deviceName: "Jacobo's iPhone", platform: "ios" },
      null
    );
    expect(reply.status).toBe(200);
    expect(reply.body.macName).toBe("Jacobo's MacBook");
    expect(reply.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    token = reply.body.token;
    const again = await call(
      "POST",
      "/pair",
      { code: pairing!.code, deviceName: "Another phone", platform: "ios" },
      null
    );
    expect(again.status).toBe(410);
    const status = await gateway.status();
    expect(status.phones.map((phone) => phone.name)).toEqual([
      "Jacobo's iPhone"
    ]);
    // Only a hash of the token is kept.
    expect(secrets.get("koed-phone-gateway.v1")).not.toContain(token);
  });

  it("pairs a second phone with the QR secret, which works once", async () => {
    const { pairing } = await gateway.beginPairing();
    const link = new URL(pairing!.link);
    expect(link.protocol).toBe("koed:");
    expect(link.searchParams.getAll("u")).toEqual([base]);
    const secret = link.searchParams.get("s")!;
    const reply = await call(
      "POST",
      "/pair",
      { secret, deviceName: "Pixel", platform: "android" },
      null
    );
    expect(reply.status).toBe(200);
    pixelToken = reply.body.token;
    const reuse = await call(
      "POST",
      "/pair",
      { secret, deviceName: "Pixel 2", platform: "android" },
      null
    );
    expect(reuse.status).toBe(410);
    // The second phone is removed from the Mac later (see "unpairing").
  });

  it("refuses everything else without a paired phone's token", async () => {
    expect((await call("GET", "/home", undefined, null)).status).toBe(401);
    expect((await call("GET", "/home", undefined, "x".repeat(43))).status).toBe(
      401
    );
    expect((await call("GET", "/home", undefined, "short")).status).toBe(401);
  });
});

describe("phone workflow: first look", () => {
  it("makes the Chief of Staff on first use and shows the home screen", async () => {
    const first = await home();
    expect(koed.log).toContain("agents:ensureChief");
    expect(first.chief).toMatchObject({ name: "Cooper", isChiefOfStaff: true });
    expect(first.agents.map((agent: any) => agent.name)).toEqual([
      "Quinn",
      "Nova",
      "Rex"
    ]);
    expect(first.mac.name).toBe("Jacobo's MacBook");
  });

  it("shows what needs the person: a risky and a safe approval, a question, a missed run", async () => {
    const { needs } = await home();
    const byKind = (kind: string) =>
      needs.filter((need: any) => need.kind === kind);
    const [push, test] = [
      byKind("approval").find((need: any) => need.itemId === "item-push"),
      byKind("approval").find((need: any) => need.itemId === "item-test")
    ];
    expect(push).toMatchObject({
      command: "git push origin main",
      risky: true,
      conversation: { title: "Fix the webhook retries", aiClient: "codex" }
    });
    expect(test).toMatchObject({ command: "pnpm test", risky: false });
    expect(byKind("question")[0].questions[0]).toMatchObject({
      question: "Which branch should the release notes go on?",
      options: [
        { label: "main", description: null },
        { label: "release/0.9", description: null }
      ]
    });
    expect(byKind("missed")[0]).toMatchObject({
      jobTitle: "Morning brief",
      runId: FAKE_IDS.missedRun
    });
  });

  it("shows what's coming up and each agent's standing", async () => {
    const { upcoming, agents, chief } = await home();
    expect(upcoming.map((entry: any) => entry.title).sort()).toEqual([
      "Docs link check",
      "Morning brief",
      "Release check"
    ]);
    const nova = agents.find((agent: any) => agent.name === "Nova");
    expect(nova.standing).toMatchObject({
      rank: "Old hand",
      jobsFinished: 22,
      nextRank: null
    });
    expect(chief.standing).toMatchObject({
      rank: "Getting acquainted",
      jobsFinished: 4,
      toNext: "1 more job to Trusted hand"
    });
  });

  it("shows the Mac's AI Clients and plan usage", async () => {
    const { body } = await call("GET", "/computer");
    expect(body.aiClients).toEqual([
      expect.objectContaining({
        name: "Claude Code",
        ready: true,
        models: ["Opus"],
        usage: [expect.objectContaining({ usedPercent: 42 })]
      }),
      expect.objectContaining({
        name: "Codex",
        ready: true,
        models: ["GPT-5.5"]
      })
    ]);
  });
});

describe("phone workflow: talking to the Chief of Staff (Claude Code)", () => {
  const chief = () =>
    call("GET", "/chief/timeline").then((reply) => reply.body);

  it("starts the Chief's Chat on its own AI Client and gets a reply", async () => {
    const id = crypto.randomUUID();
    const sent = await call("POST", "/chief/messages", {
      text: "What's on today?",
      clientMessageId: id
    });
    expect(sent.status).toBe(202);
    // The message shows at once, before the Mac has recorded it.
    const right = await chief();
    expect(
      right.events.some(
        (event: any) =>
          event.role === "user" && event.text === "What's on today?"
      )
    ).toBe(true);
    const answered = await until(chief, (timeline) =>
      timeline.events.some((event: any) => event.role === "assistant")
    );
    expect(answered.events.at(-1)).toMatchObject({
      role: "assistant",
      text: "Got it: “What's on today?”. I'll ask Quinn and report back."
    });
    expect(koed.log).toContain("start:claude.default:claude-opus");
  });

  it("keeps one Chat: the next message goes to the same conversation", async () => {
    const starts = koed.log.filter((entry) =>
      entry.startsWith("start:")
    ).length;
    await call("POST", "/chief/messages", {
      text: "And tomorrow?",
      clientMessageId: crypto.randomUUID()
    });
    await until(
      chief,
      (timeline) =>
        timeline.events.filter((event: any) => event.role === "assistant")
          .length === 2
    );
    expect(koed.log.filter((entry) => entry.startsWith("start:")).length).toBe(
      starts
    );
  });

  it("never sends the same message twice (a retried request)", async () => {
    const id = crypto.randomUUID();
    await call("POST", "/chief/messages", {
      text: "Once only",
      clientMessageId: id
    });
    await call("POST", "/chief/messages", {
      text: "Once only",
      clientMessageId: id
    });
    await until(
      chief,
      (timeline) =>
        timeline.events.filter((event: any) => event.role === "assistant")
          .length === 3
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      koed.log.filter((entry) => entry.endsWith(":Once only")).length
    ).toBe(1);
  });

  it("shows the reply as it's written, and the turn as busy", async () => {
    await call("POST", "/chief/messages", {
      text: "Summarise the open PRs",
      clientMessageId: crypto.randomUUID()
    });
    const live = await until(
      chief,
      (timeline) => Boolean(timeline.streaming),
      3_000
    );
    expect(live.streaming).toBe("Thinking it through…");
    expect(live.execution.busy).toBe(true);
    await until(chief, (timeline) => !timeline.execution.busy);
  });

  it("starts a fresh conversation on request", async () => {
    const before = (await chief()).conversation.threadId;
    expect((await call("POST", "/chief/new")).status).toBe(200);
    expect((await chief()).conversation).toBeNull();
    await call("POST", "/chief/messages", {
      text: "New topic",
      clientMessageId: crypto.randomUUID()
    });
    const after = await until(chief, (timeline) =>
      Boolean(timeline.conversation)
    );
    expect(after.conversation.threadId).not.toBe(before);
    await until(chief, (timeline) => !timeline.execution?.busy);
  });
});

describe("phone workflow: other Chats on the Mac", () => {
  it("lists Codex and Claude Code Chats", async () => {
    const { body } = await call("GET", "/conversations");
    const titles = body.conversations.map(
      (chat: any) => `${chat.title} (${chat.aiClient})`
    );
    expect(titles).toEqual(
      expect.arrayContaining([
        "Fix the webhook retries (codex)",
        "Draft the release notes (claude-code)"
      ])
    );
  });

  it("continues a Codex Chat that's open on the Mac", async () => {
    const path = "/conversations/lp_koed/thread-codex";
    expect(
      (
        await call("POST", `${path}/messages`, {
          text: "Also bump the version",
          clientMessageId: crypto.randomUUID()
        })
      ).status
    ).toBe(202);
    const timeline = await until(
      () => call("GET", path).then((reply) => reply.body),
      (value) =>
        value.events.at(-1)?.text === "Codex here. Done: Also bump the version"
    );
    expect(timeline.conversation.aiClient).toBe("codex");
  });

  it("continues a Claude Code Chat with no session open (Koed resumes it)", async () => {
    const path = "/conversations/lp_site/thread-claude";
    const first = (await call("GET", path)).body;
    expect(first.events[1].text).toContain("## Koed 0.9");
    await call("POST", `${path}/messages`, {
      text: "Add a line about Ask memory",
      clientMessageId: crypto.randomUUID()
    });
    await until(
      () => call("GET", path).then((reply) => reply.body),
      (value) =>
        value.events.at(-1)?.text ===
        "Claude here. Done: Add a line about Ask memory"
    );
    expect(koed.log).toContain("resumed:thread-claude");
  });

  it("refuses a Chat that doesn't exist", async () => {
    const reply = await call(
      "POST",
      "/conversations/lp_none/thread-none/messages",
      {
        text: "Hello?",
        clientMessageId: crypto.randomUUID()
      }
    );
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.body.error).toBeTruthy();
  });
});

describe("phone workflow: the bell", () => {
  const need = async (itemId: string) =>
    (await home()).needs.find((entry: any) => entry.itemId === itemId);

  it("allows a risky command", async () => {
    const push = await need("item-push");
    const reply = await call("POST", "/needs/respond", {
      executionId: push.executionId,
      itemId: push.itemId,
      executionGeneration: push.executionGeneration,
      itemKind: push.itemKind,
      decision: "accept"
    });
    expect(reply.status).toBe(200);
    expect(koed.log).toContain("respond:item-push:accept");
    expect(await need("item-push")).toBeUndefined();
  });

  it("declines a command", async () => {
    const test = await need("item-test");
    await call("POST", "/needs/respond", {
      executionId: test.executionId,
      itemId: test.itemId,
      executionGeneration: test.executionGeneration,
      itemKind: test.itemKind,
      decision: "decline"
    });
    expect(koed.log).toContain("respond:item-test:decline");
  });

  it("answers a question with one of its options", async () => {
    const question = await need("item-question");
    await call("POST", "/needs/respond", {
      executionId: question.executionId,
      itemId: question.itemId,
      executionGeneration: question.executionGeneration,
      itemKind: question.itemKind,
      answers: { branch: ["release/0.9"] }
    });
    expect(koed.log).toContain(
      'respond:item-question:{"branch":["release/0.9"]}'
    );
  });

  it("refuses a malformed answer, and an answer to something already answered", async () => {
    const bad = await call("POST", "/needs/respond", {
      executionId: FAKE_IDS.codexExecution,
      itemId: "item-push",
      executionGeneration: 3,
      itemKind: "command_approval",
      answers: { x: ["y"] }
    });
    expect(bad.status).toBe(400);
    const stale = await call("POST", "/needs/respond", {
      executionId: FAKE_IDS.codexExecution,
      itemId: "item-push",
      executionGeneration: 3,
      itemKind: "command_approval",
      decision: "accept"
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.body.error).toBeTruthy();
  });

  it("tells an open phone at once when something new needs it", async () => {
    const stream = listen(token);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const id = koed.addApproval(["rm", "-rf", "build"], "Clean the build");
    const event = await until(
      async () => stream.events,
      (events) =>
        events.some(
          (entry) =>
            entry.type === "notification" && entry.notification.id.endsWith(id)
        )
    );
    expect(event.find((entry) => entry.type === "notification")).toMatchObject({
      notification: { kind: "approval", title: "Needs your OK (Face ID)" }
    });
    expect(event.some((entry) => entry.type === "changed")).toBe(true);
    stream.close();
  });

  it("interrupts and stops a turn", async () => {
    expect(
      (
        await call("POST", `/executions/${FAKE_IDS.codexExecution}/control`, {
          action: "interrupt"
        })
      ).status
    ).toBe(202);
    expect(koed.log).toContain("control:interrupt");
    const run = (await call("GET", `/executions/${FAKE_IDS.codexExecution}`))
      .body;
    expect(run.needs.map((entry: any) => entry.command)).toEqual([
      "rm -rf build"
    ]);
  });
});

describe("phone workflow: scheduled jobs", () => {
  it("lists jobs and shows one with its runs", async () => {
    const { body } = await call("GET", "/jobs");
    expect(body.jobs.map((job: any) => job.title)).toEqual([
      "Morning brief",
      "Release check",
      "Docs link check"
    ]);
    const detail = (await call("GET", `/jobs/${FAKE_IDS.releaseCheck}`)).body;
    expect(detail.job).toMatchObject({
      title: "Release check",
      schedule: { kind: "weekdays", at: "09:00" }
    });
    expect(detail.runs).toHaveLength(7);
  });

  it("runs a job now", async () => {
    expect(
      (await call("POST", `/jobs/${FAKE_IDS.releaseCheck}/run-now`)).status
    ).toBe(202);
    expect(koed.log).toContain("runNow:Release check");
  });

  it("pauses and resumes a job", async () => {
    await call("POST", `/jobs/${FAKE_IDS.releaseCheck}/pause`, {
      paused: true
    });
    expect(
      (await call("GET", `/jobs/${FAKE_IDS.releaseCheck}`)).body.job.paused
    ).toBe(true);
    await call("POST", `/jobs/${FAKE_IDS.releaseCheck}/pause`, {
      paused: false
    });
    expect(koed.log).toEqual(
      expect.arrayContaining([
        "paused:Release check:true",
        "paused:Release check:false"
      ])
    );
  });

  it("changes a job's time, and refuses times Koed can't run", async () => {
    const changed = await call("POST", `/jobs/${FAKE_IDS.releaseCheck}/edit`, {
      schedule: { kind: "weekly", at: "08:15", tz: "Europe/Oslo", dow: [2, 4] }
    });
    expect(changed.status).toBe(200);
    expect(
      (await call("GET", `/jobs/${FAKE_IDS.releaseCheck}`)).body.job.schedule
    ).toEqual({ kind: "weekly", at: "08:15", tz: "Europe/Oslo", dow: [2, 4] });
    for (const schedule of [
      { kind: "hourly", at: "08:15", tz: "Europe/Oslo" },
      { kind: "daily", at: "25:00", tz: "Europe/Oslo" },
      { kind: "daily", at: "08:00", tz: "Mars/Olympus" }
    ])
      expect(
        (
          await call("POST", `/jobs/${FAKE_IDS.releaseCheck}/edit`, {
            schedule
          })
        ).status
      ).toBe(400);
  });

  it("runs a missed job now from the bell", async () => {
    expect(
      (
        await call(
          "POST",
          `/jobs/${FAKE_IDS.morningBrief}/runs/${FAKE_IDS.missedRun}/retry`
        )
      ).status
    ).toBe(200);
    expect(koed.log).toContain(`retry:${FAKE_IDS.missedRun}`);
    await until(
      home,
      (value) => value.needs.every((entry: any) => entry.kind !== "missed"),
      35_000
    );
  }, 40_000);

  const proposal = async (): Promise<any> =>
    (await home()).needs.find((entry: any) => entry.kind === "job_proposal");

  it("shows a job Cooper proposes, and 'Not now' declines it", async () => {
    await call("POST", "/chief/messages", {
      text: "Every Monday at 8, summarise the open Koed GitHub issues",
      clientMessageId: crypto.randomUUID()
    });
    const proposed = await until(proposal, (value) => Boolean(value));
    expect(proposed).toMatchObject({
      action: "create",
      title: "Issue digest",
      schedule: { kind: "weekly", at: "08:00", dow: [1] },
      agentId: FAKE_IDS.chief
    });
    expect(
      (
        await call("POST", "/proposals/respond", {
          executionId: proposed.executionId,
          actionId: proposed.actionId,
          decision: "decline"
        })
      ).body.state
    ).toBe("declined");
    expect(await proposal()).toBeUndefined();
    expect(koed.log.some((entry) => entry.startsWith("create:"))).toBe(false);
  });

  it("schedules the job on approval, exactly once", async () => {
    await call("POST", "/chief/messages", {
      text: "Every Monday at 8, summarise the open Koed GitHub issues",
      clientMessageId: crypto.randomUUID()
    });
    const proposed = await until(proposal, (value) => Boolean(value));
    const approve = () =>
      call("POST", "/proposals/respond", {
        executionId: proposed.executionId,
        actionId: proposed.actionId,
        decision: "approve"
      });
    expect((await approve()).body).toEqual({
      accepted: true,
      state: "applied"
    });
    // A second tap (or the Mac) can't create it again.
    expect((await approve()).body).toEqual({
      accepted: true,
      state: "applied"
    });
    expect(
      koed.log.filter((entry) => entry === "create:Issue digest")
    ).toHaveLength(1);
    const { body } = await call("GET", "/jobs");
    expect(body.jobs.map((job: any) => job.title)).toContain("Issue digest");
    expect(await proposal()).toBeUndefined();
  });
});

describe("phone workflow: memory, ranks and editions", () => {
  it("answers a question from Koed's memory", async () => {
    const asked = await call("POST", "/ask", {
      query: "What did we decide about webhook retries?",
      clientRequestId: crypto.randomUUID()
    });
    expect(asked.status).toBe(202);
    expect(asked.body.status).toBe("pending");
    const turns = await until(
      () =>
        call("GET", `/ask/${asked.body.askThreadId}`).then(
          (reply) => reply.body.turns
        ),
      (value) => value[0]?.status === "answered"
    );
    expect(turns[0].answerMarkdown).toContain("exponential backoff");
  });

  it("shows the collection: earned editions, progress, ranks", async () => {
    const { body } = await call("GET", "/collection");
    const edition = (id: string) =>
      body.editions.find((entry: any) => entry.id === id);
    expect(edition("graphite")).toMatchObject({ earned: true, isNew: true });
    expect(edition("lumen")).toMatchObject({ earned: true }); // 4 jobs scheduled now
    expect(edition("nightshift")).toMatchObject({ earned: true });
    expect(edition("goldie")).toMatchObject({
      earned: false,
      progress: { current: 4, target: 5 }
    });
    // Two unblocks so far (an allow and an answer; a decline doesn't count).
    expect(edition("glass").progress).toEqual({ current: 2, target: 10 });
    expect(edition("prism").progress).toEqual({ current: 1, target: 15 });
    expect(body.agents[0]).toMatchObject({ name: "Cooper" });
  });

  it("counts the Chief's replies towards its rank", async () => {
    const cooper = (await home()).chief.standing;
    expect(cooper.jobsFinished).toBeGreaterThanOrEqual(5);
    expect(cooper.rank).toBe("Trusted hand");
  });

  it("gives an earned edition to an agent, and takes it back", async () => {
    const give = await call("PUT", "/editions/graphite", {
      agentId: FAKE_IDS.rex
    });
    expect(give.status).toBe(200);
    const rex = (await home()).agents.find(
      (agent: any) => agent.name === "Rex"
    );
    expect(rex.standing.editionId).toBe("graphite");
    expect(rex.look.palette).toEqual({ base: "#8b9099", grayscale: true });
    expect(rex.standing.ownLook.palette).toEqual({ base: "#d9573b" });
    expect(rex.look.seed).toBe("rex-reviews");
    expect(
      (await call("PUT", "/editions/goldie", { agentId: FAKE_IDS.rex })).status
    ).toBe(409);
    await call("PUT", "/editions/graphite", { agentId: null });
    const after = (await home()).agents.find(
      (agent: any) => agent.name === "Rex"
    );
    expect(after.standing.editionId).toBeNull();
    expect(after.look.palette).toEqual({ base: "#d9573b" });
  });

  it("marks an unlock as seen", async () => {
    await call("POST", "/editions/nightshift/seen");
    const { body } = await call("GET", "/collection");
    expect(
      body.editions.find((entry: any) => entry.id === "nightshift").isNew
    ).toBe(false);
  });
});

describe("phone workflow: push and unpairing", () => {
  it("accepts an Expo push token and refuses anything else", async () => {
    expect(
      (
        await call("PUT", "/push", {
          expoPushToken: "ExponentPushToken[abcdefgh1234]"
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call("PUT", "/push", {
          expoPushToken: "https://evil.example/hook"
        })
      ).status
    ).toBe(400);
  });

  it("pushes to a phone that isn't open when something needs it", async () => {
    pushes.length = 0;
    koed.addApproval(["git", "merge", "main"], "Merge the fix");
    const sent = await until(
      async () => pushes,
      (value) => value.length > 0
    );
    expect(sent[0]).toMatchObject({
      to: "ExponentPushToken[abcdefgh1234]",
      title: "Needs your OK (Face ID)",
      body: "git merge main",
      route: "/notifications"
    });
  });

  it("removes a phone from the Mac: its token stops working and its stream is told", async () => {
    const status = await gateway.status();
    const pixel = status.phones.find((phone) => phone.name === "Pixel")!;
    expect(pixel).toBeDefined();
    const stream = listen(pixelToken);
    await until(
      async () =>
        (await gateway.status()).phones.find((phone) => phone.id === pixel.id),
      (phone) => Boolean(phone?.connected)
    );
    await gateway.revoke(pixel.id);
    expect((await gateway.status()).phones.map((phone) => phone.name)).toEqual([
      "Jacobo's iPhone"
    ]);
    await until(
      async () => stream.events,
      (events) =>
        events.some(
          (event) => event.type === "changed" && event.keys.includes("session")
        )
    );
    stream.close();
    expect((await call("GET", "/home", undefined, pixelToken)).status).toBe(
      401
    );
  });

  it("unpairs from the phone", async () => {
    expect((await call("DELETE", "/session")).status).toBe(200);
    expect((await call("GET", "/home")).status).toBe(401);
    expect((await gateway.status()).phones).toEqual([]);
  });
});

describe("phone workflow: health", () => {
  it("logged no errors other than the stale answer it was asked to refuse", () => {
    const messages = errors.map((cause) =>
      cause instanceof Error ? cause.message : String(cause)
    );
    expect(
      messages.filter((message) => message !== "That item is gone")
    ).toEqual([]);
  });
});

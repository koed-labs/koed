/**
 * The Desktop phone gateway: lets the Koed phone app steer Koed on this Mac.
 *
 * Off until the person turns on phone access in Settings › Phone. Then it
 * listens on this Mac's private network addresses, pairs phones with a QR
 * code, serves the phone API (./contract.ts) through ./service.ts, streams
 * live changes, and pushes what needs the person to phones that aren't open.
 */
import { randomUUID } from "node:crypto";
import { listPersonalDevicePairingNetworkAddresses } from "../personal-device-pairing-network.js";
import type { PdsDesktopSecretStore } from "../pds-secure-provider.js";
import {
  PHONE_API_VERSION,
  type PhoneLiveEvent,
  type PhoneNeed
} from "./contract.js";
import {
  createPhonePairing,
  pairingLink,
  type PairingOfferView
} from "./pairing.js";
import {
  createExpoPushSender,
  type PhonePush,
  type PushSender
} from "./push.js";
import {
  startPhoneGatewayListener,
  type PhoneGatewayListener
} from "./server.js";
import {
  createGamificationStore,
  type GamificationEvent,
  type GamificationStore
} from "./gamification.js";
import {
  createPhoneGatewayService,
  PhoneGatewayError,
  type PhoneGatewayDeps
} from "./service.js";
import {
  createPhoneGatewayStore,
  hashPhoneToken,
  MAXIMUM_PAIRED_PHONES,
  newPhoneToken,
  type PhoneGatewayStore
} from "./store.js";

export type PhoneGatewayStatus = {
  enabled: boolean;
  listening: string[];
  error: string | null;
  phones: Array<{
    id: string;
    name: string;
    platform: string;
    pairedAt: string;
    lastSeenAt: string | null;
    push: boolean;
    connected: boolean;
  }>;
  pairing: PairingOfferView | null;
};

export type PhoneGatewayOptions = {
  deps: PhoneGatewayDeps;
  secrets: PdsDesktopSecretStore;
  /** Which addresses to listen on. Defaults to this Mac's private IPv4 addresses (LAN and Tailscale). */
  hosts?: () => string[];
  push?: PushSender;
  onStatusChange?: (status: PhoneGatewayStatus) => void;
  onError?: (error: unknown) => void;
  /** How often to look for new approvals and replies while a phone listens (ms). */
  pollMs?: number;
  /** Personal Memory change feed (new captured events, Ask answers). */
  subscribePersonalMemory?: (
    listener: (change: {
      type: string;
      eventRefs?: Array<{ projectId: string; threadId: string }>;
    }) => void,
    signal: AbortSignal
  ) => Promise<void>;
  store?: PhoneGatewayStore;
  gamification?: GamificationStore;
};

export type PhoneGateway = ReturnType<typeof createPhoneGateway>;

export const createPhoneGateway = (options: PhoneGatewayOptions) => {
  const store = options.store ?? createPhoneGatewayStore(options.secrets);
  const service = createPhoneGatewayService(
    options.deps,
    store,
    options.gamification ?? createGamificationStore(options.secrets)
  );
  const pairing = createPhonePairing();
  const pushSender = options.push ?? createExpoPushSender();
  const hosts =
    options.hosts ?? (() => listPersonalDevicePairingNetworkAddresses());
  const pollMs = options.pollMs ?? 3_000;

  let listener: PhoneGatewayListener | null = null;
  let error: string | null = null;
  let listening: string[] = [];
  const subscribers = new Map<string, Set<(event: PhoneLiveEvent) => void>>();

  /* ---------- status ---------- */

  const status = async (): Promise<PhoneGatewayStatus> => {
    const state = await store.read();
    const offer = pairing.current();
    return {
      enabled: state.enabled,
      listening,
      error,
      phones: state.phones.map((phone) => ({
        id: phone.id,
        name: phone.name,
        platform: phone.platform,
        pairedAt: phone.createdAt,
        lastSeenAt: phone.lastSeenAt,
        push: Boolean(phone.expoPushToken),
        connected: (subscribers.get(phone.id)?.size ?? 0) > 0
      })),
      pairing:
        offer && listening.length
          ? {
              link: pairingLink({
                macName: options.deps.macName(),
                urls: listening,
                secret: offer.secret
              }),
              code: offer.code,
              addresses: listening.map((url) => url.replace(/^http:\/\//u, "")),
              expiresAt: new Date(offer.expiresAt).toISOString()
            }
          : null
    };
  };

  const changed = () => {
    if (!options.onStatusChange) return;
    void status().then(options.onStatusChange, () => undefined);
  };

  /* ---------- live events and push ---------- */

  const broadcast = (event: PhoneLiveEvent) => {
    for (const listeners of subscribers.values())
      for (const send of listeners) send(event);
  };

  const pushToAbsent = async (pushes: Array<Omit<PhonePush, "to">>) => {
    if (pushes.length === 0) return;
    const state = await store.read();
    const messages = state.phones
      .filter(
        (phone) =>
          phone.expoPushToken && (subscribers.get(phone.id)?.size ?? 0) === 0
      )
      .flatMap((phone) =>
        pushes.map((push) => ({ ...push, to: phone.expoPushToken! }))
      );
    if (messages.length === 0) return;
    try {
      await pushSender(messages);
    } catch (cause) {
      options.onError?.(cause);
    }
  };

  /** Ranks, milestones and editions newly earned: tell the phone, once. */
  const reward = async (events: GamificationEvent[]) => {
    if (events.length === 0) return;
    const pushes: Array<Omit<PhonePush, "to">> = [];
    for (const event of events) {
      const notification =
        event.kind === "edition"
          ? {
              title: `You earned ${event.name}`,
              body: "A limited edition. Give it to one of your agents.",
              route: "/collection"
            }
          : event.kind === "rank"
            ? {
                title: `${event.agentName} is now ${event.rank === "Getting acquainted" ? event.rank.toLowerCase() : `${/^[AEIOU]/u.test(event.rank) ? "an" : "a"} ${event.rank}`}`,
                body: `${event.jobs} job${event.jobs === 1 ? "" : "s"} finished together.`,
                route: "/collection"
              }
            : {
                title: `${event.agentName} reached a milestone`,
                body: event.title,
                route: "/collection"
              };
      broadcast({
        type: "notification",
        notification: {
          id: randomUUID(),
          kind: "reward",
          ...notification,
          ...(event.kind === "edition" ? {} : { agentId: event.agentId })
        }
      });
      if (event.kind === "edition")
        broadcast({ type: "unlock", editionId: event.editionId });
      pushes.push(notification);
    }
    broadcast({ type: "changed", keys: ["collection", "home", "chief"] });
    await pushToAbsent(pushes);
  };

  // Something the phone did may have earned a rank, milestone or edition: look soon, once.
  let rewardTimer: ReturnType<typeof setTimeout> | null = null;
  service.onProgress(() => {
    if (rewardTimer) return;
    rewardTimer = setTimeout(() => {
      rewardTimer = null;
      void service
        .evaluateGamification()
        .then(reward)
        .catch((cause: unknown) => options.onError?.(cause));
    }, 1_500);
  });

  let watcher: { stop: () => void; poke: () => void } | null = null;

  const startWatcher = () => {
    if (watcher) return;
    const controller = new AbortController();
    let known: Set<string> | null = null;
    let idleSince = Date.now();
    let lastSignature = "";
    let busyChief = false;
    let lastEvaluated = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const describe = (need: PhoneNeed): Omit<PhonePush, "to"> =>
      need.kind === "job_proposal"
        ? {
            title:
              need.action === "create"
                ? "Schedule a job?"
                : need.action === "pause"
                  ? "Pause a job?"
                  : "Turn a job back on?",
            body: need.title,
            route: "/notifications"
          }
        : need.kind === "missed"
          ? {
              title: "A job didn't run",
              body: `${need.jobTitle} was due while your Mac was asleep.`,
              route: "/notifications"
            }
          : need.kind === "question"
            ? {
                title: "A question for you",
                body: need.title,
                route: "/notifications"
              }
            : {
                title: need.risky ? "Needs your OK (Face ID)" : "Needs your OK",
                body: need.command ?? need.title,
                route: "/notifications"
              };

    const tick = async () => {
      const state = await store.read();
      const listening = [...subscribers.values()].some((set) => set.size > 0);
      const pushable = state.phones.some((phone) => phone.expoPushToken);
      if (!listening && !pushable) {
        // Nobody to tell. When someone is again, what appeared since now is new to them.
        known = null;
        idleSince = Date.now();
        return;
      }
      try {
        const home = await service.home();
        const ids = new Set(home.needs.map((need) => need.id));
        const fresh = known
          ? home.needs.filter((need) => !known!.has(need.id))
          : home.needs.filter((need) => Date.parse(need.at) >= idleSince);
        known = ids;
        const signature = JSON.stringify([
          [...ids].sort(),
          home.working
            .map((entry) => `${entry.executionId}:${entry.busy}`)
            .sort(),
          home.upcoming.map((entry) => entry.jobId)
        ]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          broadcast({ type: "changed", keys: ["chief", "home"] });
        }
        for (const need of fresh) {
          const push = describe(need);
          broadcast({
            type: "notification",
            notification: {
              id: need.id,
              kind:
                need.kind === "job_proposal"
                  ? "approval"
                  : need.kind === "missed"
                    ? "missed"
                    : need.kind,
              title: push.title,
              body: push.body,
              route: push.route
            }
          });
        }
        await pushToAbsent(fresh.map(describe));
        // The Chief of Staff finished a turn: tell a phone that isn't open.
        const chiefRef = home.chiefConversation;
        const chiefBusy = Boolean(
          chiefRef &&
          home.working.some(
            (entry) =>
              entry.busy && entry.conversation?.threadId === chiefRef.threadId
          )
        );
        const replied = busyChief && !chiefBusy;
        // Remember the new state first: a failure below must never count the same reply twice.
        busyChief = chiefBusy;
        if (replied) {
          lastEvaluated = 0;
          broadcast({ type: "changed", keys: ["chief", "home"] });
          await pushToAbsent([
            {
              title: home.chief?.name ?? "Your Chief of Staff",
              body: "Replied to you.",
              route: "/"
            }
          ]);
        }
        if (Date.now() - lastEvaluated > 30_000) {
          lastEvaluated = Date.now();
          await reward(await service.evaluateGamification());
        }
      } catch (cause) {
        options.onError?.(cause);
      }
    };

    let running = false;
    const loop = async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } finally {
        running = false;
      }
      if (timer) clearTimeout(timer);
      if (!controller.signal.aborted)
        timer = setTimeout(
          () => void loop(),
          [...subscribers.values()].some((set) => set.size > 0)
            ? pollMs
            : pollMs * 5
        );
    };
    void loop();

    if (options.subscribePersonalMemory) {
      void options
        .subscribePersonalMemory((change) => {
          service.invalidate();
          if (change.type === "conversation_events_changed") {
            const keys = new Set(["chief"]);
            for (const ref of change.eventRefs ?? [])
              keys.add(`conversation:${ref.projectId}:${ref.threadId}`);
            broadcast({ type: "changed", keys: [...keys] });
          } else if (change.type === "ask_questions_changed") {
            broadcast({ type: "changed", keys: ["ask"] });
          }
        }, controller.signal)
        .catch((cause: unknown) => options.onError?.(cause));
    }

    watcher = {
      /** Look now (a phone just connected or set up push), not at the next poll. */
      poke: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        void loop();
      },
      stop: () => {
        controller.abort();
        if (timer) clearTimeout(timer);
        watcher = null;
      }
    };
  };

  service.onDeliveryFailure((reason) => {
    broadcast({
      type: "notification",
      notification: {
        id: randomUUID(),
        kind: "result",
        title: "Your message wasn't sent",
        body: reason,
        route: "/"
      }
    });
    broadcast({ type: "changed", keys: ["chief"] });
  });

  /* ---------- listener lifecycle ---------- */

  const listen = async () => {
    if (listener) return;
    const state = await store.read();
    const addresses = hosts();
    if (addresses.length === 0) {
      error =
        "This Mac isn't on a private network (Wi-Fi or Tailscale), so a phone can't reach it.";
      listening = [];
      changed();
      return;
    }
    try {
      listener = await startPhoneGatewayListener({
        hosts: addresses,
        port: state.port,
        onError: options.onError,
        routes: {
          hello: () => ({
            app: "koed",
            api: PHONE_API_VERSION,
            name: options.deps.macName(),
            pairing: Boolean(pairing.current())
          }),
          pair: async (request) => {
            const outcome = pairing.redeem({
              secret: request.secret,
              code: request.code
            });
            if (outcome === "expired")
              throw new PhoneGatewayError(
                410,
                "That pairing code has expired. Show a new one in Koed on your Mac: Settings › Phone."
              );
            if (outcome !== "ok")
              throw new PhoneGatewayError(
                403,
                "That code doesn't match. Check it in Koed on your Mac."
              );
            const token = newPhoneToken();
            const phoneId = randomUUID();
            await store.update((current) => {
              if (current.phones.length >= MAXIMUM_PAIRED_PHONES)
                throw new PhoneGatewayError(
                  409,
                  "Too many phones are paired. Remove one in Settings › Phone."
                );
              return {
                ...current,
                phones: [
                  ...current.phones,
                  {
                    id: phoneId,
                    name: request.deviceName,
                    platform: request.platform,
                    tokenHash: hashPhoneToken(token),
                    createdAt: new Date().toISOString(),
                    lastSeenAt: null,
                    expoPushToken: null
                  }
                ]
              };
            });
            changed();
            return { token, phoneId, macName: options.deps.macName() };
          },
          authenticate: async (token) => {
            const phone = await store.phoneForToken(token);
            if (
              phone &&
              (!phone.lastSeenAt ||
                Date.now() - Date.parse(phone.lastSeenAt) > 60_000)
            ) {
              const seen = new Date().toISOString();
              void store
                .update((current) => ({
                  ...current,
                  phones: current.phones.map((entry) =>
                    entry.id === phone.id
                      ? { ...entry, lastSeenAt: seen }
                      : entry
                  )
                }))
                .then(changed, () => undefined);
            }
            return phone;
          },
          service,
          setPushToken: async (phoneId, token) => {
            await store.update((current) => ({
              ...current,
              phones: current.phones.map((entry) =>
                entry.id === phoneId
                  ? { ...entry, expoPushToken: token }
                  : entry
              )
            }));
            changed();
            watcher?.poke();
          },
          unpair: async (phoneId) => {
            await revoke(phoneId);
          },
          subscribe: (phoneId, send) => {
            const set = subscribers.get(phoneId) ?? new Set();
            set.add(send);
            subscribers.set(phoneId, set);
            startWatcher();
            watcher?.poke();
            changed();
            return () => {
              set.delete(send);
              changed();
            };
          }
        }
      });
      listening = listener.addresses;
      error = null;
      startWatcher();
    } catch (cause) {
      listener = null;
      listening = [];
      error =
        cause instanceof Error &&
        /EADDRINUSE/u.test(
          String((cause as { code?: string }).code ?? cause.message)
        )
          ? `Port ${state.port} is in use by another app.`
          : "The phone gateway couldn't start on this Mac's network.";
      options.onError?.(cause);
    }
    changed();
  };

  const close = async () => {
    watcher?.stop();
    pairing.cancel();
    const current = listener;
    listener = null;
    listening = [];
    if (current) await current.close();
    changed();
  };

  async function revoke(phoneId: string) {
    await store.update((current) => ({
      ...current,
      phones: current.phones.filter((phone) => phone.id !== phoneId)
    }));
    for (const send of subscribers.get(phoneId) ?? [])
      send({ type: "changed", keys: ["session"] });
    subscribers.delete(phoneId);
    changed();
  }

  return {
    /** Start listening if phone access is on (call once the app is ready). */
    async start() {
      if ((await store.read()).enabled) await listen();
    },
    async stop() {
      await close();
    },
    status,
    async setEnabled(enabled: boolean) {
      await store.update((state) => ({ ...state, enabled }));
      if (enabled) await listen();
      else await close();
      return status();
    },
    async beginPairing() {
      if (!(await store.read()).enabled) await this.setEnabled(true);
      if (!listener)
        throw new Error(
          error ?? "Phone access isn't available on this network."
        );
      pairing.begin();
      changed();
      return status();
    },
    async cancelPairing() {
      pairing.cancel();
      changed();
      return status();
    },
    async revoke(phoneId: string) {
      await revoke(phoneId);
      return status();
    },
    /** Re-read network addresses (after Wi-Fi changes). */
    async restart() {
      await close();
      await this.start();
      return status();
    },
    service
  };
};

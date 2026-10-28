import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { soloEdition } from "../../edition.js";
import type { Agent } from "@koed/shared/agent-contract";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopApi } from "../../../types.js";
import type { CuratedMemoryDesktopApi } from "../../../ipc/curated-memory-protocol.js";
import type {
  HqOnboardingClient,
  HqOnboardingStatus
} from "../../../ipc/hq-onboarding-protocol.js";
import { HqOnboardingConversation } from "./HqOnboardingConversation.js";
import { createOnboardingMemoryDemoApi } from "./memory-demo.js";
import {
  initialHqOnboarding,
  readHqOnboarding,
  writeHqOnboarding,
  type HqOnboardingRecord
} from "./onboarding-preference.js";
import "./hq-onboarding.css";

const shapes = ["roundedBox", "sphere", "cuboid", "capsule"] as const;
const draftKey = (profileKey: string) =>
  `koed.hq.onboarding.v56.draft:${encodeURIComponent(profileKey)}`;
const storyKeys = [
  "welcome",
  "edition",
  "setup-started",
  "intro",
  "maker",
  "user",
  "name-reply",
  "three-things",
  "what-reply",
  "ai-about",
  "ai-ask",
  "scan-card",
  "scan-result",
  "manual-intro",
  "manual-card",
  "connecting-card",
  "routes",
  "after-models",
  "compare",
  "memory-ask",
  "memory-learning",
  "memory-explain",
  "routed-intro",
  "routed-card",
  "more-reply",
  "ways-intro",
  "ways",
  "nest-intro",
  "nest",
  "ways-ask",
  "solo-intro",
  "hire-preview",
  "invite-intro",
  "invite-preview",
  "summary",
  "start-ask",
  "skip-need-ai",
  "skip-wait-memory",
  "memory-status",
  "typing-guide"
] as const;
type StoryKey = (typeof storyKeys)[number];
export type StoryEvent = { key: StoryKey; value?: string };
// The first question is how Koed will be used; answering it starts Koed's
// own setup in the background while the person names their Chief of Staff.
const initialStory: StoryEvent[] = [{ key: "welcome" }, { key: "edition" }];
const editionChosen = (edition: "solo" | "team"): StoryEvent[] => [
  {
    key: "user",
    value: edition === "team" ? "With my team" : "Just me, on this Mac"
  },
  { key: "setup-started" },
  { key: "intro" },
  { key: "maker" }
];
// Drafts saved before the edition question existed start at the intro.
const legacyStory: StoryEvent[] = [
  { key: "welcome" },
  { key: "intro" },
  { key: "maker" }
];
const storyForRecord = (record: HqOnboardingRecord): StoryEvent[] => {
  const opening = record.edition
    ? [...initialStory, ...editionChosen(record.edition)]
    : (record.stage ?? 1) === 1
      ? initialStory
      : legacyStory;
  if ((record.stage ?? 1) === 1 || !record.chiefName.trim()) return opening;
  const accepted: StoryEvent[] = [
    ...opening,
    { key: "user", value: `I'll call you ${record.chiefName.trim()}.` },
    { key: "name-reply" },
    { key: "three-things" }
  ];
  if (record.stage === 2) return accepted;
  const ai: StoryEvent[] = [
    ...accepted,
    { key: "user", value: "Let's go" },
    { key: "ai-about" },
    { key: "ai-ask" }
  ];
  if (record.stage === 3)
    return [...ai, { key: "compare" }, { key: "memory-ask" }];
  return [
    ...ai,
    { key: "compare" },
    { key: "memory-ask" },
    { key: "ways-intro" },
    { key: "ways" },
    { key: "nest-intro" },
    { key: "nest" },
    { key: "ways-ask" }
  ];
};
const fresh = (): HqOnboardingRecord => ({
  ...initialHqOnboarding,
  lookSeed: crypto.randomUUID()
});
function readDraft(
  profileKey: string,
  ownerId: string | null
): { record: HqOnboardingRecord; story: StoryEvent[] } | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(draftKey(profileKey)) ?? "null"
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schemaVersion !== 1 ||
      (value.ownerId !== null && typeof value.ownerId !== "string") ||
      (value.ownerId !== null && value.ownerId !== ownerId)
    )
      return null;
    const draft = value.record as Partial<HqOnboardingRecord> | null;
    if (
      !draft ||
      typeof draft !== "object" ||
      Array.isArray(draft) ||
      !["software", "studying", "other"].includes(draft.role ?? "") ||
      typeof draft.roleAnswered !== "boolean" ||
      draft.completed !== false ||
      ![1, 2, 3, 4].includes(draft.stage ?? 0) ||
      typeof draft.chiefName !== "string" ||
      draft.chiefName.length > 120 ||
      typeof draft.lookSeed !== "string" ||
      draft.lookSeed.length > 128 ||
      !shapes.includes(draft.lookShape as (typeof shapes)[number]) ||
      !["none", "antenna", "sprout", "ears"].includes(
        draft.lookTop ?? "none"
      ) ||
      typeof draft.lookColor !== "string" ||
      !/^#[0-9a-fA-F]{6}$/.test(draft.lookColor) ||
      typeof draft.remember !== "boolean" ||
      (draft.edition != null && !["solo", "team"].includes(draft.edition)) ||
      (draft.memoryFact != null &&
        (typeof draft.memoryFact !== "string" ||
          draft.memoryFact.length > 240)) ||
      (draft.memoryDemoStatus != null &&
        !["saved", "pending", "answered", "failed"].includes(
          draft.memoryDemoStatus
        )) ||
      (draft.memoryDemoAnswer != null &&
        (typeof draft.memoryDemoAnswer !== "string" ||
          draft.memoryDemoAnswer.length > 5000)) ||
      (draft.hireName != null &&
        (typeof draft.hireName !== "string" || draft.hireName.length > 24)) ||
      (draft.hireRole != null &&
        (typeof draft.hireRole !== "string" || draft.hireRole.length > 40)) ||
      (draft.hireLookSeed != null &&
        (typeof draft.hireLookSeed !== "string" ||
          draft.hireLookSeed.length > 128)) ||
      (draft.hireLookColor != null &&
        (typeof draft.hireLookColor !== "string" ||
          !/^#[0-9a-fA-F]{6}$/.test(draft.hireLookColor))) ||
      (draft.hireRequestId != null &&
        (typeof draft.hireRequestId !== "string" ||
          draft.hireRequestId.length > 128)) ||
      (draft.hireAgentId != null &&
        (typeof draft.hireAgentId !== "string" ||
          draft.hireAgentId.length > 128)) ||
      !["rememberRequestId", "noteId", "memoryEventId", "proposalId"].every(
        (key) =>
          (draft as Record<string, unknown>)[key] === null ||
          typeof (draft as Record<string, unknown>)[key] === "string"
      )
    )
      return null;
    const story = value.story;
    if (
      story !== undefined &&
      (!Array.isArray(story) ||
        story.length > 80 ||
        !story.every(
          (item) =>
            item &&
            typeof item === "object" &&
            storyKeys.includes(item.key) &&
            (item.value === undefined ||
              (typeof item.value === "string" && item.value.length <= 240))
        ))
    )
      return null;
    const record = {
      ...draft,
      lookTop: draft.lookTop ?? "none",
      hireRequestId: draft.hireRequestId ?? null,
      hireAgentId: draft.hireAgentId ?? null,
      hireName: draft.hireName ?? "Quinn",
      hireRole: draft.hireRole ?? "Tests",
      hireLookSeed: draft.hireLookSeed ?? "onboarding-quinn",
      hireLookColor: draft.hireLookColor ?? "#5fd6a0"
    } as HqOnboardingRecord;
    return { record, story: story ?? storyForRecord(record) };
  } catch {
    return null;
  }
}
function clientReady(client: HqOnboardingClient): boolean {
  return client.selected && client.installed && client.authenticated === "yes";
}
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function HqOnboarding({
  ownerId,
  profileKey,
  agentsApi,
  localAiClients,
  personalMemoryApi,
  memoryDemoApi,
  onComplete
}: {
  ownerId?: string;
  profileKey?: string;
  agentsApi?: DesktopApi["agents"];
  localAiClients?: DesktopApi["localAiClients"];
  personalMemoryApi?: PersonalDesktopApi;
  curatedMemoryApi?: CuratedMemoryDesktopApi;
  memoryDemoApi?: {
    run: (
      text: string,
      idempotencyKey: string
    ) => Promise<{
      noteId: string;
      status: "saved" | "pending" | "answered" | "failed";
      answer?: string;
      citations?: string[];
      error?: string;
    }>;
  };
  onComplete: (record: HqOnboardingRecord) => void | Promise<void>;
}) {
  const [status, setStatus] = useState<HqOnboardingStatus | null>(null);
  const [record, setRecord] = useState<HqOnboardingRecord>(fresh);
  const [story, setStory] = useState<StoryEvent[]>(initialStory);
  const storyRef = useRef<StoryEvent[]>(initialStory);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const hiring = useRef(false);
  const completionReported = useRef(false);
  const prepareRequested = useRef(false);
  const contextRef = useRef("");
  const activeProfile = status?.profileKey || profileKey || null;
  const activeOwner =
    status?.ownerId && (!ownerId || status.ownerId === ownerId)
      ? status.ownerId
      : null;
  const liveProfile =
    ownerId && status?.ownerId === ownerId && profileKey ? profileKey : null;
  const stage = record.stage ?? 1;
  const identity = JSON.stringify([activeProfile, activeOwner]);
  contextRef.current = JSON.stringify([activeProfile, activeOwner, ownerId]);
  const resolvedMemoryDemoApi = useMemo(() => {
    if (memoryDemoApi) return memoryDemoApi;
    if (!personalMemoryApi) return undefined;
    const context = contextRef.current;
    return createOnboardingMemoryDemoApi(
      personalMemoryApi,
      () => alive.current && contextRef.current === context
    );
  }, [memoryDemoApi, personalMemoryApi, activeOwner, activeProfile, ownerId]);

  const refreshStatus = useCallback(async () => {
    const context = contextRef.current;
    if (!window.koedDesktop?.invoke)
      throw new Error(
        "Local onboarding is unavailable in this desktop window."
      );
    const next = await window.koedDesktop.invoke<HqOnboardingStatus>(
      "hq_onboarding_status"
    );
    if (alive.current && context === contextRef.current) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshStatus().catch((cause) => {
      if (alive.current) setError(errorText(cause));
    });
    return () => {
      alive.current = false;
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!activeProfile || loadedKey === identity) return;
    const saved = activeOwner
      ? readHqOnboarding(activeOwner, activeProfile)
      : null;
    const existingLive =
      activeOwner && liveProfile
        ? readHqOnboarding(activeOwner, liveProfile)
        : null;
    const draft = readDraft(activeProfile, activeOwner);
    const next = existingLive?.completed
      ? existingLive
      : saved?.completed
        ? saved
        : (draft?.record ?? saved ?? fresh());
    const nextStory =
      draft?.record === next ? draft.story : storyForRecord(next);
    storyRef.current = nextStory;
    setStory(nextStory);
    setRecord({ ...next, lookSeed: next.lookSeed || crypto.randomUUID() });
    setLoadedKey(identity);
    completionReported.current = false;
    prepareRequested.current = false;
  }, [activeOwner, activeProfile, identity, liveProfile, loadedKey]);

  useEffect(() => {
    if (!activeProfile || !activeOwner || loadedKey !== identity) return;
    if (
      record.completed &&
      (status?.memoryState !== "ready" ||
        !status.clients.some(
          (client) => clientReady(client) && client.memoryConnected
        ))
    )
      return;
    const saved = readHqOnboarding(activeOwner, activeProfile);
    if (saved.completed && !record.completed) return;
    // The profile key is the bridge's stable local profile identity. Bind the
    // draft only to the exact owner announced for that profile.
    if (!writeHqOnboarding(activeOwner, activeProfile, record)) {
      setError("Your setup could not be saved on this device.");
      return;
    }
    try {
      localStorage.setItem(
        draftKey(activeProfile),
        JSON.stringify({
          schemaVersion: 1,
          ownerId: activeOwner,
          record,
          story: storyRef.current
        })
      );
    } catch {
      setError("Your setup could not be saved on this device.");
      return;
    }
    if (
      record.completed &&
      status?.memoryState === "ready" &&
      status.clients.some(
        (client) => clientReady(client) && client.memoryConnected
      ) &&
      !completionReported.current
    ) {
      completionReported.current = true;
      void Promise.resolve(onComplete(record)).catch((cause) => {
        if (alive.current) setError(errorText(cause));
      });
    }
  }, [
    activeOwner,
    activeProfile,
    identity,
    liveProfile,
    loadedKey,
    onComplete,
    record,
    status
  ]);

  useEffect(() => {
    if (status?.memoryState !== "preparing") return;
    const timer = setInterval(() => {
      void refreshStatus().catch((cause) => {
        if (alive.current) setError(errorText(cause));
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [refreshStatus, status?.memoryState]);

  const save = (next: HqOnboardingRecord) => {
    if (!activeProfile || loadedKey !== identity) {
      setError("Your local profile is still loading.");
      return false;
    }
    try {
      localStorage.setItem(
        draftKey(activeProfile),
        JSON.stringify({
          schemaVersion: 1,
          ownerId: activeOwner,
          record: next,
          story: storyRef.current
        })
      );
      if (activeOwner && !writeHqOnboarding(activeOwner, activeProfile, next))
        throw new Error("Your setup could not be saved on this device.");
      setRecord(next);
      setError(null);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  };
  const appendStory = (events: StoryEvent[], nextRecord = record) => {
    const nextStory = [...storyRef.current, ...events].slice(-80);
    storyRef.current = nextStory;
    setStory(nextStory);
    save(nextRecord);
  };

  const invokeAction = async (
    action:
      | "hq_onboarding_discover"
      | "hq_onboarding_connect"
      | "hq_onboarding_prepare_core"
      | "hq_onboarding_prepare_memory",
    args?: Record<string, unknown>
  ) => {
    if (working) return;
    const context = contextRef.current;
    setWorking(action);
    setError(null);
    try {
      if (!window.koedDesktop?.invoke)
        throw new Error("Local onboarding is unavailable.");
      const result = await window.koedDesktop.invoke<HqOnboardingStatus>(
        action,
        args
      );
      if (
        !alive.current ||
        context !== contextRef.current ||
        (activeProfile && result.profileKey !== activeProfile)
      )
        return;
      setStatus(result);
      return result;
    } catch (cause) {
      if (alive.current && context === contextRef.current) {
        setError(errorText(cause));
        if (action === "hq_onboarding_prepare_memory")
          setStatus((current) =>
            current
              ? {
                  ...current,
                  memoryState: "failed",
                  error: errorText(cause)
                }
              : current
          );
      }
    } finally {
      if (alive.current && context === contextRef.current) setWorking(null);
    }
  };

  const preview: Pick<Agent, "id" | "name" | "look"> = {
    id: "00000000-0000-4000-8000-000000000506",
    name: record.chiefName.trim() || "Your agent",
    look: {
      pixelkin: {
        seed: record.lookSeed,
        body: { shape: record.lookShape },
        palette: { base: record.lookColor },
        top: record.lookTop
      }
    }
  };
  const readyClients = status?.clients.filter(clientReady) ?? [];
  const connectedClients = readyClients.filter(
    (client) => client.memoryConnected
  );
  useEffect(() => {
    if (
      stage !== 3 ||
      status?.memoryState !== "not_started" ||
      !readyClients.length ||
      prepareRequested.current ||
      !loadedKey
    )
      return;
    prepareRequested.current = true;
    void invokeAction("hq_onboarding_prepare_memory", {
      operatorConsented: true
    });
  }, [stage, status?.memoryState, readyClients.length, loadedKey]);
  const canFinish =
    status?.memoryState === "ready" &&
    connectedClients.length > 0 &&
    Boolean(activeOwner && activeProfile && agentsApi && localAiClients);

  const finish = async () => {
    if (
      saving.current ||
      !canFinish ||
      !agentsApi ||
      !localAiClients ||
      !activeOwner ||
      !activeProfile
    )
      return;
    const name = record.chiefName.trim();
    if (!name) {
      setError("Give your agent a name first.");
      return;
    }
    saving.current = true;
    const context = contextRef.current;
    setWorking("finish");
    setError(null);
    try {
      const response = await localAiClients.list();
      if (!alive.current || contextRef.current !== context) return;
      const choice = response.readModel.defaults.conversations;
      const instance = response.readModel.instances.find(
        (item) =>
          item.enabled &&
          item.instanceId === choice.assignment?.ai_client_instance_id &&
          connectedClients.some((client) => client.driver === item.driverId)
      );
      if (!choice.available || !instance)
        throw new Error(
          "The selected AI Client is not the enabled conversation default. Choose it in AI settings and try again."
        );
      const chief = await agentsApi.ensureChief();
      if (!alive.current || contextRef.current !== context) return;
      if (!chief.isChiefOfStaff || chief.ownerUserId !== activeOwner)
        throw new Error("Chief of Staff owner identity changed.");
      const patched = await agentsApi.patch(chief.id, {
        name,
        look: preview.look,
        ...(chief.aiClientInstanceId !== instance.instanceId
          ? { aiClientInstanceId: instance.instanceId }
          : {})
      });
      if (!alive.current || contextRef.current !== context) return;
      if (!patched.isChiefOfStaff || patched.ownerUserId !== activeOwner)
        throw new Error("Chief of Staff owner identity changed.");
      const next = {
        ...record,
        completed: true,
        stage: 5 as const,
        chiefName: name
      };
      if (!save(next)) return;
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      saving.current = false;
      if (alive.current) setWorking(null);
    }
  };

  const action = async (key: string, value?: string) => {
    if (working || saving.current || hiring.current) return;
    const user = (text: string): StoryEvent => ({ key: "user", value: text });
    if (key === "retry-memory") {
      await invokeAction("hq_onboarding_prepare_memory", {
        operatorConsented: true
      });
      return;
    }
    if (key === "edition-solo" || key === "edition-team") {
      const edition = key === "edition-team" ? "team" : "solo";
      appendStory(editionChosen(edition), { ...record, edition });
      // Koed's own services take the longest to set up and need nothing from
      // the person: start them now, while they name their Chief of Staff.
      await invokeAction("hq_onboarding_prepare_core", {
        operatorConsented: true
      });
      return;
    }
    if (key === "text") {
      const typed = (value ?? "").trim().slice(0, 240);
      if (!typed) return;
      const last = storyRef.current.at(-1)?.key;
      if (last === "edition") return action("edition-solo");
      if (/^skip\b/i.test(typed)) return action("skip");
      if (stage === 1) {
        const name = typed
          .replace(
            /^(call (you|yourself)|your name is|you'?re|you are|name:?)\s+/i,
            ""
          )
          .replace(/[.!?"“”]/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(" ");
        if (name) return action("accept", name);
      }
      if (/what.*koed|who are you|what are you/i.test(typed))
        return action("what");
      if (last === "memory-ask" && status?.memoryState === "ready")
        return action("fact", typed);
      if (last === "ways-ask" && /\bsolo|hire\b/i.test(typed))
        return action("solo");
      if (last === "ways-ask" && /\binvite|people|team\b/i.test(typed))
        return action("invite");
      if (last === "solo-intro" && /\bhire|agent|create\b/i.test(typed))
        return action("hire");
      if (last === "invite-intro" && /\binvite|add|bring\b/i.test(typed))
        return action("invite-example");
      if (/^(yes|yeah|yep|ok|okay|sure|go|let'?s go|do it|y)\b/i.test(typed)) {
        const next: Partial<Record<StoryKey, string>> = {
          "three-things": "go",
          "what-reply": "go",
          "ai-ask": "scan",
          "scan-result": "connect",
          "after-models": "memory",
          "memory-explain": soloEdition() ? "summary" : "ways",
          "more-reply": soloEdition() ? "summary" : "ways",
          "ways-ask": "solo",
          "solo-intro": "hire",
          "invite-intro": "invite-example",
          "hire-preview": "summary",
          "invite-preview": "summary"
        };
        if (last && next[last]) return action(next[last]);
      }
      appendStory([user(typed), { key: "typing-guide" }]);
      return;
    }
    if (key === "accept") {
      const name = (value ?? record.chiefName).trim() || "Juno";
      appendStory(
        [
          user(`I'll call you ${name}.`),
          { key: "name-reply" },
          { key: "three-things" }
        ],
        {
          ...record,
          chiefName: name,
          role: "other",
          roleAnswered: true,
          stage: 2
        }
      );
      return;
    }
    if (key === "what") {
      appendStory([user("What is Koed?"), { key: "what-reply" }]);
      return;
    }
    if (key === "go") {
      appendStory([user("Let's go"), { key: "ai-about" }, { key: "ai-ask" }]);
      return;
    }
    if (key === "scan" || key === "manual") {
      appendStory(
        key === "scan"
          ? [user("Look for them"), { key: "scan-card" }]
          : [
              user("I'll add them myself"),
              { key: "manual-intro" },
              { key: "manual-card" }
            ]
      );
      const result = await invokeAction("hq_onboarding_discover");
      if (result && key === "scan") appendStory([{ key: "scan-result" }]);
      return;
    }
    if (key === "connect") {
      const drivers = value
        ? [value]
        : (status?.clients
            .filter(
              (client) =>
                client.installed &&
                client.authenticated === "yes" &&
                !client.selected
            )
            .map((client) => client.driver) ?? []);
      if (!drivers.length) return;
      appendStory([
        user(drivers.length === 1 ? "Connect it" : "Connect what you found"),
        { key: "connecting-card" }
      ]);
      let latest: HqOnboardingStatus | undefined;
      for (const driver of drivers) {
        latest = await invokeAction("hq_onboarding_connect", {
          driver,
          operatorConsented: true
        });
        if (!latest) return;
      }
      appendStory([{ key: "routes" }, { key: "after-models" }]);
      // The person just agreed to connect these AI Clients and let Koed
      // remember their sessions: start that now instead of at the Memory step.
      if (latest?.memoryState === "not_started")
        await invokeAction("hq_onboarding_prepare_memory", {
          operatorConsented: true
        });
      return;
    }
    if (key === "continue-ai") {
      appendStory([
        user("Continue"),
        { key: "routes" },
        { key: "after-models" }
      ]);
      return;
    }
    if (key === "memory") {
      appendStory(
        [user("Next: memory"), { key: "compare" }, { key: "memory-ask" }],
        { ...record, stage: 3 }
      );
      return;
    }
    if (key === "fact" || key === "retry-fact") {
      const fact = key === "retry-fact" ? record.memoryFact : value;
      if (!fact || status?.memoryState !== "ready") return;
      const id = record.memoryDemoRequestId ?? crypto.randomUUID();
      const nextRecord = {
        ...record,
        memoryFact: fact,
        memoryDemoRequestId: id
      };
      if (key === "fact") appendStory([user(fact)], nextRecord);
      setWorking("memory-demo");
      try {
        if (!resolvedMemoryDemoApi) {
          appendStory([{ key: "memory-learning" }, { key: "memory-explain" }], {
            ...nextRecord,
            memoryDemoStatus: "failed",
            memoryDemoAnswer: null
          });
          setError(
            "A live memory example is unavailable in this desktop profile."
          );
          return;
        }
        const context = contextRef.current;
        const result = await resolvedMemoryDemoApi.run(fact, id);
        if (!alive.current || context !== contextRef.current) return;
        const saved = {
          ...nextRecord,
          memoryDemoNoteId: result.noteId,
          memoryDemoStatus: result.status,
          memoryDemoAnswer: result.answer ?? null,
          memoryDemoCitations: result.citations ?? []
        };
        appendStory(
          result.status === "answered"
            ? [
                { key: "memory-learning" },
                { key: "routed-intro" },
                { key: "routed-card" },
                { key: "memory-explain" }
              ]
            : [{ key: "memory-learning" }, { key: "memory-explain" }],
          saved
        );
        if (result.error) setError(result.error);
      } catch (cause) {
        if (alive.current) {
          appendStory([{ key: "memory-learning" }, { key: "memory-explain" }], {
            ...nextRecord,
            memoryDemoStatus: "failed"
          });
          setError(errorText(cause));
        }
      } finally {
        if (alive.current) setWorking(null);
      }
      return;
    }
    if (key === "more") {
      appendStory([user("What else can it do?"), { key: "more-reply" }]);
      return;
    }
    if (key === "ways") {
      appendStory(
        [
          user("Next: working together"),
          { key: "ways-intro" },
          { key: "ways" },
          { key: "nest-intro" },
          { key: "nest" },
          { key: "ways-ask" }
        ],
        { ...record, stage: 4 }
      );
      return;
    }
    if (key === "solo") {
      appendStory([user("Solo: hire an agent"), { key: "solo-intro" }]);
      return;
    }
    if (key === "hire") {
      appendStory([
        user("Hire an agent to write tests for this Project"),
        { key: "hire-preview" }
      ]);
      return;
    }
    if (key === "hire-go") {
      if (!activeOwner || !agentsApi || !localAiClients || !canFinish) {
        setError("Local AI and memory must be ready before hiring an agent.");
        return;
      }
      const name = (record.hireName ?? "Quinn").trim();
      if (!name || name.length > 24) {
        setError("Give this agent a name of 24 characters or fewer.");
        return;
      }
      const context = contextRef.current;
      const requestId = record.hireRequestId ?? crypto.randomUUID();
      const next = { ...record, hireName: name, hireRequestId: requestId };
      hiring.current = true;
      setWorking("hire");
      try {
        let instanceId: string | null = null;
        if (!record.hireRequestId) {
          const response = await localAiClients.list();
          if (!alive.current || contextRef.current !== context) return;
          const choice = response.readModel.defaults.conversations;
          const instance = response.readModel.instances.find(
            (item) =>
              item.enabled &&
              item.instanceId === choice.assignment?.ai_client_instance_id &&
              connectedClients.some((client) => client.driver === item.driverId)
          );
          if (!choice.available || !instance)
            throw new Error(
              "Choose a selected AI Client as your conversation default first."
            );
          instanceId = instance.instanceId;
        }
        const existing = (await agentsApi.list()).find(
          (agent) =>
            agent.ownerUserId === activeOwner &&
            (agent.look as Record<string, unknown>).onboardingHireRequestId ===
              requestId
        );
        if (!alive.current || contextRef.current !== context) return;
        let hired = existing;
        if (!hired && !record.hireRequestId) {
          if (!save(next)) return;
          hired = await agentsApi.create({
            name,
            role: (record.hireRole ?? "Tests").trim() || null,
            look: {
              pixelkin: {
                seed: record.hireLookSeed ?? "onboarding-quinn",
                body: { shape: "roundedBox" },
                palette: { base: record.hireLookColor ?? "#5fd6a0" },
                top: "antenna"
              },
              onboardingHireRequestId: requestId
            },
            aiClientInstanceId: instanceId!,
            defaultPermissionMode: "supervised",
            defaultModel: null
          });
        }
        if (!alive.current || contextRef.current !== context) return;
        if (!hired || hired.ownerUserId !== activeOwner)
          throw new Error(
            "I could not confirm this agent. Try checking again."
          );
        save({ ...next, hireAgentId: hired.id });
      } catch (cause) {
        if (alive.current && contextRef.current === context)
          setError(errorText(cause));
      } finally {
        hiring.current = false;
        if (alive.current && contextRef.current === context) setWorking(null);
      }
      return;
    }
    if (key === "invite") {
      appendStory([
        user("With people: invite someone"),
        { key: "invite-intro" }
      ]);
      return;
    }
    if (key === "invite-example") {
      appendStory([
        user("Invite Mark to this Project"),
        { key: "invite-preview" }
      ]);
      return;
    }
    if (key === "summary") {
      appendStory([
        user(value ?? "Finish setup"),
        { key: "summary" },
        { key: "start-ask" }
      ]);
      return;
    }
    if (key === "start") {
      appendStory([user("Start using Koed")]);
      await finish();
      return;
    }
    if (key === "skip") {
      if (!readyClients.length) {
        appendStory([user("Skip setup"), { key: "skip-need-ai" }]);
      } else if (status?.memoryState !== "ready") {
        appendStory([user("Skip setup"), { key: "skip-wait-memory" }]);
      } else {
        await action("summary", "Skip the demos");
      }
    }
  };

  if (!status || loadedKey !== identity)
    return (
      <div role={error ? "alert" : "status"}>
        {error ?? "Opening your setup…"}
        {error ? (
          <button
            type="button"
            onClick={() =>
              void refreshStatus().catch((cause) => setError(errorText(cause)))
            }
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  return (
    <HqOnboardingConversation
      record={record}
      story={story}
      status={status}
      preview={preview}
      working={working}
      error={error}
      canFinish={canFinish}
      ownerMismatch={Boolean(
        ownerId && status?.ownerId && ownerId !== status.ownerId
      )}
      onChangeRecord={save}
      onAction={(key, value) => void action(key, value)}
      onRetryOpen={() => {
        if (completionReported.current)
          void Promise.resolve(onComplete(record))
            .then(() => setError(null))
            .catch((cause) => setError(errorText(cause)));
        else void finish();
      }}
    />
  );
}

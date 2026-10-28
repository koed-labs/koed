import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { soloEdition } from "../../edition.js";
import { SecureMarkdown } from "@koed/memory-ui";
import { createPortal } from "react-dom";
import type { Agent } from "@koed/shared/agent-contract";
import type {
  HqOnboardingClient,
  HqOnboardingStatus
} from "../../../ipc/hq-onboarding-protocol.js";
import { Pixelkin } from "../agents/Pixelkin.js";
import { createRendererPlatform } from "../../services/platform.js";
import type { HqOnboardingRecord } from "./onboarding-preference.js";
import type { StoryEvent } from "./HqOnboarding.js";

const steps = ["Your agent", "Your AI", "Memory", "Working together"];
const initialConversationLength = 3;
const shapes = ["roundedBox", "sphere", "cuboid", "capsule"] as const;
const tops = ["none", "antenna", "sprout", "ears"] as const;
const colors = [
  ["Violet", "#9d93fb"],
  ["Blue", "#62aef5"],
  ["Mint", "#5fd6a0"],
  ["Lime", "#bde05a"],
  ["Sun", "#ffc53f"],
  ["Coral", "#ff8268"],
  ["Pink", "#f476ab"],
  ["Slate", "#aeb3c2"]
] as const;
const names = ["Juno", "Atlas", "Pip", "Mika", "Orbit"];

function MemorySetupProgress({
  status,
  busy,
  onRetry
}: {
  status: HqOnboardingStatus | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const preparing = status?.memoryState === "preparing";
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preparing]);
  if (status?.memoryState === "failed")
    return (
      <div className="hq-onboarding__memory-progress">
        <p role="alert">
          Memory setup could not finish. Your selections are saved.
          {status.error ? ` ${status.error}` : ""}
        </p>
        <button
          type="button"
          className="hq-onboarding__primary"
          disabled={busy}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  if (!preparing) return null;
  const progress = status.progress;
  const seconds = progress
    ? Math.max(0, Math.floor((now - progress.startedAt) / 1000))
    : null;
  return (
    <div className="hq-onboarding__memory-progress" aria-busy="true">
      <p role="status">
        <span className="hq-onboarding__memory-spinner" aria-hidden="true" />
        Preparing local memory…
      </p>
      <p aria-live="polite">
        {progress?.message ?? "Checking what Memory needs…"}
      </p>
      <progress
        aria-label="Local memory setup progress"
        max={progress?.totalSteps ?? 1}
        value={progress?.completedSteps}
      />
      <small>
        {progress
          ? `${progress.completedSteps} of ${progress.totalSteps} setup steps complete. `
          : ""}
        No action needed.
        {seconds !== null ? (
          <span aria-hidden="true">
            {" "}
            {seconds < 60
              ? `${seconds}s`
              : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}{" "}
            elapsed.
          </span>
        ) : null}
      </small>
    </div>
  );
}
const clientName = (client: HqOnboardingClient): string =>
  client.driver === "codex"
    ? "Codex"
    : client.driver === "claude"
      ? "Claude Code"
      : "Pi";
const clientVia = (client: HqOnboardingClient): string =>
  client.driver === "codex"
    ? "via ChatGPT"
    : client.driver === "claude"
      ? "via Claude"
      : "via Pi";
const stateText = (client: HqOnboardingClient): string =>
  client.memoryConnected
    ? "Memory connected"
    : client.selected
      ? "Ready for memory setup"
      : client.installed && client.authenticated === "yes"
        ? "Signed in"
        : !client.installed
          ? "Not installed"
          : client.authenticated === "no"
            ? "Sign in first"
            : "Sign-in status unknown";

type Props = {
  record: HqOnboardingRecord;
  story: StoryEvent[];
  status: HqOnboardingStatus | null;
  preview: Pick<Agent, "id" | "name" | "look">;
  working: string | null;
  error: string | null;
  canFinish: boolean;
  ownerMismatch: boolean;
  onChangeRecord: (next: HqOnboardingRecord) => void;
  onAction: (key: string, value?: string) => void;
  onRetryOpen: () => void;
};

function ActionButtons({
  items,
  disabled,
  onAction
}: {
  items: [string, string, string?][];
  disabled?: boolean;
  onAction: Props["onAction"];
}) {
  return (
    <div className="hq-onboarding__actions">
      {items.map(([label, key, value], index) => (
        <button
          key={label}
          type="button"
          className={index === 0 ? "hq-onboarding__primary" : undefined}
          disabled={disabled}
          onClick={() => onAction(key, value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MakerCard({
  record,
  preview,
  accepted,
  working,
  onChangeRecord,
  onAction
}: Pick<
  Props,
  "record" | "preview" | "working" | "onChangeRecord" | "onAction"
> & {
  accepted: boolean;
}) {
  const variant = (
    shape = record.lookShape,
    top = record.lookTop
  ): Pick<Agent, "id" | "name" | "look"> => ({
    ...preview,
    look: {
      pixelkin: {
        seed: record.lookSeed,
        body: { shape },
        palette: { base: record.lookColor },
        top
      }
    }
  });
  if (accepted)
    return (
      <div className="hq-onboarding__card hq-onboarding__maker-done">
        <Pixelkin agent={preview} size={40} />
        <div>
          <strong>{record.chiefName}</strong>
          <small>Change my name or look any time in Settings.</small>
        </div>
      </div>
    );
  return (
    <div className="hq-onboarding__card hq-onboarding__maker">
      <div className="hq-onboarding__preview">
        <Pixelkin agent={preview} size={112} />
        <strong>{record.chiefName || " "}</strong>
      </div>
      <div className="hq-onboarding__controls">
        <label className="hq-onboarding__field">
          Name
          <input
            type="text"
            aria-label="Chief of Staff name"
            maxLength={24}
            disabled={Boolean(working)}
            placeholder="Give me a name"
            autoComplete="off"
            value={record.chiefName}
            onChange={(event) =>
              onChangeRecord({
                ...record,
                chiefName: event.target.value
              })
            }
          />
        </label>
        <div
          className="hq-onboarding__suggestions"
          aria-label="Suggested names"
        >
          {names.map((name) => (
            <button
              key={name}
              type="button"
              disabled={Boolean(working)}
              onClick={() => onChangeRecord({ ...record, chiefName: name })}
            >
              {name}
            </button>
          ))}
        </div>
        <fieldset>
          <legend>Shape</legend>
          <div className="hq-onboarding__shapes">
            {shapes.map((shape) => (
              <button
                key={shape}
                type="button"
                aria-label={`${shape} shape`}
                aria-pressed={record.lookShape === shape}
                disabled={Boolean(working)}
                onClick={() => onChangeRecord({ ...record, lookShape: shape })}
              >
                <Pixelkin agent={variant(shape)} size={34} />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Colour</legend>
          <div className="hq-onboarding__colors">
            {colors.map(([label, color]) => (
              <button
                key={color}
                type="button"
                aria-label={label}
                aria-pressed={record.lookColor === color}
                disabled={Boolean(working)}
                style={{ backgroundColor: color }}
                onClick={() => onChangeRecord({ ...record, lookColor: color })}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>On top</legend>
          <div className="hq-onboarding__shapes">
            {tops.map((top) => (
              <button
                key={top}
                type="button"
                aria-label={top === "none" ? "Nothing on top" : top}
                aria-pressed={record.lookTop === top}
                disabled={Boolean(working)}
                onClick={() => onChangeRecord({ ...record, lookTop: top })}
              >
                <Pixelkin agent={variant(record.lookShape, top)} size={34} />
              </button>
            ))}
          </div>
        </fieldset>
        <div className="hq-onboarding__maker-footer">
          <button
            type="button"
            className="hq-onboarding__primary"
            disabled={Boolean(working)}
            onClick={() => onAction("accept")}
          >
            That’s me
          </button>
          <button
            type="button"
            disabled={Boolean(working)}
            onClick={() =>
              onChangeRecord({ ...record, lookSeed: crypto.randomUUID() })
            }
          >
            Surprise me
          </button>
        </div>
      </div>
    </div>
  );
}

function ClientCard({
  status,
  manual,
  working,
  onAction
}: {
  status: Props["status"];
  manual?: boolean;
  working: Props["working"];
  onAction: Props["onAction"];
}) {
  return (
    <div className="hq-onboarding__card hq-onboarding__clients">
      {(status?.clients ?? []).map((client) => (
        <div className="hq-onboarding__client" key={client.driver}>
          <span className="hq-onboarding__client-mark">
            {clientName(client)[0]}
          </span>
          <div>
            <strong>{clientName(client)}</strong>
            <small>
              {clientVia(client)} · {stateText(client)}
            </small>
            {client.error ? <small role="alert">{client.error}</small> : null}
          </div>
          {manual &&
          client.installed &&
          client.authenticated === "yes" &&
          !client.selected ? (
            <button
              type="button"
              disabled={Boolean(working)}
              onClick={() => onAction("connect", client.driver)}
            >
              Connect
            </button>
          ) : (
            <span className="hq-onboarding__client-state">
              {client.memoryConnected
                ? "Connected"
                : client.selected
                  ? "Selected"
                  : client.authenticated === "yes"
                    ? "Signed in"
                    : "Waiting"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function CompareCard({ preview }: Pick<Props, "preview">) {
  const solo = soloEdition();
  const rows = [
    [
      "Starts every chat from zero",
      "Remembers your projects, decisions and how you like things done"
    ],
    [
      "Claude and ChatGPT each keep their own memory, if any",
      "One memory shared by every model and agent you use"
    ],
    [
      "You paste the same context again and again",
      "Drop a spec or doc once, and it’s used everywhere it matters"
    ],
    solo
      ? [
          "Your chats live on someone else’s servers",
          "Your memory stays on this Mac, and you can see, export or forget it"
        ]
      : [
          "Just you",
          "Your co-workers’ agents get what you choose to share when Team is available"
        ]
  ];
  return (
    <div className="hq-onboarding__card hq-onboarding__compare">
      <div className="hq-onboarding__compare-head">Your AI on its own</div>
      <div className="hq-onboarding__compare-head">
        <Pixelkin agent={preview} size={18} />
        Your AI with Koed
      </div>
      {rows.map(([before, after]) => (
        <div className="hq-onboarding__compare-row" key={before}>
          <span>{before}</span>
          <span>{after}</span>
        </div>
      ))}
    </div>
  );
}

function WaysCard({ preview }: Pick<Props, "preview">) {
  const sample = (
    seed: string,
    color: string,
    top: "none" | "antenna" | "ears"
  ) => ({
    ...preview,
    look: {
      pixelkin: {
        seed,
        body: { shape: "roundedBox" },
        palette: { base: color },
        top
      }
    }
  });
  return (
    <div className="hq-onboarding__ways">
      <div className="hq-onboarding__way">
        <div
          className="hq-onboarding__faces"
          aria-label="Illustrative solo team"
        >
          <span className="hq-onboarding__person hq-onboarding__person--you">
            J
          </span>
          <Pixelkin agent={preview} size={34} />
          <Pixelkin
            agent={sample("sample-builder", "#5fd6a0", "antenna")}
            size={34}
          />
          <Pixelkin
            agent={sample("sample-tester", "#ffc53f", "none")}
            size={34}
          />
        </div>
        <strong>Solo, with agents</strong>
        <p>
          You talk to me. I hire agents for the work, like a builder and a
          tester, and they run on your own AI.
        </p>
      </div>
      <div className="hq-onboarding__way">
        <div
          className="hq-onboarding__faces"
          aria-label="Illustrative people and agents"
        >
          <span className="hq-onboarding__person hq-onboarding__person--you">
            J
          </span>
          <span className="hq-onboarding__person hq-onboarding__person--mark">
            M
          </span>
          <span className="hq-onboarding__person hq-onboarding__person--colleague">
            C
          </span>
          <Pixelkin agent={preview} size={34} />
          <Pixelkin
            agent={sample("sample-colleague", "#ff8268", "ears")}
            size={34}
          />
        </div>
        <strong>With your co-workers</strong>
        <p>
          Invite the people you work with. Each brings their own agents. People
          decide, the agents coordinate.
        </p>
      </div>
    </div>
  );
}

function NestCard() {
  return (
    <div className="hq-onboarding__nest">
      <div className="hq-onboarding__box">
        <div className="hq-onboarding__box-title">
          <strong>Workspace</strong>
          <span>
            Koed team <small>(example)</small>
          </span>
        </div>
        <p>
          A team: its people and the memory everyone shares. Working solo, it’s
          just yours.
        </p>
        <div className="hq-onboarding__box-invite">
          <strong>Invite</strong>
          <span>
            Co-workers when Team is available. They see every shared Project.
          </span>
        </div>
        <div className="hq-onboarding__box">
          <div className="hq-onboarding__box-title">
            <strong>Project</strong>
            <span>koed-main</span>
          </div>
          <p>
            Ongoing work, like a product or a repo, with its own files and
            memory.
          </p>
          <div className="hq-onboarding__box-invite">
            <strong>Invite</strong>
            <span>
              Someone who works on this, and only this, when Team is available.
            </span>
          </div>
          <div className="hq-onboarding__box">
            <div className="hq-onboarding__box-title">
              <strong>Work item</strong>
              <span>Retry failed webhooks</span>
            </div>
            <p>
              One piece of work with a finish line. Its updates stay in the
              Project.
            </p>
            <div className="hq-onboarding__box-invite">
              <strong>Invite</strong>
              <span>
                Someone helping with this Work item when Team is available.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HqOnboardingConversation(props: Props) {
  const solo = soloEdition();
  const markdownAdapters = useMemo(() => {
    const platform = createRendererPlatform();
    return {
      openExternal: platform.openExternal,
      writeClipboard: platform.copyText
    };
  }, []);
  const endRef = useRef<HTMLDivElement>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [typed, setTyped] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteWhere, setInviteWhere] = useState("Project");
  const {
    record,
    story,
    status,
    preview,
    working,
    error,
    canFinish,
    ownerMismatch,
    onChangeRecord,
    onAction,
    onRetryOpen
  } = props;
  const stage = record.stage ?? 1;
  const selected = status?.clients.filter((client) => client.selected) ?? [];
  const submitTyped = () => {
    const text = typed.trim();
    if (!text || working) return;
    setTyped("");
    onAction("text", text);
  };
  const found =
    status?.clients.filter(
      (client) =>
        client.installed && client.authenticated === "yes" && !client.selected
    ) ?? [];
  const progress = (
    <div className="hq-onboarding__progress">
      <nav className="hq-onboarding__steps" aria-label="Setup progress">
        {(solo ? steps.slice(0, 3) : steps).map((label, index) => (
          <span className="hq-onboarding__step-wrap" key={label}>
            {index > 0 ? (
              <span className="hq-onboarding__step-line" aria-hidden="true" />
            ) : null}
            <span
              className="hq-onboarding__step"
              aria-current={stage === index + 1 ? "step" : undefined}
              data-done={stage > index + 1}
            >
              <i>{stage > index + 1 ? "✓" : index + 1}</i>
              <span>{label}</span>
            </span>
          </span>
        ))}
      </nav>
      {stage >= 2 && stage <= 4 ? (
        <button
          type="button"
          className="hq-onboarding__skip"
          onClick={() => onAction("skip")}
        >
          Skip setup
        </button>
      ) : null}
    </div>
  );
  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("hq-onboarding-progress"));
  }, []);
  useEffect(() => {
    if (story.length <= initialConversationLength) return;
    if (typeof endRef.current?.scrollIntoView === "function")
      endRef.current.scrollIntoView({ block: "end" });
  }, [story.length, status?.memoryState, working, record.completed]);

  const render = (event: StoryEvent, index: number) => {
    const current = index === story.length - 1;
    const buttons = (items: [string, string, string?][], disabled = false) =>
      current ? (
        <ActionButtons
          items={items}
          disabled={disabled || Boolean(working)}
          onAction={onAction}
        />
      ) : null;
    switch (event.key) {
      case "welcome":
        return (
          <>
            <div className="hq-onboarding__hello-avatar">
              <Pixelkin agent={preview} size={64} />
            </div>
            <p>
              Hi, welcome to <strong>Koed</strong>.
            </p>
          </>
        );
      case "edition":
        return (
          <>
            <p>
              First, how will you use Koed? This decides what I set up on this
              Mac.
            </p>
            <div className="hq-onboarding__actions">
              <button
                type="button"
                className="hq-onboarding__primary"
                disabled={Boolean(record.edition) || Boolean(working)}
                onClick={() => onAction("edition-solo")}
              >
                Just me, on this Mac
              </button>
              <button
                type="button"
                disabled={solo || Boolean(record.edition) || Boolean(working)}
                title={solo ? "Koed for teams is coming later." : undefined}
                onClick={() => onAction("edition-team")}
              >
                With my team{solo ? " (coming later)" : ""}
              </button>
            </div>
            <p className="hq-onboarding__fineprint">
              Everything runs on this Mac with the AI subscriptions you already
              have. Nothing is sent to a Koed server.
            </p>
          </>
        );
      case "setup-started":
        return (
          <p>
            Great. I'm setting Koed up on this Mac in the background: a local
            database and memory engine. It takes a few minutes the first time,
            so let's keep going meanwhile.
          </p>
        );
      case "intro":
        return (
          <div className="hq-onboarding__intro">
            <p>
              {solo
                ? "I'm your new agent. I'll be your chief of staff: I remember your work across your AI tools, so you never start from zero."
                : "I'm your new agent. I'll be your chief of staff: I run your other agents, remember your work, and bring people in when you want them."}
            </p>
            <p>
              But first, make me yours. What should I be called, and how should
              I look?
            </p>
          </div>
        );
      case "maker":
        return (
          <MakerCard
            record={record}
            preview={preview}
            accepted={stage > 1}
            working={working}
            onChangeRecord={onChangeRecord}
            onAction={onAction}
          />
        );
      case "user":
        return <p>{event.value}</p>;
      case "name-reply":
        return <p>{record.chiefName} it is. Nice to meet you.</p>;
      case "three-things":
        return (
          <>
            <p>Let's set you up. {solo ? "Two" : "Three"} quick things:</p>
            <ol>
              <li>
                <strong>Your AI.</strong> I run on the subscriptions you already
                pay for.
              </li>
              <li>
                <strong>Memory.</strong> What Koed remembers for you, and why
                that beats your AI on its own.
              </li>
              {solo ? null : (
                <li>
                  <strong>Working together.</strong> Just you and your agents,
                  or with your co-workers too.
                </li>
              )}
            </ol>
            {buttons([
              ["Let's go", "go"],
              ["What is Koed?", "what"]
            ])}
          </>
        );
      case "what-reply":
        return (
          <>
            <p>
              {solo
                ? "Koed gives the AI tools you already use one shared memory, kept on this Mac. I'm your chief of staff in it: I remember your work so you never start from zero."
                : "Koed is where you and your agents work. I'm your chief of staff in it: I run agents on your own AI subscriptions, Koed remembers your work so you never start from zero, and I bring your co-workers in when you want them."}
            </p>
            {buttons([["Let's go", "go"]])}
          </>
        );
      case "ai-about":
        return (
          <p>
            Koed doesn't come with its own AI. It runs on the ones you already
            pay for: <strong>Claude</strong>, <strong>ChatGPT</strong> and{" "}
            <strong>Pi</strong>, to start with. Bring your own model, and keep
            your own plan.
          </p>
        );
      case "ai-ask":
        return (
          <>
            <p>
              Can I look for them on this Mac? I only check what's installed and
              signed in. I never read your chats.
            </p>
            {buttons([
              ["Look for them", "scan"],
              ["I'll add them myself", "manual"]
            ])}
          </>
        );
      case "scan-card":
        return (
          <>
            <p>Looking on this Mac…</p>
            <ClientCard status={status} working={working} onAction={onAction} />
          </>
        );
      case "scan-result":
        return (
          <>
            <p>
              {found.length
                ? `Found ${found.length === 1 ? "one" : found.length === 2 ? "two" : "three"}: ${found.map((client) => `${clientName(client)} (${clientVia(client)})`).join(", ")}, signed in. Want me to connect ${found.length === 1 ? "it" : found.length === 2 ? "both" : "all three"}?`
                : selected.length
                  ? "Your AI Client is already selected. Ready to carry on?"
                  : "I didn't find a signed-in AI Client on this Mac. Sign in to one and I'll look again."}
            </p>
            {found.length ? (
              <div className="hq-onboarding__card hq-onboarding__consent">
                <strong>What connecting does</strong>
                <ul>
                  <li>
                    Adds Koed's memory tools and a capture hook to{" "}
                    {found.map(clientName).join(" and ")}.
                  </li>
                  <li>
                    From then on, your sessions with{" "}
                    {found.length === 1 ? "it" : "them"}, in any folder, are
                    saved to your memory on this Mac. Nothing leaves this Mac.
                  </li>
                  <li>
                    I also read your past sessions in the background, so your
                    Mac may be busier for a while the first time.
                  </li>
                  <li>
                    You can pause, export or forget any of it later in Settings.
                  </li>
                </ul>
              </div>
            ) : null}
            {buttons(
              found.length
                ? [
                    [
                      found.length === 1
                        ? "Connect and remember"
                        : found.length === 2
                          ? "Connect both and remember"
                          : "Connect all three and remember",
                      "connect"
                    ],
                    ["I'll add them myself", "manual"]
                  ]
                : selected.length
                  ? [
                      ["Continue", "continue-ai"],
                      ["Look for them", "scan"]
                    ]
                  : [
                      ["Look for them", "scan"],
                      ["I'll add them myself", "manual"]
                    ]
            )}
          </>
        );
      case "manual-intro":
        return (
          <p>
            Pick the ones you have. Sign in through the AI Client itself, so I
            never see your password.
          </p>
        );
      case "manual-card":
        return (
          <>
            <ClientCard
              status={status}
              manual
              working={working}
              onAction={onAction}
            />
            {buttons([["Look for them", "scan"]])}
          </>
        );
      case "connecting-card":
        return (
          <>
            <p>Connecting…</p>
            <ClientCard status={status} working={working} onAction={onAction} />
          </>
        );
      case "routes":
        return (
          <div className="hq-onboarding__card hq-onboarding__routes">
            <small>How I’ll use them</small>
            {selected.map((client) => (
              <div key={client.driver} className="hq-onboarding__client">
                <span className="hq-onboarding__client-mark">
                  {clientName(client)[0]}
                </span>
                <div>
                  <strong>{clientName(client)}</strong>
                  <small>{clientVia(client)} · selected for Koed memory</small>
                </div>
              </div>
            ))}
          </div>
        );
      case "after-models":
        return (
          <>
            <p>
              Done. You never have to pick a model: I choose the best one for
              each job. You can set defaults in Settings, or just say “use Codex
              for this”.
            </p>
            <p>Next, the part that makes Koed worth it.</p>
            {buttons([["Next: memory", "memory"]])}
          </>
        );
      case "compare":
        return (
          <>
            <p>Now the part your AI subscription can't do on its own.</p>
            <CompareCard preview={preview} />
          </>
        );
      case "memory-ask":
        return (
          <>
            <p>Let me show you. Tell me one thing about how you work.</p>
            <MemorySetupProgress
              status={status}
              busy={Boolean(working)}
              onRetry={() => onAction("retry-memory")}
            />
            {buttons(
              [
                ["Keep answers short", "fact", "Keep answers short"],
                [
                  "I build in Rust and Next.js",
                  "fact",
                  "I build in Rust and Next.js"
                ],
                ["I'm in Madrid, so CET", "fact", "I'm in Madrid, so CET"]
              ],
              status?.memoryState !== "ready"
            )}
          </>
        );
      case "memory-learning":
        return (
          <>
            <p>Got it.</p>
            <div className="hq-onboarding__memory-chip">
              <span>
                {record.memoryDemoNoteId
                  ? "Koed will remember"
                  : "Memory example not completed"}
              </span>
              <strong>{record.memoryFact}</strong>
            </div>
          </>
        );
      case "routed-intro":
        return (
          <p>
            Now watch. I'll ask{" "}
            <strong>
              {selected[0]
                ? `${clientName(selected[0])} ${clientVia(selected[0])}`
                : "your AI Client"}
            </strong>
            , which has never talked to you:
          </p>
        );
      case "routed-card":
        return (
          <div className="hq-onboarding__card hq-onboarding__routed">
            <div className="hq-onboarding__routed-question">
              You asked: Suggest a name for the setting that controls webhook
              retries.
            </div>
            <div className="hq-onboarding__routed-answer">
              <SecureMarkdown
                source={record.memoryDemoAnswer ?? ""}
                adapters={markdownAdapters}
              />
            </div>
            <div className="hq-onboarding__routed-by">
              <span className="hq-onboarding__routed-mark">
                {selected[0] ? clientName(selected[0])[0] : "AI"}
              </span>
              <span>Answered by your connected AI Client</span>
            </div>
            {record.memoryDemoCitations?.length ? (
              <small className="hq-onboarding__routed-sources">
                Sources: {record.memoryDemoCitations.join(", ")}
              </small>
            ) : null}
          </div>
        );
      case "memory-explain":
        return (
          <>
            <p>
              The same memory works with every AI Client you connect
              {solo ? "" : " and every agent you create"}. Over time Koed also
              remembers your projects, your decisions and the files you drop in,
              so nobody re-explains anything. You can see, change or forget any
              of it: just say “forget that”.
            </p>
            {buttons([
              solo
                ? ["Finish setup", "summary"]
                : ["Next: working together", "ways"],
              ["What else can it do?", "more"],
              ...(record.memoryDemoStatus !== "answered"
                ? [
                    ["Try the memory example again", "retry-fact"] as [
                      string,
                      string
                    ]
                  ]
                : [])
            ])}
          </>
        );
      case "more-reply":
        return (
          <>
            <p>A few things you get from one memory across everything:</p>
            <ul>
              <li>
                <strong>Pick up where you left off</strong>, days later, in any
                model.
              </li>
              <li>
                <strong>Hand work from Claude to Codex</strong> without
                re-explaining it.
              </li>
              <li>
                <strong>Agents that already know your code</strong>: your
                conventions, your tests, last week's decisions.
              </li>
              <li>
                <strong>Drop a spec once</strong>, and every agent on that
                Project uses it.
              </li>
              {solo ? (
                <li>
                  <strong>Everything stays on this Mac.</strong> Nothing is
                  shared or sent to a Koed server.
                </li>
              ) : (
                <li>
                  <strong>Share what you choose</strong> with your co-workers
                  when Team is available. The rest stays private.
                </li>
              )}
            </ul>
            {buttons([
              solo
                ? ["Finish setup", "summary"]
                : ["Next: working together", "ways"]
            ])}
          </>
        );
      case "ways-intro":
        return (
          <p>
            Last thing: how you work. Koed does both, and you can switch any
            time.
          </p>
        );
      case "ways":
        return <WaysCard preview={preview} />;
      case "nest-intro":
        return (
          <p>
            Everything lives in three places. Each one is a boundary for memory,
            and for who you invite:
          </p>
        );
      case "nest":
        return <NestCard />;
      case "ways-ask":
        return (
          <>
            <p>Want to see them in action?</p>
            {buttons([
              ["Solo: hire an agent", "solo"],
              ["With people: invite someone", "invite"],
              ["Skip the demos", "summary", "Skip the demos"]
            ])}
          </>
        );
      case "solo-intro":
        return (
          <>
            <p>
              Solo means you talk to me and I put agents to work. I usually hire
              one when a job needs it, but you can ask any time. Try it:
            </p>
            {buttons([
              ["Hire an agent to write tests for this Project", "hire"]
            ])}
          </>
        );
      case "hire-preview":
        return (
          <>
            <div className="hq-onboarding__card hq-onboarding__hire-card">
              <div className="hq-onboarding__hire-look">
                <Pixelkin
                  agent={{
                    ...preview,
                    look: {
                      pixelkin: {
                        seed: record.hireLookSeed ?? "onboarding-quinn",
                        body: { shape: "roundedBox" },
                        palette: { base: record.hireLookColor ?? "#5fd6a0" },
                        top: "antenna"
                      }
                    }
                  }}
                  size={104}
                />
                <button
                  type="button"
                  disabled={Boolean(
                    working || record.hireAgentId || record.hireRequestId
                  )}
                  onClick={() =>
                    onChangeRecord({
                      ...record,
                      hireLookSeed: crypto.randomUUID(),
                      hireLookColor:
                        colors[Math.floor(Math.random() * colors.length)]![1]
                    })
                  }
                >
                  New look
                </button>
              </div>
              <div className="hq-onboarding__hire-fields">
                <label>
                  Name
                  <input
                    maxLength={24}
                    value={record.hireName ?? "Quinn"}
                    disabled={Boolean(
                      working || record.hireAgentId || record.hireRequestId
                    )}
                    onChange={(event) =>
                      onChangeRecord({
                        ...record,
                        hireName: event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  Job title (optional)
                  <input
                    maxLength={40}
                    value={record.hireRole ?? "Tests"}
                    disabled={Boolean(
                      working || record.hireAgentId || record.hireRequestId
                    )}
                    onChange={(event) =>
                      onChangeRecord({
                        ...record,
                        hireRole: event.target.value
                      })
                    }
                  />
                </label>
                <div className="hq-onboarding__hire-line">
                  <span>Runs on</span>
                  <strong>
                    {status?.clients.find(
                      (client) => client.selected && client.memoryConnected
                    )?.name ?? "Your selected AI"}
                  </strong>
                </div>
                <div className="hq-onboarding__hire-line">
                  <span>Starts knowing</span>
                  <strong>Your Personal Memory</strong>
                </div>
                {record.hireAgentId ? (
                  <strong role="status">✓ Hired</strong>
                ) : (
                  <button
                    type="button"
                    className="hq-onboarding__primary"
                    disabled={Boolean(working) || !canFinish}
                    onClick={() => onAction("hire-go")}
                  >
                    {working === "hire"
                      ? "Hiring…"
                      : record.hireRequestId
                        ? "Check hire"
                        : "Hire"}
                  </button>
                )}
              </div>
            </div>
            {buttons([
              ["Now show me inviting people", "invite"],
              ["Finish setup", "summary"]
            ])}
          </>
        );
      case "invite-intro":
        return (
          <>
            <p>With people, inviting is one sentence too. Try it:</p>
            {buttons([["Invite Mark to this Project", "invite-example"]])}
          </>
        );
      case "invite-preview":
        return (
          <>
            <div className="hq-onboarding__card hq-onboarding__invite-card">
              <div>
                <span>Invite</span>
                <strong>Mark</strong>
              </div>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={inviteEmail}
                  placeholder="mark@example.com"
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </label>
              <div>
                <span>Where</span>
                <div
                  className="hq-onboarding__invite-segment"
                  role="group"
                  aria-label="Where to invite"
                >
                  {["Workspace", "Project", "Work item"].map((where) => (
                    <button
                      key={where}
                      type="button"
                      aria-pressed={inviteWhere === where}
                      onClick={() => setInviteWhere(where)}
                    >
                      {where}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span>To</span>
                <strong>
                  {inviteWhere === "Workspace"
                    ? "Your workspace"
                    : inviteWhere === "Project"
                      ? "A selected Project"
                      : "A selected Work item"}
                </strong>
              </div>
              <div>
                <span>They get</span>
                <strong>
                  Only the {inviteWhere.toLowerCase()} you choose and its shared
                  work.
                </strong>
              </div>
              <div>
                <span>Not shared</span>
                <strong>Your private notes, HQ chat and other Projects.</strong>
              </div>
              <footer>
                <span>Team invites are unavailable in local solo setup.</span>
                <button type="button" disabled>
                  Send invite
                </button>
              </footer>
            </div>
            {buttons([
              ["Now show me Solo", "solo"],
              ["Finish setup", "summary"]
            ])}
          </>
        );
      case "summary":
        return (
          <>
            <p>You're set.</p>
            <div className="hq-onboarding__card hq-onboarding__summary">
              <div className="hq-onboarding__summary-row">
                <Pixelkin agent={preview} size={24} />
                <span>
                  <strong>Your agent</strong>
                  <small>{record.chiefName}, your chief of staff</small>
                </span>
              </div>
              <div className="hq-onboarding__summary-row">
                <span className="hq-onboarding__summary-check">✓</span>
                <span>
                  <strong>Your AI</strong>
                  <small>
                    {selected.map(clientName).join(", ") ||
                      "No verified AI Client yet"}
                  </small>
                </span>
              </div>
              <div className="hq-onboarding__summary-row">
                <span className="hq-onboarding__summary-check">✓</span>
                <span>
                  <strong>Memory</strong>
                  <small>
                    {record.memoryDemoNoteId && record.memoryFact
                      ? `On. Remembers “${record.memoryFact}”`
                      : status?.memoryState === "ready"
                        ? "On"
                        : "Preparing"}
                  </small>
                </span>
              </div>
              <div className="hq-onboarding__summary-row">
                <span className="hq-onboarding__summary-check">✓</span>
                <span>
                  <strong>Working</strong>
                  <small>
                    {record.hireAgentId
                      ? `Solo, with ${record.hireName ?? "your hired agent"} (${record.hireRole ?? "Agent"})`
                      : solo
                        ? `Solo, with ${record.chiefName || "your chief of staff"}`
                        : "Solo. I’ll hire agents when a job needs them."}
                  </small>
                </span>
              </div>
            </div>
          </>
        );
      case "start-ask":
        return (
          <>
            <p>What do you want to get done first?</p>
            {buttons([["Start using Koed", "start"]], !canFinish)}
          </>
        );
      case "skip-need-ai":
        return (
          <>
            <p>
              I need at least one AI to do anything for you. Connect one and you
              can skip the rest.
            </p>
            {buttons([
              ["Look for them", "scan"],
              ["I'll add them myself", "manual"]
            ])}
          </>
        );
      case "skip-wait-memory":
        return (
          <>
            <p>
              Memory is still getting ready. I'll carry on as soon as the local
              connection is verified.
            </p>
            {buttons([["Next: memory", "memory"]])}
          </>
        );
      case "memory-status":
        return (
          <p role="status">
            {status?.memoryState === "ready"
              ? "Local memory is ready."
              : "Preparing local memory…"}
          </p>
        );
      case "typing-guide":
        return (
          <p>
            Let's finish setup first, it only takes a minute. Tap a button
            above, or say “skip”.
          </p>
        );
    }
  };

  return (
    <section className="hq-onboarding" aria-label="Getting started with Koed">
      {headerSlot ? createPortal(progress, headerSlot) : progress}
      <div className="hq-onboarding__scroll">
        <div
          className="hq-onboarding__body"
          role="log"
          aria-label="Setup conversation"
        >
          {story.map((event, index) => (
            <div
              key={index}
              className={
                event.key === "user"
                  ? "hq-onboarding__user-message"
                  : `hq-onboarding__message hq-onboarding__message--${event.key}`
              }
            >
              {event.key !== "user" && event.key !== "welcome" ? (
                <div className="hq-onboarding__avatar">
                  {story[index - 1]?.key === "user" ? (
                    <Pixelkin agent={preview} size={24} />
                  ) : null}
                </div>
              ) : event.key === "welcome" ? (
                <div />
              ) : null}
              <div className="hq-onboarding__message-content">
                {render(event, index)}
              </div>
            </div>
          ))}
          {error &&
          (stage === 5 || story.at(-1)?.value === "Start using Koed") ? (
            <button type="button" onClick={onRetryOpen}>
              Try opening Koed again
            </button>
          ) : null}
          {error ? (
            <p className="hq-onboarding__error" role="alert">
              {error}
            </p>
          ) : null}
          {ownerMismatch ? (
            <p role="alert">
              The local profile belongs to a different owner. Setup cannot
              finish in this profile.
            </p>
          ) : null}
          {working === "hire" ? (
            <p role="status" aria-live="polite">
              Hiring {record.hireName || "your agent"}…
            </p>
          ) : null}
          {(working === "finish" || record.completed) && !error ? (
            <p role="status" aria-live="polite">
              Opening Koed…
            </p>
          ) : null}
          <div ref={endRef} aria-hidden="true" />
        </div>
      </div>
      <div className="hq-onboarding__dock">
        <div className="hq-onboarding__composer">
          <textarea
            aria-label="Message your agent during setup"
            placeholder={
              stage === 1
                ? "Type a name, or pick one above"
                : stage === 3 && status?.memoryState === "failed"
                  ? "Retry Memory setup to continue"
                  : stage === 3 && status?.memoryState !== "ready"
                    ? "Memory is getting ready…"
                    : "Type here, or tap a button"
            }
            value={typed}
            rows={1}
            disabled={
              Boolean(working) ||
              stage === 5 ||
              (stage === 3 && status?.memoryState !== "ready")
            }
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitTyped();
              }
            }}
          />
          <div className="hq-onboarding__composer-row">
            <button
              type="button"
              aria-label="Attachments available after setup"
              title="Attachments available after setup"
              disabled
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2l-8.8 8.8a5 5 0 0 1-7.1-7.1l9-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="hq-onboarding__send"
              aria-label="Send setup message"
              disabled={
                !typed.trim() ||
                Boolean(working) ||
                stage === 5 ||
                (stage === 3 && status?.memoryState !== "ready")
              }
              onClick={submitTyped}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 19V5m0 0-6 6m6-6 6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

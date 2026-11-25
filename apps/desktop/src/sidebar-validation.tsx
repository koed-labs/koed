/** Browser-only validation entry; never imported by the packaged application. */
import { useMemo, useState } from "react";
import { NavigationShell } from "./renderer/v1/NavigationShell.js";
import { useDesktopKin } from "./renderer/floating-kin/DesktopKin.js";
import type { DesktopKinBridge } from "./ipc/floating-kin-protocol.js";
import type { AccountDesktopApi } from "@koed-labs/shared/account";
import {
  buildProjectSidebar,
  matchesSidebarConversation,
  sidebarGroups
} from "./renderer/v1/project-sidebar-model.js";
import { useNavigationHistory } from "./renderer/v1/use-navigation-history.js";
import { V1ConversationSurface } from "./renderer/v1/runtime.js";
import type { DesktopConversationEvent } from "./desktop-conversation.js";
import type {
  DesktopProject,
  DesktopThreadGroup
} from "./project-memory-ui.js";
const base = Date.now();
const thread = (
  id: string,
  name: string,
  minutes: number,
  sourceAiClient: "codex" | "claude-code" | "pi"
) => ({
  id,
  sessionId: id,
  name,
  latestAt: new Date(base - minutes * 60000).toISOString(),
  sourceAiClient,
  eventCount: 1,
  invalidatedCount: 0,
  sample: ""
});
// `?kin=1` docks a tracked Conversation under the Kin so Electron checks can
// click its sidebar marker and panel. Summaries never resolve; the count of
// requests shows whether a click reached the Summarize button.
declare global {
  interface Window {
    __kinSummaryRequests?: number;
  }
}
const kinEnabled = new URLSearchParams(location.search).has("kin");
const kinBridge: DesktopKinBridge = {
  onPresentation: (listener) => {
    listener({ placement: "sidebar", revision: 0 });
    return () => {};
  },
  setShellVisible: () => {},
  onOpenAiModels: () => () => {},
  onOpenConversation: () => () => {},
  confirmPresentation: () => {},
  activity: async () => ({
    state: "running",
    overflowCount: 0,
    conversations: [
      {
        sessionId: "bundle",
        client: "codex",
        projectId: "koed",
        lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString()
      }
    ]
  }),
  preview: async () => ({
    title: "And this bundling would be considered safe",
    projectName: "koed",
    request: {
      text: "Is the bundled runtime safe to ship?",
      occurredAt: new Date().toISOString()
    },
    reply: null
  }),
  summarize: () => {
    window.__kinSummaryRequests = (window.__kinSummaryRequests ?? 0) + 1;
    return new Promise(() => {});
  },
  latest: async () => ({ action: null }),
  reopen: async () => null,
  cancel: async () => {}
};
const fixtures = [
  {
    id: "koed",
    name: "koed",
    namedProject: { projectId: "koed" },
    threads: [
      thread(
        "bundle",
        "And this bundling would be considered safe",
        2,
        "codex"
      ),
      thread("privacy", "Fix Privacy Filter Installer Error", 5, "codex"),
      thread(
        "configure",
        "Verify claude:configure Desktop Setup",
        120,
        "claude-code"
      ),
      thread("embedding", "Embedding State Diagnostics", 120, "pi"),
      thread("checklist", "Checklist Recall Comparison", 18720, "codex")
    ]
  },
  {
    id: "android",
    name: "koed_voice_android_poc",
    namedProject: { projectId: "android" },
    threads: [
      thread("android-setup", "Set Up Android Voice PoC", 15, "codex"),
      thread("android-build", "Validate Android PoC APK Build", 20, "codex")
    ]
  },
  {
    id: "other",
    name: "No project",
    threads: [
      thread("notebook", "The second notebook is called…", 18720, "claude-code")
    ]
  },
  {
    id: "staking",
    name: "staking-vesting-contracts",
    namedProject: { projectId: "staking" },
    threads: []
  }
] as DesktopProject[];
export function SidebarValidation({
  accountApi
}: {
  accountApi?: AccountDesktopApi;
}) {
  const [source, setSource] = useState(fixtures);
  const [scope, setScope] = useState("sidebar-validation-owner");
  const [light, setLight] = useState(false);
  const [notice, setNotice] = useState("");
  const navigation = useNavigationHistory(scope);
  const kin = useDesktopKin(kinEnabled ? kinBridge : undefined, scope, true);
  const groups = buildProjectSidebar(source, [], new Map());
  const route = navigation.route;
  const origin =
    route.kind === "conversation"
      ? sidebarGroups(groups).find((group) => group.id === route.originGroupId)
      : undefined;
  const current =
    route.kind === "conversation"
      ? (
          origin?.conversations ??
          groups.flatMap((group) => group.conversations)
        ).find((row) => matchesSidebarConversation(route, row))
      : undefined;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          height: 32,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "0 14px",
          fontSize: 11,
          background: "#0c0c0f",
          color: "#a1a1aa"
        }}
      >
        <span>Production sidebar validation</span>
        <button
          onClick={() => {
            document.documentElement.classList.toggle("light", !light);
            setLight(!light);
          }}
        >
          Toggle theme
        </button>
        <button
          onClick={() =>
            setSource((previous) =>
              previous.map((project) =>
                project.id === "android"
                  ? {
                      ...project,
                      threads: project.threads.map((row, index) =>
                        index
                          ? row
                          : { ...row, latestAt: new Date().toISOString() }
                      )
                    }
                  : project
              )
            )
          }
        >
          Simulate ingestion
        </button>
        <button
          onClick={() =>
            setScope((value) =>
              value.endsWith("owner")
                ? "sidebar-validation-other"
                : "sidebar-validation-owner"
            )
          }
        >
          Switch owner
        </button>
        {notice && <span role="status">{notice}</span>}
      </header>
      <NavigationShell
        accountApi={accountApi}
        projects={groups}
        route={navigation.route}
        scopeKey={scope}
        title={current?.title}
        projectName={current?.projectName}
        onSelect={navigation.navigate}
        onHome={() => navigation.navigate({ kind: "home" })}
        onSettings={() =>
          setNotice("Settings opens the existing Settings view")
        }
        onBack={navigation.back}
        onForward={navigation.forward}
        canGoBack={navigation.canGoBack}
        canGoForward={navigation.canGoForward}
        onRetry={() => {}}
        kinAvatar={kin.avatar}
        kinChips={kin.chips}
        kinLive={kin.live}
        kinPanel={kin.panel}
      >
        {current ? (
          <ValidationConversation
            key={current.key}
            title={current.title}
            id={current.key}
          />
        ) : (
          <p>Choose a conversation to validate navigation.</p>
        )}
      </NavigationShell>
    </div>
  );
}

function ValidationConversation({ id, title }: { id: string; title: string }) {
  const events = useMemo<DesktopConversationEvent[]>(
    () =>
      Array.from({ length: 80 }, (_, index) => {
        const content =
          index % 2 === 0
            ? `Message ${index + 1}: ${title}. Please check the next part of this conversation.`
            : `Message ${index + 1}: ${title}.\n\nThis captured response is part of a long conversation used to verify scrolling. The viewer should keep its own scroll area inside the available pane, so earlier messages remain reachable after loading and resizing.\n\n${index % 5 === 0 ? "```text\n" + "long-output ".repeat(40) + "\n```" : "You can scroll upward to review earlier messages and downward to return to the latest response."}`;
        return {
          id: `${id}:${index}`,
          actor: index % 2 === 0 ? "user" : "assistant",
          eventType: "message",
          timestamp: new Date(base + index * 60000).toISOString(),
          sourceEventTime: null,
          sourceSequence: index,
          content,
          contentPreview: content,
          invalidatedAt: null,
          metadata: {}
        };
      }),
    [id, title]
  );
  const thread: DesktopThreadGroup = {
    id,
    sessionId: id,
    name: title,
    projectId: "validation",
    projectName: "Validation",
    eventCount: events.length,
    invalidatedCount: 0,
    latestAt: events.at(-1)!.timestamp,
    sample: ""
  };
  return (
    <div className="personal-conversation-shell">
      <div className="personal-conversation-body">
        <div className="personal-conversation-timeline">
          <V1ConversationSurface
            thread={thread}
            model={{
              events,
              error: "",
              hasOlderEvents: false,
              status: "ready"
            }}
            onLoadOlder={() => {}}
            onRetry={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

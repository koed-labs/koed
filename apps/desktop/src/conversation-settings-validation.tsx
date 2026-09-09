// Browser-only fixture using the production controls. No real runtime or persistence.
import { useEffect, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { AppShell } from "./renderer/shell/AppShell.js";
import {
  ConversationSettings,
  selectionForInstance
} from "./renderer/views/personal/ConversationSettings.js";
import { NewConversationComposer } from "./renderer/views/personal/NewConversationComposer.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions
} from "./ipc/managed-conversation-protocol.js";
import "./renderer/app.css";
import "./renderer/views/personal/personal-memory.css";

const options: ManagedConversationLaunchOptions = {
  runners: [
    {
      kind: "local_device",
      deviceId: "fixture-device",
      deploymentId: "fixture-deployment",
      displayName: "This device"
    }
  ],
  instances: [
    {
      driverId: "codex",
      instanceId: "codex.default",
      displayName: "Codex",
      ready: true,
      readiness: "ready",
      models: [
        {
          id: "gpt-sol",
          displayName: "GPT-5.6 Sol",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
          isDefault: true
        },
        {
          id: "gpt-astra",
          displayName: "GPT-6 Astra",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high"
        }
      ],
      capabilities: {
        defaultPermissionMode: "full_access",
        permissionModes: ["supervised", "auto_edit", "auto", "full_access"].map(
          (mode) => ({
            mode: mode as "supervised" | "auto_edit" | "auto" | "full_access",
            support: "supported"
          })
        )
      }
    },
    {
      driverId: "claude",
      instanceId: "claude.default",
      displayName: "Claude Code",
      ready: false,
      readiness: "authentication_required",
      models: [],
      capabilities: { defaultPermissionMode: "supervised", permissionModes: [] }
    }
  ]
};
const noop = () => undefined;
const api = {
  start: async () => ({
    operation: "start",
    status: "starting",
    executionId: "fixture-execution"
  }),
  send: async () => ({ operation: "send", status: "queued" }),
  writeDraft: async () => ({ operation: "draft_write", ok: true }),
  deleteDraft: async () => ({ operation: "draft_delete", ok: true })
} as unknown as ManagedConversationDesktopApi;

export function ConversationSettingsValidation() {
  const [selection, setSelection] = useState(() =>
    selectionForInstance(options, "codex.default")
  );
  const [scenario, setScenario] = useState("idle");
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);
  return (
    <AppShell
      activeScope="personal"
      identityLabel="Browser fixture"
      inspectorOpen={false}
      canGoBack={false}
      canGoForward={false}
      onActivateInbox={noop}
      onActivatePersonal={noop}
      onActivateTeam={noop}
      onAddTeam={noop}
      onCloseInspector={noop}
      onGoBack={noop}
      onGoForward={noop}
      onOpenHealth={noop}
      onOpenCommandPalette={noop}
      onOpenDevices={noop}
      onOpenPreferences={noop}
      onToggleInspector={noop}
      personalUnreadCount={0}
      scopeLine={<span>Personal / Projects / koed</span>}
      teamCollaborationEnabled={false}
      teams={[]}
      routeFocusKey="conversation-settings-validation"
      contextNavigation={
        <div style={{ padding: 24 }}>
          <h2>Personal</h2>
          <p style={{ marginTop: 24 }}>Projects</p>
          <p>koed</p>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            display: "flex",
            gap: 16,
            padding: 16,
            borderBottom: "1px solid var(--border)",
            fontSize: 12
          }}
        >
          <span>Browser fixture · production controls</span>
          {["new", "idle", "working"].map((value) => (
            <button
              key={value}
              aria-pressed={scenario === value}
              onClick={() => setScenario(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div style={{ padding: 28, flex: 1 }}>
          <h2 style={{ fontSize: 22 }}>Conversation configuration</h2>
          <p style={{ marginTop: 32 }}>
            Make Conversation settings easier to see and adjust as you work.
          </p>
        </div>
        {scenario === "new" ? (
          <NewConversationComposer
            api={api}
            projectId="fixture-project"
            options={options}
            selection={selection}
            onChange={setSelection}
            onStarted={() => setScenario("working")}
          />
        ) : (
          <div className="personal-managed-composer" style={{ border: 0 }}>
            <div className="personal-managed-composer-field conversation-input">
              <label>
                <span className="sr-only">Message</span>
                <textarea
                  placeholder="Ask for follow-up changes…"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <div className="conversation-input-footer">
                <ConversationSettings
                  options={options}
                  selection={selection}
                  onChange={setSelection}
                  clientLocked
                  disabledReason={
                    scenario === "working"
                      ? "Settings are available when this turn finishes."
                      : undefined
                  }
                />
                <button
                  className="conversation-send"
                  aria-label={
                    scenario === "working" ? "Stop turn" : "Send message"
                  }
                  onClick={() => {
                    setScenario(scenario === "working" ? "idle" : "working");
                    setPrompt("");
                  }}
                >
                  {scenario === "working" ? <Square /> : <ArrowUp />}
                </button>
              </div>
            </div>
            <div
              className="personal-managed-meta-row"
              style={{ justifyContent: "flex-end" }}
            >
              This device
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

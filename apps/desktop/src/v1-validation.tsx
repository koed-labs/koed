import { AccountValidation } from "./account-validation.js";
import { SidebarValidation } from "./sidebar-validation.js";
import {
  installProjectManagementValidation,
  ProjectManagementValidation
} from "./project-management-validation.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ModelPicker,
  V1Composer,
  V1EmptyHero,
  DEFAULT_AGENT_LOOK,
  type V1ModelSelection
} from "./renderer/v1/visual.js";
import { V1App } from "./renderer/v1/App.js";
import { Home } from "./renderer/v1/home/Home.js";
import { NavigationShell } from "./renderer/v1/NavigationShell.js";
import { V1Onboarding } from "./renderer/v1/onboarding.js";
import { installOnboardingValidation } from "./onboarding-validation.js";
import { DesktopStatusStore } from "./renderer/services/desktop-commands.js";
import "./renderer/index.css";
import "./renderer/v1/app.css";

const validation =
  new URLSearchParams(location.search).get("onboarding") === "1"
    ? installOnboardingValidation()
    : null;
const statusStore = new DesktopStatusStore();
if (new URLSearchParams(location.search).get("projects") === "1")
  installProjectManagementValidation();
const providers = [
  {
    id: "codex",
    label: "Codex",
    models: [
      {
        id: "model-example",
        label: "Example model",
        description: "Validation fixture",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium"
      }
    ]
  }
];
function FullAppValidation() {
  const [backendComplete, setBackendComplete] = useState(
    localStorage.getItem("onboarding-backend-complete") === "true"
  );
  return (
    <V1App
      statusStore={statusStore}
      onboardingComplete={backendComplete}
      completeOnboarding={async () => {
        localStorage.setItem("onboarding-backend-complete", "true");
        setBackendComplete(true);
      }}
    />
  );
}
function Validation() {
  const [selection, setSelection] = useState<V1ModelSelection>({
    providerId: "codex",
    modelId: "model-example",
    effort: "medium"
  });
  const [text, setText] = useState("");
  const [onboarding, setOnboarding] = useState(
    new URLSearchParams(location.search).get("onboarding") === "1"
  );
  const composer = (
    <V1Composer
      value={text}
      onChange={setText}
      onSend={() => setText("")}
      modelPicker={
        <ModelPicker
          providers={providers}
          selection={selection}
          onChange={setSelection}
        />
      }
    />
  );
  if (onboarding)
    return (
      <V1Onboarding
        statusStore={statusStore}
        savedDraft={
          validation?.scene === "clients"
            ? { version: 2, step: "clients" }
            : validation?.scene === "hardware"
              ? { version: 2, step: "hardware" }
              : undefined
        }
        onSaveDraft={async (draft) => {
          if (validation) validation.fixture.draft = draft;
        }}
        onSaveAgent={async (agent) => {
          if (validation) validation.fixture.savedAgent = agent;
        }}
        onComplete={async () => {
          if (validation) validation.fixture.complete = true;
          setOnboarding(false);
        }}
      />
    );
  return (
    <NavigationShell
      projects={[]}
      route={{ kind: "home" }}
      scopeKey="v1-presentation-validation"
      onSelect={() => {}}
      onHome={() => setOnboarding(false)}
      onSettings={() => {}}
      onBack={() => {}}
      onForward={() => {}}
      canGoBack={false}
      canGoForward={false}
      onRetry={() => {}}
    >
      <V1EmptyHero
        agentName="Juno"
        look={DEFAULT_AGENT_LOOK}
        composer={composer}
      />
    </NavigationShell>
  );
}
if (new URLSearchParams(location.search).get("sidebar") !== "1")
  document.documentElement.classList.add("light");
createRoot(document.querySelector("#root")!).render(
  new URLSearchParams(location.search).has("account") ? (
    <AccountValidation />
  ) : new URLSearchParams(location.search).get("projects") === "1" ? (
    <ProjectManagementValidation />
  ) : new URLSearchParams(location.search).get("sidebar") === "1" ? (
    <SidebarValidation />
  ) : new URLSearchParams(location.search).get("home") === "1" ? (
    // Home's stage with Projects and loose Conversations on the floor.
    <div className="v1-app" style={{ display: "flex", height: "100%" }}>
      <Home
        view={{ kind: "projects", warnings: [] }}
        clients={[]}
        agent={{ name: "Koed", look: DEFAULT_AGENT_LOOK }}
        statusStore={statusStore}
        onOpenProject={() => undefined}
        entries={["koed", "koed-site", "kin-engine"].map((id, i) => ({
          id,
          name: id,
          eventCount: 40 - i * 10,
          latestAt: new Date(Date.now() - i * 3_600_000).toISOString()
        }))}
        looseConversations={Array.from({ length: 14 }, (_, i) => ({
          key: `loose-${i}`,
          title: `Loose Conversation ${i + 1}`,
          latestAt: new Date(
            Date.now() - [0.1, 3, 45][i % 3]! * 86_400_000
          ).toISOString(),
          client: (["claude", "codex", "pi", null] as const)[i % 4]!
        }))}
        onOpenConversation={() => undefined}
      />
    </div>
  ) : new URLSearchParams(location.search).get("full") === "1" ? (
    <FullAppValidation />
  ) : (
    <Validation />
  )
);

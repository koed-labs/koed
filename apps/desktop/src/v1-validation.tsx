import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ModelPicker,
  V1Composer,
  V1EmptyHero,
  V1Shell,
  DEFAULT_AGENT_LOOK,
  type V1ModelSelection
} from "./renderer/v1/visual.js";
import { V1Onboarding } from "./renderer/v1/onboarding.js";
import { DesktopStatusStore } from "./renderer/services/desktop-commands.js";
import "./renderer/index.css";
import "./renderer/v1/app.css";

const statusStore = new DesktopStatusStore();
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
  return (
    <V1Shell
      title={onboarding ? "Getting started" : ""}
      accountLabel="Local user"
      onAccount={() => {}}
      onNewConversation={() => setOnboarding(false)}
      onNewProject={() => {}}
      onHome={() => setOnboarding(false)}
      groups={[]}
    >
      {onboarding ? (
        <V1Onboarding
          statusStore={statusStore}
          onSaveAgent={async () => {}}
          onComplete={async () => setOnboarding(false)}
        />
      ) : (
        <V1EmptyHero
          agentName="Juno"
          look={DEFAULT_AGENT_LOOK}
          composer={composer}
        />
      )}
    </V1Shell>
  );
}
document.documentElement.classList.add("light");
createRoot(document.querySelector("#root")!).render(<Validation />);

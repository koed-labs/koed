import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { HqShell } from "../HqShell.js";
import { HqOnboarding } from "../onboarding/HqOnboarding.js";

/** The HQ first-run entry renders onboarding before a Personal backend exists. */
export function HqSetup({
  onComplete,
  statusStore
}: {
  onComplete: () => Promise<void> | void;
  statusStore: DesktopStatusStore;
}) {
  return (
    <div className="hq-onboarding-shell">
      <HqShell title="Getting started" contextAvailable={false} onboarding>
        <HqOnboarding
          agentsApi={window.koedDesktop?.agents}
          localAiClients={window.koedDesktop?.localAiClients}
          personalMemoryApi={window.koedDesktop?.personalMemory}
          curatedMemoryApi={window.koedDesktop?.curatedMemory}
          onComplete={async () => {
            await onComplete();
            void statusStore.refresh();
          }}
        />
      </HqShell>
    </div>
  );
}

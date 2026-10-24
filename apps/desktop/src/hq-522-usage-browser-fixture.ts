import type { DesktopApi } from "./types.js";
import type { LocalAiClientResponse } from "./ipc/local-ai-client-protocol.js";
import { createHq521UsageFixture } from "./hq-usage-browser-fixture.js";
import {
  hq522LiveReadings,
  hq522UsageFixture
} from "./hq-522-usage-fixture.js";

/** Query-gated HQ-522 browser fixture; never changes the ordinary HQ data. */
export function createHq522UsageFixture() {
  const base = createHq521UsageFixture();
  const fixtureNow = Date.now();
  let variant: keyof typeof hq522UsageFixture = "codexLowClaudeFine";
  let scope = "hq522-owner-a-account-a";
  const trace = { reads: 0, settingsWrites: 0 };
  const api = {
    ...base.api,
    set: async (
      ...args: Parameters<NonNullable<DesktopApi["localAiClients"]>["set"]>
    ) => {
      trace.settingsWrites++;
      return base.api!.set(...args);
    },
    usage: async (instanceId?: string): Promise<LocalAiClientResponse> => {
      trace.reads++;
      const response = await base.api!.usage!(instanceId);
      return {
        ...response,
        usageScopeId: scope,
        usage: hq522LiveReadings(variant, fixtureNow).map((reading) => ({
          ...reading,
          instanceId:
            reading.source === "codex_app_server"
              ? "codex.fixture"
              : "claude.fixture"
        }))
      };
    }
  } as DesktopApi["localAiClients"];
  return {
    api,
    control: {
      trace,
      setVariant(value: keyof typeof hq522UsageFixture) {
        variant = value;
        base.control.emit();
      },
      getVariant: () => variant,
      accountChange() {
        scope =
          scope === "hq522-owner-a-account-a"
            ? "hq522-owner-a-account-b"
            : "hq522-owner-a-account-a";
        base.control.invalidate();
        // A new-account provider report follows the old-account invalidation.
        base.control.emit();
      },
      emit: base.control.emit,
      getScope: () => scope
    }
  };
}

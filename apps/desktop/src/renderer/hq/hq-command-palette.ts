import {
  commandEntriesForSnapshot,
  type DesktopCommand
} from "../command-palette.js";
import type { HqRoute } from "./hq-navigation.js";

export type HqCommandAction =
  | { kind: "route"; route: HqRoute }
  | { kind: "toggle-sidebar" }
  | { kind: "toggle-context" }
  | { kind: "settings" }
  | { kind: "share-project"; projectId: string };
export type HqCommand = Pick<DesktopCommand, "id" | "label" | "scope"> & {
  action: HqCommandAction;
};

/** Keep the shared command model; adapt only destinations HQ actually owns. */
export function hqLayoutCommands(
  settingsAvailable: boolean,
  contextAvailable = true
): HqCommand[] {
  const preferences = commandEntriesForSnapshot(null).find(
    ({ id }) => id === "route:preferences"
  );
  return [
    {
      id: "layout:sidebar",
      label: "Toggle sidebar",
      scope: "Command",
      action: { kind: "toggle-sidebar" }
    },
    ...(contextAvailable
      ? [
          {
            id: "layout:context",
            label: "Toggle context panel",
            scope: "Command",
            action: { kind: "toggle-context" as const }
          }
        ]
      : []),
    ...(settingsAvailable && preferences
      ? [
          {
            id: preferences.id,
            label: "Settings",
            scope: preferences.scope,
            action: { kind: "settings" as const }
          }
        ]
      : [])
  ];
}

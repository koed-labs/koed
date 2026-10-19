/** HQ owns its destinations; these cannot fall through to legacy Desktop views. */
export type HqRoute =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; sessionId: string };

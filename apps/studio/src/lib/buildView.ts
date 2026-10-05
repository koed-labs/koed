// Per-user preference for how much engineering detail Chat mode shows
// while an agent is building a project. "story" is the default for
// vibe coders and non-engineers: plain-language milestones, no file
// trees or diffs. "advanced" is the Codex/Claude-Code-style lens for
// people who want the real file-level detail. One setting, two views
// over the same underlying build data - never two different products.
export const BUILD_VIEW_STORAGE_KEY = "memory-layer.build-view";

export type BuildViewMode = "story" | "advanced";

export type BuildPanelMode = "compact" | "expanded" | "hidden";
export const BUILD_PANEL_MODE_STORAGE_KEY = "memory-layer.build-panel-mode";

export function readBuildPanelMode(
  fallback: BuildPanelMode = "compact"
): BuildPanelMode {
  try {
    const stored = window.localStorage.getItem(BUILD_PANEL_MODE_STORAGE_KEY);
    return stored === "expanded" || stored === "compact" || stored === "hidden"
      ? stored
      : fallback;
  } catch {
    return fallback;
  }
}

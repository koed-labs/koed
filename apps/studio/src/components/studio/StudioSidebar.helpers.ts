export const MIN_STUDIO_SIDEBAR_WIDTH = 220;
export const MAX_STUDIO_SIDEBAR_WIDTH = 420;
export const DEFAULT_STUDIO_SIDEBAR_WIDTH = 288;
export const STUDIO_SIDEBAR_WIDTH_STEP = 24;
export const STUDIO_SIDEBAR_ICON_RAIL_WIDTH = 72;
export const STUDIO_SIDEBAR_RESIZER_WIDTH = 8;
export const MIN_STUDIO_CONTENT_WIDTH = 480;

export function boundStudioSidebarWidth(
  value: number,
  hostWidth = Number.POSITIVE_INFINITY
) {
  const safeValue = Number.isFinite(value)
    ? value
    : DEFAULT_STUDIO_SIDEBAR_WIDTH;
  const safeHostWidth = Number.isFinite(hostWidth)
    ? hostWidth
    : Number.POSITIVE_INFINITY;
  const maxWidth = Math.min(
    MAX_STUDIO_SIDEBAR_WIDTH,
    safeHostWidth -
      STUDIO_SIDEBAR_ICON_RAIL_WIDTH -
      STUDIO_SIDEBAR_RESIZER_WIDTH -
      MIN_STUDIO_CONTENT_WIDTH
  );
  return Math.round(
    Math.min(
      Math.max(MIN_STUDIO_SIDEBAR_WIDTH, safeValue),
      Math.max(MIN_STUDIO_SIDEBAR_WIDTH, maxWidth)
    )
  );
}

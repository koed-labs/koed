export const MIN_BUILD_PANEL_WIDTH = 300;
export const MAX_BUILD_PANEL_WIDTH = 640;
export const MIN_CHAT_CONTENT_WIDTH = 360;
export const BUILD_PANEL_WIDTH_STEP = 24;
export const BUILD_PANEL_DIVIDER_WIDTH = 8;
export const BUILD_PANEL_MARGIN_RIGHT = 12;

export function boundBuildPanelWidth(
  value: number,
  availableWidth = Number.POSITIVE_INFINITY
) {
  const safeValue = Number.isFinite(value)
    ? value
    : MIN_BUILD_PANEL_WIDTH;
  const safeAvailableWidth = Number.isFinite(availableWidth)
    ? availableWidth
    : Number.POSITIVE_INFINITY;
  const maxWidth = Math.min(
    MAX_BUILD_PANEL_WIDTH,
    safeAvailableWidth - MIN_CHAT_CONTENT_WIDTH
  );
  return Math.round(
    Math.min(
      Math.max(MIN_BUILD_PANEL_WIDTH, safeValue),
      Math.max(MIN_BUILD_PANEL_WIDTH, maxWidth)
    )
  );
}

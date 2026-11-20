import type { Point, Rectangle } from "electron";
import type { FloatingKinSize } from "../ipc/floating-kin-protocol.js";

export const floatingKinBounds = (
  requested: FloatingKinSize,
  area: Rectangle,
  anchor?: Point,
  dragging = false
): Rectangle => {
  const margin = (dimension: number) =>
    Math.min(28, Math.floor((dimension - 1) / 2));
  const mx = margin(area.width);
  const my = margin(area.height);
  const width = Math.min(requested.width, 480, area.width - 2 * mx);
  const height = Math.min(requested.height, 800, area.height - 2 * my);
  // Keep the grab offset while crossing displays; fit the window on drop.
  if (dragging && anchor)
    return { x: anchor.x - width, y: anchor.y - height, width, height };
  const right = area.x + area.width - width;
  const bottom = area.y + area.height - height;
  return {
    x: anchor
      ? Math.max(area.x, Math.min(right, anchor.x - width))
      : right - mx,
    y: anchor
      ? Math.max(area.y, Math.min(bottom, anchor.y - height))
      : bottom - my,
    width,
    height
  };
};

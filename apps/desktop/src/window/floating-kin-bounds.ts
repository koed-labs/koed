import type { Rectangle } from "electron";
import type { FloatingKinSize } from "../ipc/floating-kin-protocol.js";

export const floatingKinBounds = (
  requested: FloatingKinSize,
  area: Rectangle
): Rectangle => {
  const margin = (dimension: number) =>
    Math.min(28, Math.floor((dimension - 1) / 2));
  const mx = margin(area.width);
  const my = margin(area.height);
  const width = Math.min(requested.width, 480, area.width - 2 * mx);
  const height = Math.min(requested.height, 800, area.height - 2 * my);
  return {
    x: area.x + area.width - width - mx,
    y: area.y + area.height - height - my,
    width,
    height
  };
};

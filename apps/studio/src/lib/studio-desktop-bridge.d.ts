import type { DesktopApi } from "../../../desktop/src/types.js";

declare global {
  interface Window {
    koedDesktop?: DesktopApi;
  }
}

export {};

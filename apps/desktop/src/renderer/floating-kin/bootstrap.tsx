import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FloatingKin, type FloatingKinBridge } from "./FloatingKin.js";

export function mountFloatingKin(
  element: HTMLElement,
  bridge?: FloatingKinBridge
) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <FloatingKin bridge={bridge} />
    </StrictMode>
  );
  window.addEventListener("pagehide", () => root.unmount(), { once: true });
}

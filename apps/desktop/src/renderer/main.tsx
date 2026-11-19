import type { FloatingKinBridge } from "../ipc/floating-kin-protocol.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root.");

if (window.location.hash === "#floating-kin") {
  void import("./floating-kin/bootstrap.js").then(({ mountFloatingKin }) => {
    const { floatingKin } = window as Window & {
      floatingKin?: FloatingKinBridge;
    };
    mountFloatingKin(root, floatingKin);
  });
} else {
  void import("./desktop-root.js").then(({ mountDesktop }) =>
    mountDesktop(root)
  );
}

/* global process, fetch, WebSocket, console */
// Run against a local Electron test window on the new Chat screen:
// pnpm --dir apps/desktop exec electron . --remote-debugging-port=9223
// node apps/desktop/scripts/validate-slash-suggestions.mjs
// Does not submit a prompt or alter AI Client setup. Refuses to replace a draft.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.KOED_TEST_DEBUG_PORT ?? 9223);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(
  (response) => response.json()
);
const page = pages.find(
  (candidate) =>
    candidate.type === "page" && candidate.url.startsWith("koed://")
);
assert(page, "No local Koed Electron test window found");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const evaluate = async (expression) => {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => {
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error || message.result?.exceptionDetails) {
        reject(
          new Error(
            JSON.stringify(message.error ?? message.result.exceptionDetails)
          )
        );
      } else resolve(message.result.result.value);
    };
    socket.addEventListener("message", listener);
  });
  socket.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  );
  return result;
};
try {
  await evaluate(`(() => {
    const textarea = document.querySelector('form[aria-label="New Conversation"] textarea');
    if (!textarea) throw new Error("Open the new Chat screen first");
    if (textarea.value && textarea.value !== "/") throw new Error("Refusing to overwrite a draft");
    textarea.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "/");
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await evaluate(`(() => {
      const popup = document.querySelector(".ai-suggestion-popover");
      const content = document.querySelector(".desktop-main-content");
      const rect = popup?.getBoundingClientRect();
      const boundary = content?.getBoundingClientRect();
      return { count: document.querySelectorAll(".ai-suggestion-menu [role=option]").length,
        visible: !!rect && rect.height > 0 && rect.top >= (boundary?.top ?? 0)
          && rect.bottom <= innerHeight && rect.left >= (boundary?.left ?? 0) && rect.right <= innerWidth,
        background: popup && getComputedStyle(popup).backgroundColor };
    })()`);
    if (state.count) break;
    await delay(200);
  }
  assert(state.count > 0, "No suggestions reached the new Chat composer");
  assert(
    state.visible,
    "Suggestions are off-screen or clipped by the main content"
  );
  assert.notEqual(
    state.background,
    "rgba(0, 0, 0, 0)",
    "Suggestion popup must have an opaque background"
  );
  const navigation = await evaluate(`(async () => {
    const textarea = document.querySelector('form[aria-label="New Conversation"] textarea');
    const popup = document.querySelector(".ai-suggestion-popover");
    const before = popup.scrollTop;
    for (let index = 0; index < 20; index++) {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const selected = popup.querySelector('[aria-selected="true"]');
    const rect = selected?.getBoundingClientRect();
    const boundary = popup.getBoundingClientRect();
    return { selectedVisible: !!rect && rect.top >= boundary.top && rect.bottom <= boundary.bottom,
      focusRetained: document.activeElement === textarea, scrolled: popup.scrollTop > before };
  })()`);
  assert(navigation.selectedVisible, "Keyboard selection scrolled out of view");
  assert(
    navigation.focusRetained,
    "Keyboard navigation moved focus out of the composer"
  );
  if (state.count > 20)
    assert(
      navigation.scrolled,
      "Menu scroll position did not follow keyboard selection"
    );
  console.log(JSON.stringify({ ok: true, ...state, ...navigation }));
} finally {
  socket.close();
}

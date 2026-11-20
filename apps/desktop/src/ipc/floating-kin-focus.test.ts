import { expect, it, vi } from "vitest";
import { subscribeToMainWindowFocus } from "./floating-kin-focus.js";

function subscribe() {
  let resolve!: (focused: boolean) => void;
  const reply = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const listener = vi.fn();
  const stop = vi.fn();
  let receive!: (focused: unknown) => void;
  const unsubscribe = subscribeToMainWindowFocus(
    listener,
    () => reply,
    (onChange) => {
      receive = onChange;
      return stop;
    }
  );
  return { listener, unsubscribe, receive, resolve, reply, stop };
}

it("receives initial main-window focus and then focus changes", async () => {
  const { listener, receive, resolve, reply, unsubscribe, stop } = subscribe();
  resolve(true);
  await reply;
  receive(false);
  expect(listener.mock.calls).toEqual([[true], [false]]);
  unsubscribe();
  expect(stop).toHaveBeenCalledOnce();
});

it("does not overwrite a newer blur with the initial focus snapshot", async () => {
  const { listener, receive, resolve, reply } = subscribe();
  receive(false);
  resolve(true);
  await reply;
  expect(listener).toHaveBeenCalledExactlyOnceWith(false);
});

it("drops the initial focus snapshot after unsubscribe", async () => {
  const { listener, receive, unsubscribe, resolve, reply } = subscribe();
  unsubscribe();
  resolve(true);
  await reply;
  receive(false);
  expect(listener).not.toHaveBeenCalled();
});

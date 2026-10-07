/* global clearTimeout, setTimeout */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Launch normal packaged main, never an Electron-as-Node supervisor impersonator.
export const launchPackagedDesktop = ({
  executable,
  env,
  koedHome,
  timeoutMs = 180_000
}) => {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    ["--koed-private-smoke", `--user-data-dir=${koedHome}/desktop-user-data`],
    {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: false
    }
  );
  return connectPackagedDesktop(child, timeoutMs);
};

export const connectPackagedDesktop = (child, timeoutMs) => {
  let output = "";
  let ended = false;
  const pending = new Map();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data) => {
      output = (output + data.toString()).slice(-65_536);
    });
  }
  const fail = (error) => {
    ended = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        `Packaged Desktop manager bootstrap timed out.\n${output}`
      );
      fail(error);
      child.kill("SIGTERM");
      reject(error);
    }, timeoutMs);
    pending.set("bootstrap", { resolve, reject, timer });
  });
  child.on("error", fail);
  child.on("exit", (code) =>
    fail(new Error(`Packaged Desktop exited (${code}).\n${output}`))
  );
  child.on("disconnect", () =>
    fail(new Error(`Packaged Desktop IPC disconnected.\n${output}`))
  );
  child.on("message", (message) => handleMessage(message, pending, fail));
  const invoke = async (command) => {
    await ready;
    if (ended || !child.connected)
      throw new Error(`Packaged Desktop is not connected.\n${output}`);
    return request(child, pending, command, timeoutMs);
  };
  return {
    child,
    ready,
    invoke,
    get output() {
      return output;
    }
  };
};

const handleMessage = (message, pending, fail) => {
  if (!message || message.version !== 1)
    return fail(new Error("Invalid packaged Desktop smoke IPC."));
  const id =
    message.type === "koed.desktop.smoke.ready" ? "bootstrap" : message.id;
  const item = pending.get(id);
  if (
    !item ||
    !["koed.desktop.smoke.ready", "koed.desktop.smoke.response"].includes(
      message.type
    )
  ) {
    return fail(new Error("Uncorrelated packaged Desktop smoke IPC."));
  }
  clearTimeout(item.timer);
  pending.delete(id);
  if (message.error) item.reject(new Error(message.error));
  else item.resolve(message.result);
};

const request = (child, pending, command, timeoutMs) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Packaged Desktop ${command} timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.send(
      { type: "koed.desktop.smoke.request", version: 1, id, command },
      (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    );
  });

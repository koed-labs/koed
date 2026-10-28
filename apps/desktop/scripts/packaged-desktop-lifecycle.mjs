/* global clearTimeout, setTimeout */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const createPackagedDesktopEnvironment = (environment) => {
  const childEnvironment = { ...environment };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  delete childEnvironment.KOED_PACKAGED_RESOURCES_PATH;
  return childEnvironment;
};

export const waitForPackagedDesktopExit = (child, timeoutMs = 30_000) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0 && child.signalCode === null
      ? Promise.resolve()
      : Promise.reject(
          new Error(
            `Packaged Desktop exited after quit (${child.exitCode ?? child.signalCode}).`
          )
        );
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      if (code === 0 && signal === null) resolve();
      else {
        reject(
          new Error(`Packaged Desktop exited after quit (${code ?? signal}).`)
        );
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      reject(
        new Error(`Packaged Desktop exit timed out after ${timeoutMs}ms.`)
      );
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
};

// Launch normal packaged main, never an Electron-as-Node supervisor impersonator.
export const launchPackagedDesktop = ({
  executable,
  env,
  koedHome,
  timeoutMs = 180_000
}) => {
  const childEnv = createPackagedDesktopEnvironment(env);
  const child = spawn(
    executable,
    [
      "--use-mock-keychain",
      "--koed-private-smoke",
      `--user-data-dir=${koedHome}/desktop-user-data`
    ],
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

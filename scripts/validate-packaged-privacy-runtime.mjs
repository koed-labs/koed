#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const runtimeRoot = value("--runtime-root");
const cache = value("--transformers-cache");
const provider = value("--provider");
if (
  !runtimeRoot ||
  !cache ||
  !new Set(["cpu", "coreml", "cuda"]).has(provider)
) {
  throw new Error(
    "Usage: validate-packaged-privacy-runtime --runtime-root <koed-runtime> --transformers-cache <path> --provider <cpu|coreml|cuda>"
  );
}

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolvePort(selected)));
  });
});
const token = "packaged-privacy-smoke";
const controlToken = "packaged-privacy-control";
const child = spawn(
  process.execPath,
  [resolve(runtimeRoot, "privacy-service/dist/index.js")],
  {
    env: {
      ...process.env,
      KOED_PRIVACY_TRANSFORMERS_CACHE: resolve(cache),
      PRIVACY_SERVICE_HOST: "127.0.0.1",
      PRIVACY_SERVICE_PORT: String(port),
      PRIVACY_SERVICE_TOKEN: token,
      PRIVACY_RUNTIME_CONTROL_TOKEN: controlToken,
      PRIVACY_RUNTIME_PROVIDER: provider,
      PRIVACY_GPU_IDLE_UNLOAD_SECONDS: provider === "cpu" ? "0" : "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout = `${stdout}${chunk}`.slice(-32 * 1024);
});
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-32 * 1024);
});

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 120_000;
const requestResponse = async (path, init) => {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  return { response, body };
};
const request = async (path, init) => {
  const { response, body } = await requestResponse(path, init);
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return body;
};
const runtimeStatus = () =>
  request("/v1/runtime/status", {
    headers: { "x-koed-privacy-token": controlToken }
  });
const switchProvider = (nextProvider) =>
  request("/v1/runtime/provider", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koed-privacy-token": controlToken
    },
    body: JSON.stringify({ provider: nextProvider })
  });
const classify = () =>
  request("/v1/classify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koed-privacy-token": token
    },
    body: JSON.stringify({
      schemaVersion: 1,
      inputContractVersion: "koed-privacy-classification-v1",
      fields: [
        {
          path: "message",
          text: "Email Alice at alice@example.com and call +44 7700 900123."
        }
      ]
    })
  });
const classificationSignature = (classification) => ({
  classifier: classification.classifier,
  spans: classification.fields?.[0]?.spans?.map((span) => ({
    start: span.start,
    end: span.end,
    label: span.label
  }))
});

try {
  let status;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Privacy Filter Service exited ${child.exitCode}: ${stderr || stdout}`
      );
    }
    try {
      status = await runtimeStatus();
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  if (!status || status.activeProvider !== provider) {
    throw new Error(
      `Privacy provider ${provider} did not become active: ${JSON.stringify(status)}`
    );
  }
  if (
    provider !== "cpu" &&
    (!status.verifiedProviders?.includes("cpu") ||
      !status.verifiedProviders?.includes(provider))
  ) {
    throw new Error("Accelerated provider did not pass CPU classifier parity.");
  }
  const classification = await classify();
  if (classification.fields?.[0]?.spans?.length < 2) {
    throw new Error(
      "Packaged Privacy classification did not detect fixture PII."
    );
  }
  const initialSignature = classificationSignature(classification);
  const behavior = {
    switchedToCpu: false,
    switchedBack: false,
    idleUnloadReload: false,
    unavailableProviderRejected: false
  };
  if (provider !== "cpu") {
    const cpuStatus = await switchProvider("cpu");
    if (cpuStatus.activeProvider !== "cpu") {
      throw new Error("Packaged Privacy runtime did not switch to CPU.");
    }
    behavior.switchedToCpu = true;
    const cpuClassification = await classify();
    if (
      JSON.stringify(classificationSignature(cpuClassification)) !==
      JSON.stringify(initialSignature)
    ) {
      throw new Error(
        "Packaged Privacy CPU classification did not match the accelerated provider."
      );
    }
    const acceleratedStatus = await switchProvider(provider);
    if (acceleratedStatus.activeProvider !== provider) {
      throw new Error(
        `Packaged Privacy runtime did not switch back to ${provider}.`
      );
    }
    behavior.switchedBack = true;
    const acceleratedClassification = await classify();
    if (
      JSON.stringify(classificationSignature(acceleratedClassification)) !==
      JSON.stringify(initialSignature)
    ) {
      throw new Error(
        "Packaged Privacy classification changed after provider reload."
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    const unloadedStatus = await runtimeStatus();
    if (unloadedStatus.acceleratorResident !== false) {
      throw new Error("Packaged Privacy accelerator did not unload when idle.");
    }
    await classify();
    const reloadedStatus = await runtimeStatus();
    if (reloadedStatus.acceleratorResident !== true) {
      throw new Error(
        "Packaged Privacy accelerator did not reload for classification."
      );
    }
    behavior.idleUnloadReload = true;
  }

  const unavailableProvider = process.platform === "darwin" ? "cuda" : "coreml";
  const unavailable = await requestResponse("/v1/runtime/provider", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koed-privacy-token": controlToken
    },
    body: JSON.stringify({ provider: unavailableProvider })
  });
  if (unavailable.response.ok) {
    throw new Error(
      `Packaged Privacy runtime unexpectedly accepted ${unavailableProvider}.`
    );
  }
  const afterUnavailable = await runtimeStatus();
  if (afterUnavailable.activeProvider !== provider) {
    throw new Error(
      "Packaged Privacy runtime changed provider after a failed switch."
    );
  }
  behavior.unavailableProviderRejected = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        provider,
        runtimeRoot: resolve(runtimeRoot),
        verifiedProviders: status.verifiedProviders,
        calibrations: status.calibrations,
        classifier: classification.classifier,
        behavior,
        detectedLabels: classification.fields[0].spans.map((span) => span.label)
      },
      null,
      2
    )
  );
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
    setTimeout(resolveExit, 5_000).unref();
  });
}

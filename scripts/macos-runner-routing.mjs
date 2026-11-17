import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const runnerNames = ["koed-shf-macos-arm64", "koed-zom-macos-arm64"];
const fallback = "xcode-27";

function isAvailable(runner, name) {
  const assigned = new Set(runner.labels?.map((label) => label.name));
  return (
    runner.name === name &&
    runner.status === "online" &&
    runner.busy === false &&
    ["self-hosted", "macOS", "ARM64", name].every((label) =>
      assigned.has(label)
    )
  );
}

export async function chooseMacosRunner({
  token,
  fetchRunners,
  wait,
  attempts = 9,
  intervalMs = 15000
}) {
  if (!token) {
    console.warn("Runner status token missing; using GitHub-hosted macOS.");
    return fallback;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchRunners(token);
      if (!response.ok) {
        console.warn(
          `Runner status request failed (${response.status}); using GitHub-hosted macOS.`
        );
        return fallback;
      }
      const data = await response.json();
      if (!Array.isArray(data.runners))
        throw new Error("Invalid runner response");
      const name = runnerNames.find((name) =>
        data.runners.some((runner) => isAvailable(runner, name))
      );
      if (name) return ["self-hosted", "macOS", "ARM64", name];
    } catch (error) {
      console.warn(
        `Runner status request failed: ${error.message}; using GitHub-hosted macOS.`
      );
      return fallback;
    }
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  console.log(
    "Self-hosted Mac unavailable after two minutes; using GitHub-hosted macOS."
  );
  return fallback;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository !== "koed-labs/koed" || !process.env.GITHUB_OUTPUT)
    throw new Error("Invalid routing context");
  const selected = await chooseMacosRunner({
    token: process.env.KOED_RUNNER_STATUS_TOKEN,
    fetchRunners: async (token) => {
      const responses = await Promise.all(
        runnerNames.map((name) =>
          fetch(
            `https://api.github.com/repos/${repository}/actions/runners?name=${name}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json"
              },
              signal: AbortSignal.timeout(10000)
            }
          )
        )
      );
      const failed = responses.find((response) => !response.ok);
      if (failed) return failed;
      const data = await Promise.all(
        responses.map((response) => response.json())
      );
      return {
        ok: true,
        json: async () => ({ runners: data.flatMap((item) => item.runners) })
      };
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `runner=${JSON.stringify(selected)}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

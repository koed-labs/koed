#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = process.cwd();
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const mcpName = process.env.MEMORY_MCP_NAME ?? "koed";
const codexConfigPath = resolve(
  process.env.CODEX_CONFIG_PATH ??
    `${process.env.CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`
);
const codexHome = resolve(
  process.env.CODEX_HOME ??
    (process.env.CODEX_CONFIG_PATH
      ? dirname(codexConfigPath)
      : `${homedir()}/.codex`)
);
const codexInstructionsPath = join(codexHome, "AGENTS.md");
const mcpCliPath = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
const captureHookPath = resolve(
  repoRoot,
  "packages/mcp-server/dist/capture-hook.js"
);
const guidancePath = resolve(
  repoRoot,
  "prompts/codex-global-agent-guidance.md"
);
const memoryGuidanceEnabled =
  process.env.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED !== "false";

for (const filePath of [
  mcpCliPath,
  captureHookPath,
  ...(memoryGuidanceEnabled ? [guidancePath] : [])
]) {
  if (!existsSync(filePath)) {
    console.error(
      `${filePath} does not exist. Run pnpm --filter @koed/mcp-server build first.`
    );
    process.exit(1);
  }
}

const guidanceMarkerStart = "<!-- >>> koed-memory-guidance -->";
const guidanceMarkerEnd = "<!-- <<< koed-memory-guidance -->";
const guidance = memoryGuidanceEnabled
  ? readFileSync(guidancePath, "utf8").trim()
  : "";
const managedGuidance = `${guidanceMarkerStart}\n${guidance}\n${guidanceMarkerEnd}`;
const reconcileGuidance = (content) => {
  const startCount = content.split(guidanceMarkerStart).length - 1;
  const endCount = content.split(guidanceMarkerEnd).length - 1;
  if (startCount === 0 && endCount === 0) {
    return `${content}${content ? "\n\n" : ""}${managedGuidance}\n`;
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  const start = content.indexOf(guidanceMarkerStart);
  const end = content.indexOf(guidanceMarkerEnd, start);
  if (end < start) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  return `${content.slice(0, start)}${managedGuidance}${content.slice(end + guidanceMarkerEnd.length)}`;
};
const removeGuidance = (content) => {
  const startCount = content.split(guidanceMarkerStart).length - 1;
  const endCount = content.split(guidanceMarkerEnd).length - 1;
  if (startCount === 0 && endCount === 0) return content;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  const start = content.indexOf(guidanceMarkerStart);
  const end = content.indexOf(guidanceMarkerEnd, start);
  if (end < start) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  const markerEnd = end + guidanceMarkerEnd.length;
  const ownedStart =
    start >= 2 && content.slice(start - 2, start) === "\n\n"
      ? start - 2
      : start;
  const ownedEnd = content[markerEnd] === "\n" ? markerEnd + 1 : markerEnd;
  return `${content.slice(0, ownedStart)}${content.slice(ownedEnd)}`;
};

const markerStart = "# >>> koed";
const markerEnd = "# <<< koed";
const configuredKoedHome = process.env.KOED_HOME?.trim();
const koedHome =
  !configuredKoedHome || configuredKoedHome === "~"
    ? configuredKoedHome === "~"
      ? homedir()
      : join(homedir(), ".koed")
    : configuredKoedHome.startsWith("~/") ||
        configuredKoedHome.startsWith("~\\")
      ? resolve(homedir(), configuredKoedHome.slice(2))
      : resolve(configuredKoedHome);
const hookCommand = [nodeCommand, captureHookPath, "--koed-home", koedHome]
  .map((value) => JSON.stringify(value))
  .join(" ");
const hookEvents = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 10],
  ["PostToolUse", 10],
  ["Stop", 30],
  ["SubagentStart", 10],
  ["SubagentStop", 30]
];
const hookBlocks = hookEvents
  .map(
    ([eventName, timeout]) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = ${JSON.stringify(hookCommand)}
timeout = ${timeout}`
  )
  .join("\n\n");
const koedBlock = `${markerStart}
[mcp_servers.${mcpName}]
command = "${nodeCommand}"
args = ["${mcpCliPath}"]
enabled = true

[mcp_servers.${mcpName}.env]
KOED_HOME = ${JSON.stringify(koedHome)}

${hookBlocks}
${markerEnd}
`;

const stripOwnedBlock = (content) => {
  const lines = content.split(/(?<=\\n)|(?<=\\r)/);
  const markers = lines.flatMap((line, index) => {
    const value = line.replace(/(?:\\r\\n|\\n|\\r)$/, "");
    if (/^[\\t ]*# >>> koed[\\t ]*$/.test(value)) return [["start", index]];
    if (/^[\\t ]*# <<< koed[\\t ]*$/.test(value)) return [["end", index]];
    return [];
  });
  if (markers.length === 0) return content;
  const starts = markers.filter(([kind]) => kind === "start");
  const ends = markers.filter(([kind]) => kind === "end");
  if (starts.length !== 1 || ends.length !== 1 || starts[0][1] > ends[0][1]) {
    throw new Error(
      "Codex Koed ownership markers are duplicated or incomplete."
    );
  }
  return lines
    .slice(0, starts[0][1])
    .concat(lines.slice(ends[0][1] + 1))
    .join("");
};

const existing = existsSync(codexConfigPath)
  ? readFileSync(codexConfigPath, "utf8")
  : "";
const withoutPrevious = stripOwnedBlock(existing);
const existingInstructions = existsSync(codexInstructionsPath)
  ? readFileSync(codexInstructionsPath, "utf8")
  : "";
const nextInstructions = memoryGuidanceEnabled
  ? reconcileGuidance(existingInstructions)
  : removeGuidance(existingInstructions);
mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
writeFileSync(codexConfigPath, `${withoutPrevious.trimEnd()}\n\n${koedBlock}`);
mkdirSync(dirname(codexInstructionsPath), { recursive: true, mode: 0o700 });
if (nextInstructions !== existingInstructions) {
  writeFileSync(codexInstructionsPath, nextInstructions, { mode: 0o600 });
}

console.log("Codex integration configured.");
console.log(`Detected Node command: ${nodeCommand}`);
console.log(`Detected Koed home: ${koedHome}`);
console.log(`Wrote Codex MCP config: ${codexConfigPath}`);
console.log(
  memoryGuidanceEnabled
    ? `Reconciled Codex global instructions: ${codexInstructionsPath}`
    : `Koed global memory guidance disabled: ${codexInstructionsPath}`
);
console.log(
  "Next: restart Codex, then run `pnpm codex:verify-capture` or `pnpm codex:doctor` to confirm the integration is healthy."
);
console.log(
  "Codex may ask you to review or trust changed hooks after config.toml changes."
);

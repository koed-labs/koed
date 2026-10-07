#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = process.cwd();
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const mcpName = process.env.MEMORY_MCP_NAME ?? "koed";
const mode = process.argv.includes("--remove")
  ? "remove"
  : process.argv.includes("--check")
    ? "check"
    : "configure";
if (process.argv.includes("--remove") && process.argv.includes("--check")) {
  throw new Error("Choose either --check or --remove.");
}
if (
  process.argv.includes("--deferred-recall") &&
  process.argv.includes("--blocking-recall")
) {
  throw new Error("Choose either --deferred-recall or --blocking-recall.");
}
if (!/^[A-Za-z0-9_-]+$/.test(mcpName)) {
  throw new Error("MEMORY_MCP_NAME must be a TOML bare server name.");
}
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
const memoryHookPath = resolve(
  repoRoot,
  "packages/mcp-server/dist/codex-memory-hook.js"
);
const guidancePath = resolve(
  repoRoot,
  "prompts/codex-global-agent-guidance.md"
);
const memoryGuidanceEnabled =
  process.env.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED !== "false";

for (const filePath of mode === "remove"
  ? []
  : [
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
const guidance =
  memoryGuidanceEnabled && mode !== "remove"
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
const makeKoedBlock = (deferredRecall, deliveryHooks) => `${markerStart}
[mcp_servers.${mcpName}]
command = "${nodeCommand}"
args = ["${mcpCliPath}"]
enabled = true

[mcp_servers.${mcpName}.tools.memory_answer]
approval_mode = "approve"

[mcp_servers.${mcpName}.env]
KOED_HOME = ${JSON.stringify(koedHome)}
${deferredRecall ? `KOED_CODEX_STOP_DELIVERY = "1"\nKOED_CODEX_MEMORY_TOOL = ${JSON.stringify(`mcp__${mcpName}__memory_answer`)}\n` : `KOED_CODEX_STOP_DELIVERY = "0"\n`}

${hookBlocks}
${deliveryHooks}
${markerEnd}
`;

const stripOwnedBlock = (content) => {
  const lines = content.split(/(?<=\n)|(?<=\r)/);
  const markers = lines.flatMap((line, index) => {
    const value = line.replace(/(?:\r\n|\n|\r)$/, "");
    if (/^[\t ]*# >>> koed[\t ]*$/.test(value)) return [["start", index]];
    if (/^[\t ]*# <<< koed[\t ]*$/.test(value)) return [["end", index]];
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
const ownedContent = existing.slice(
  existing.indexOf(markerStart),
  existing.indexOf(markerEnd)
);
const deferredRecall = process.argv.includes("--blocking-recall")
  ? false
  : process.argv.includes("--deferred-recall")
    ? true
    : process.env.KOED_CODEX_STOP_DELIVERY === "0"
      ? false
      : process.env.KOED_CODEX_STOP_DELIVERY === "1" ||
        !/^KOED_CODEX_STOP_DELIVERY\s*=\s*"0"\s*$/m.test(ownedContent);
if (mode !== "remove" && deferredRecall && !existsSync(memoryHookPath)) {
  throw new Error(
    `${memoryHookPath} does not exist. Build @koed/mcp-server before configuring deferred recall.`
  );
}
const memoryTool = `mcp__${mcpName}__memory_answer`;
const quoteDeliveryArgument = (value) =>
  process.platform === "win32"
    ? JSON.stringify(value)
    : `'${value.replaceAll("'", "'\\''")}'`;
const memoryCommand = [
  nodeCommand,
  memoryHookPath,
  "--koed-home",
  koedHome,
  "--memory-tool",
  memoryTool,
  "--wait-ms",
  "300000"
]
  .map(quoteDeliveryArgument)
  .join(" ");
const memoryMatcher = `^${memoryTool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const deliveryHooks = deferredRecall
  ? [
      ["PreToolUse", 10, memoryMatcher],
      ["PostToolUse", 10, memoryMatcher],
      ["Stop", 305],
      ["SessionEnd", 10],
      ["Interrupt", 3]
    ]
      .map(
        ([eventName, timeout, matcher]) => `[[hooks.${eventName}]]
${matcher ? `matcher = ${JSON.stringify(matcher)}\n` : ""}[[hooks.${eventName}.hooks]]
type = "command"
command = ${JSON.stringify(memoryCommand)}
timeout = ${timeout}`
      )
      .join("\n\n")
  : "";
const koedBlock = makeKoedBlock(deferredRecall, deliveryHooks);
const existingInstructions = existsSync(codexInstructionsPath)
  ? readFileSync(codexInstructionsPath, "utf8")
  : "";
const nextInstructions =
  mode === "remove"
    ? removeGuidance(existingInstructions)
    : memoryGuidanceEnabled
      ? reconcileGuidance(existingInstructions)
      : removeGuidance(existingInstructions);
const nextConfig =
  mode === "remove"
    ? withoutPrevious
    : `${withoutPrevious.trimEnd()}\n\n${koedBlock}`;
if (mode === "check") {
  if (existing !== nextConfig || existingInstructions !== nextInstructions) {
    console.error(
      "Codex integration differs from the selected Koed configuration."
    );
    process.exit(1);
  }
  console.log(
    `Codex integration matches (${deferredRecall ? "deferred" : "blocking"} recall).`
  );
  process.exit(0);
}
if (nextConfig !== existing) {
  mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(codexConfigPath, nextConfig, { mode: 0o600 });
}
if (nextInstructions !== existingInstructions) {
  mkdirSync(dirname(codexInstructionsPath), { recursive: true, mode: 0o700 });
  writeFileSync(codexInstructionsPath, nextInstructions, { mode: 0o600 });
}

console.log(
  mode === "remove"
    ? "Koed-owned Codex integration removed."
    : "Codex integration configured."
);
if (mode === "remove") process.exit(0);
console.log(
  `Memory Answer delivery: ${deferredRecall ? "deferred native Stop hook" : "blocking"}.`
);
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

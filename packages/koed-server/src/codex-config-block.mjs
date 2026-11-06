import { basename, dirname, isAbsolute, join } from "node:path";

/** @param {{ nodeCommand: string, mcpName: string, mcpCliPath: string, captureHookPath: string, koedHome: string }} config */
function codexConfigSections({
  nodeCommand,
  mcpName,
  mcpCliPath,
  captureHookPath,
  koedHome
}) {
  const hookCommand = [
    nodeCommand,
    captureHookPath,
    "--koed-home",
    koedHome,
    "--memory-tool",
    `mcp__${mcpName}__memory_answer`
  ]
    .map((value) => JSON.stringify(value))
    .join(" ");
  const hookEvents = [
    ["PreToolUse", 10],
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
${eventName === "PreToolUse" ? `matcher = ${JSON.stringify(`mcp__${mcpName}__memory_answer`)}\n` : ""}[[hooks.${eventName}.hooks]]
type = "command"
command = ${JSON.stringify(hookCommand)}
timeout = ${timeout}`
    )
    .join("\n\n");
  const header = `mcp_servers.${mcpName}`;
  const tables = [
    `[${header}]\ncommand = ${JSON.stringify(nodeCommand)}\nargs = [${JSON.stringify(mcpCliPath)}]\nenabled = true`,
    ...[
      "memory_answer",
      "memory_answer_result",
      "memory_answer_cancel",
      "memory_workspaces"
    ].map((tool) => `[${header}.tools.${tool}]\napproval_mode = "approve"`),
    `[${header}.env]\nKOED_HOME = ${JSON.stringify(koedHome)}`
  ];
  return { tables, hooks: hookBlocks };
}

/** @param {Parameters<typeof codexConfigSections>[0]} config */
export function renderCodexBlock(config) {
  const { tables, hooks } = codexConfigSections(config);
  return `# >>> koed\n${tables.join("\n\n")}\n\n${hooks}\n# <<< koed\n`;
}

// Some Codex rewrites move MCP tables into name order, omit enabled=true, and
// leave only our closing marker after the hooks. Recover this one known shape.
// Returning the original text lets the existing marker check reject ambiguous edits.
/** @param {string} content @param {Parameters<typeof renderCodexBlock>[0]} config */
export function stripReorderedCodexBlock(content, config) {
  if (
    !content.trimEnd().endsWith("# <<< koed") ||
    /^\s*# >>> koed\s*$/m.test(content)
  )
    return content;
  if (
    (content.match(/^[\t ]*# <<< koed[\t ]*\r?$/gm) ?? []).length !== 1 ||
    /"""|'''/.test(content)
  )
    return content;
  const header = `[mcp_servers.${config.mcpName}]`;
  const tables = content.split(/(?=^\[)/m);
  const server = tables.find((table) => table.split(/\r?\n/, 1)[0] === header);
  if (!server) return content;
  let cli;
  let command;
  try {
    const args = JSON.parse(/^args = (.+)$/m.exec(server)?.[1] ?? "");
    command = JSON.parse(/^command = (.+)$/m.exec(server)?.[1] ?? "");
    if (
      !Array.isArray(args) ||
      args.length !== 1 ||
      typeof command !== "string"
    )
      return content;
    cli = args[0];
  } catch {
    return content;
  }
  if (
    typeof cli !== "string" ||
    !isAbsolute(cli) ||
    basename(cli) !== "cli.js" ||
    basename(dirname(cli)) !== "dist" ||
    basename(dirname(dirname(cli))) !== "mcp-server"
  )
    return content;
  const captureHookPath = join(dirname(cli), "capture-hook.js");
  const expected = codexConfigSections({
    ...config,
    nodeCommand: command,
    mcpCliPath: cli,
    captureHookPath
  });
  const newline = server.includes("\r\n") ? "\r\n" : "\n";
  const hooks = (expected.hooks + "\n# <<< koed").replaceAll("\n", newline);
  const trimmed = content.trimEnd();
  if (!trimmed.endsWith(newline + hooks)) return content;
  const beforeHooks = content.slice(0, trimmed.length - hooks.length);
  if (beforeHooks.includes(captureHookPath)) return content;

  const expectedTables = new Map(
    expected.tables.map((table) => [table.split("\n", 1)[0], table])
  );
  // Keep every other table byte for byte, including other tools and user hooks.
  const retained = [];
  for (const table of beforeHooks.split(/(?=^\[)/m)) {
    const name = table.split(/\r?\n/, 1)[0];
    if (name !== header && !name.startsWith(header.slice(0, -1) + ".")) {
      retained.push(table);
      continue;
    }
    const expectedTable = expectedTables.get(name);
    const actual = table.trimEnd().replaceAll("\r\n", "\n");
    if (!expectedTable) return content;
    const matchesImplicitEnabled =
      name === header &&
      actual === expectedTable.replace("\nenabled = true", "");
    if (actual !== expectedTable && !matchesImplicitEnabled) return content;
    expectedTables.delete(name);
  }
  return expectedTables.size === 0 ? retained.join("") : content;
}

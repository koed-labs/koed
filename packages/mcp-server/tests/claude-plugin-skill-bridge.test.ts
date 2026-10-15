import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  query,
  type Options,
  type Query
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildClaudeManagedPluginSkillOptions,
  scanClaudeManagedSkillRoot
} from "../src/claude-plugin-skill-bridge.js";

const pinnedCliPath = (() => {
  try {
    const sdkRequire = createRequire(
      import.meta.resolve("@anthropic-ai/claude-agent-sdk")
    );
    const executable = process.platform === "win32" ? "claude.exe" : "claude";
    return sdkRequire.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${executable}`
    );
  } catch {
    return undefined;
  }
})();

const temporaryDirectories: string[] = [];

type JsonRecord = Record<string, unknown>;

const jsonRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const textFromFirstRequestMessage = (request: unknown): string => {
  const requestRecord = jsonRecord(request);
  const messages = requestRecord?.messages;
  if (!Array.isArray(messages)) return "";
  const firstMessage = jsonRecord(messages[0]);
  const content = firstMessage?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const blockRecord = jsonRecord(block);
      return typeof blockRecord?.text === "string" ? [blockRecord.text] : [];
    })
    .join("\n");
};

const toolNamesFromRequest = (request: unknown): string[] => {
  const requestRecord = jsonRecord(request);
  const tools = requestRecord?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const toolRecord = jsonRecord(tool);
    return typeof toolRecord?.name === "string" ? [toolRecord.name] : [];
  });
};

const modelFromRequest = (request: unknown): string | undefined => {
  const model = jsonRecord(request)?.model;
  return typeof model === "string" ? model : undefined;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
});

const createFixture = (label: string) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `koed-claude-plugin-bridge-${label}-`)
  );
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const config = path.join(root, "claude-config");
  for (const directory of [home, cwd, config]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return {
    root,
    home,
    cwd,
    config,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      PATH: "/usr/bin:/bin",
      TMPDIR: root,
      LANG: "en_US.UTF-8"
    }
  };
};

const createSkill = (root: string, folderName: string, name: string) => {
  const skillDirectory = path.join(root, "skills", folderName);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: temporary bridge fixture\n---\nFixture only.\n`
  );
};

const createHook = (root: string, markerPath: string) => {
  const hooksDirectory = path.join(root, "hooks");
  const scriptPath = path.join(path.dirname(markerPath), "fixture-hook.cjs");
  fs.mkdirSync(hooksDirectory, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    "require('node:fs').writeFileSync(process.argv[2], 'ran')"
  );
  fs.writeFileSync(
    path.join(hooksDirectory, "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `${process.execPath} ${scriptPath} ${markerPath}`
              }
            ]
          }
        ]
      }
    })
  );
};

const createMcpSentinel = (root: string, markerPath: string) => {
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran'); setInterval(() => {}, 1000)`
          ]
        }
      }
    })
  );
};

const startFakeAnthropicServer = async (
  markerPath: string
): Promise<{
  server: Server;
  baseUrl: string;
  requests: JsonRecord[];
}> => {
  const requests: JsonRecord[] = [];
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    let body: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(rawBody) as unknown;
      const parsedRecord = jsonRecord(parsed);
      if (!parsedRecord)
        throw new Error("Fixture request must be a JSON object");
      body = parsedRecord;
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push(body);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const emit = (event: string, data: Record<string, unknown>) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (requests.length === 1) {
      emit("message_start", {
        type: "message_start",
        message: {
          id: "msg_fixture_tool",
          type: "message",
          role: "assistant",
          model: modelFromRequest(body) ?? "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      });
      emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_fixture_bash",
          name: "Bash",
          input: {}
        }
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ command: `touch ${markerPath}` })
        }
      });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 }
      });
    } else {
      emit("message_start", {
        type: "message_start",
        message: {
          id: "msg_fixture_final",
          type: "message",
          role: "assistant",
          model: modelFromRequest(body) ?? "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      });
      emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Denied by the local fixture." }
      });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 }
      });
    }
    emit("message_stop", { type: "message_stop" });
    response.end();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fake Anthropic server did not bind a TCP port");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
};

const openWithoutPrompt = async (
  options: Options
): Promise<{
  query: Query;
  init: Awaited<ReturnType<Query["initializationResult"]>>;
  commands: string[];
  mcpCount: number;
  close: () => Promise<void>;
}> => {
  let releaseInput!: () => void;
  const inputReleased = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  const emptyPrompt = (async function* (): AsyncGenerator<string> {
    await inputReleased;
    yield* [];
  })();
  const stream = query({
    prompt: emptyPrompt,
    options
  });
  try {
    const init = await stream.initializationResult();
    const commands = (await stream.supportedCommands()).map(({ name }) => name);
    const mcpCount = (await stream.mcpServerStatus()).length;
    return {
      query: stream,
      init,
      commands,
      mcpCount,
      close: async () => {
        releaseInput();
        await emptyPrompt.return(undefined);
        stream.close();
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };
  } catch (error) {
    releaseInput();
    await emptyPrompt.return(undefined);
    stream.close();
    throw error;
  }
};

const readFixtureTranscriptEntries = (root: string): JsonRecord[] => {
  const pending = [root];
  const records: JsonRecord[] = [];
  let visitedDirectories = 0;
  let visitedFiles = 0;
  while (pending.length > 0 && visitedDirectories < 128 && visitedFiles < 512) {
    const directory = pending.pop();
    if (!directory) continue;
    visitedDirectories += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      visitedFiles += 1;
      try {
        const stat = fs.statSync(entryPath);
        if (stat.size > 2 * 1024 * 1024) continue;
        for (const line of fs.readFileSync(entryPath, "utf8").split(/\r?\n/u)) {
          if (!line) continue;
          try {
            const record = jsonRecord(JSON.parse(line) as unknown);
            if (record) records.push(record);
          } catch {
            // Ignore an incomplete final line in the disposable transcript.
          }
        }
      } catch {
        // The fixture directory is private to this test, but tolerate partial
        // SDK writes while the stream is shutting down.
      }
    }
  }
  return records;
};

const baseOptions = (fixture: ReturnType<typeof createFixture>): Options => ({
  cwd: fixture.cwd,
  env: fixture.env,
  ...(pinnedCliPath ? { pathToClaudeCodeExecutable: pinnedCliPath } : {}),
  persistSession: false,
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  tools: [],
  allowedTools: [],
  permissionMode: "dontAsk",
  canUseTool: async () => ({ behavior: "deny", message: "Denied in fixture" })
});

describe.skipIf(!pinnedCliPath)(
  "Claude managed Skill bridge native fixtures",
  () => {
    it.each([
      ["manifest-backed plugin", "plugin" as const, "fixture-plugin:bounded"],
      ["original .claude root", "claude_root" as const, ".claude:bounded"]
    ])(
      "loads a selected Skill from a %s with hooks and MCP excluded",
      async (_label, providerKind, name) => {
        const fixture = createFixture(String(providerKind));
        const providerRoot =
          providerKind === "plugin"
            ? path.join(fixture.root, "fixture-plugin")
            : path.join(fixture.home, ".claude");
        fs.mkdirSync(providerRoot, { recursive: true });
        if (providerKind === "plugin") {
          fs.mkdirSync(path.join(providerRoot, ".claude-plugin"), {
            recursive: true
          });
          fs.writeFileSync(
            path.join(providerRoot, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
          );
        }
        createSkill(providerRoot, "bounded", "bounded");
        const hookMarker = path.join(fixture.root, "hook-ran");
        const settingsHookMarker = path.join(fixture.root, "settings-hook-ran");
        const mcpMarker = path.join(fixture.root, "mcp-ran");
        createHook(providerRoot, hookMarker);
        if (providerKind === "claude_root") {
          fs.writeFileSync(
            path.join(providerRoot, "settings.json"),
            JSON.stringify({
              hooks: {
                SessionStart: [
                  {
                    matcher: "",
                    hooks: [
                      {
                        type: "command",
                        command: `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(settingsHookMarker)}, 'ran')`)}`
                      }
                    ]
                  }
                ]
              }
            })
          );
        }
        createMcpSentinel(providerRoot, mcpMarker);
        const providerPath = fs.realpathSync(providerRoot);
        expect(providerKind).toMatch(/^(plugin|claude_root)$/u);
        expect(providerPath).toBe(fs.realpathSync(providerRoot));

        const selectedOptions = buildClaudeManagedPluginSkillOptions({
          selectedNames: [String(name)],
          selectedPluginSkills: [
            {
              name: String(name),
              providerKind,
              providerPath
            }
          ]
        });
        const options = { ...baseOptions(fixture), ...selectedOptions };
        const opened = await openWithoutPrompt(options);
        try {
          expect(opened.init.account?.tokenSource).toBe("none");
          expect(opened.commands).toContain(String(name));
          expect(opened.mcpCount).toBe(0);
          expect(options.settingSources).toEqual([]);
          expect(options.settings).toEqual({
            disableAllHooks: true,
            permissions: { ask: ["*"] }
          });
          expect(options.plugins).toEqual([
            { type: "local", path: providerPath, skipMcpDiscovery: true }
          ]);
          expect(options.skills).toEqual([String(name)]);
          expect(options.strictMcpConfig).toBe(true);
          expect(options.tools).toEqual([]);
          expect(options.allowedTools).toEqual([]);
          expect(fs.existsSync(hookMarker)).toBe(false);
          expect(fs.existsSync(settingsHookMarker)).toBe(false);
          expect(fs.existsSync(mcpMarker)).toBe(false);
        } finally {
          await opened.close();
        }

        // The same temporary hook fires when the isolation setting is omitted,
        // proving that the guarded run did not pass only because the fixture
        // hook was malformed or undiscoverable.
        const control = await openWithoutPrompt({
          ...baseOptions(fixture),
          plugins: [
            { type: "local", path: providerPath, skipMcpDiscovery: true }
          ]
        });
        try {
          expect(control.init.account?.tokenSource).toBe("none");
        } finally {
          await control.close();
        }
        expect(fs.existsSync(hookMarker)).toBe(true);
        expect(fs.existsSync(settingsHookMarker)).toBe(false);
        expect(fs.existsSync(mcpMarker)).toBe(false);
      }
    );

    it("fails closed on duplicate `.claude` command names from user and Project roots", async () => {
      const fixture = createFixture("namespace-collision");
      const userRoot = path.join(fixture.home, ".claude");
      const projectRoot = path.join(fixture.cwd, ".claude");
      createSkill(userRoot, "shared", "shared");
      createSkill(projectRoot, "shared", "shared");

      const bridgeOptions = () =>
        buildClaudeManagedPluginSkillOptions({
          selectedNames: [".claude:shared"],
          selectedPluginSkills: [
            {
              name: ".claude:shared",
              providerKind: "claude_root",
              providerPath: userRoot
            },
            {
              name: ".claude:shared",
              providerKind: "claude_root",
              providerPath: projectRoot
            }
          ]
        });
      expect(bridgeOptions).toThrow();

      const opened = await openWithoutPrompt({
        ...baseOptions(fixture),
        plugins: [userRoot, projectRoot].map((pluginPath) => ({
          type: "local" as const,
          path: pluginPath,
          skipMcpDiscovery: true
        })),
        skills: [".claude:shared"]
      });
      try {
        expect(opened.init.account?.tokenSource).toBe("none");
        expect(
          opened.commands.filter((name) => name === ".claude:shared")
        ).toHaveLength(2);
        expect(opened.mcpCount).toBe(0);
      } finally {
        await opened.close();
      }
    });

    it("uses the actual basename namespace of a custom registered config root", async () => {
      const fixture = createFixture("custom-config-root");
      const providerRoot = path.join(fixture.root, "claude-profile-a");
      createSkill(providerRoot, "folder-name", "slash-name");
      const providerPath = fs.realpathSync(providerRoot);
      const selectedOptions = buildClaudeManagedPluginSkillOptions({
        selectedNames: ["claude-profile-a:slash-name"],
        selectedPluginSkills: [
          {
            name: "claude-profile-a:slash-name",
            providerKind: "claude_root",
            providerPath
          }
        ]
      });
      const opened = await openWithoutPrompt({
        ...baseOptions(fixture),
        ...selectedOptions
      });
      try {
        expect(opened.commands).toContain("claude-profile-a:slash-name");
        expect(opened.init.account?.tokenSource).toBe("none");
        expect(opened.mcpCount).toBe(0);
      } finally {
        await opened.close();
      }
    });

    it("allows isolated loading of an original config root that contains ignored settings files", () => {
      const fixture = createFixture("config-root-settings");
      const providerRoot = path.join(fixture.root, "custom-profile");
      createSkill(providerRoot, "folder-name", "safe-skill");
      fs.writeFileSync(
        path.join(providerRoot, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "touch marker" }] }
            ]
          }
        })
      );
      expect(() =>
        buildClaudeManagedPluginSkillOptions({
          selectedNames: ["custom-profile:safe-skill"],
          selectedPluginSkills: [
            {
              name: "custom-profile:safe-skill",
              providerKind: "claude_root",
              providerPath: fs.realpathSync(providerRoot)
            }
          ]
        })
      ).not.toThrow();
    });

    it.each([
      "context: fork",
      "agent: reviewer",
      "model: claude-test-model",
      "effort: high",
      "hooks:\n  - type: command"
    ])("rejects frontmatter that can change Skill execution (%s)", (field) => {
      const fixture = createFixture("unsafe-frontmatter");
      const pluginRoot = path.join(fixture.root, "fixture-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
      );
      const skillDirectory = path.join(pluginRoot, "skills", "bounded");
      fs.mkdirSync(skillDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(skillDirectory, "SKILL.md"),
        `---\nname: bounded\ndescription: fixture\n${field}\n---\nBody.`
      );
      expect(() =>
        buildClaudeManagedPluginSkillOptions({
          selectedNames: ["fixture-plugin:bounded"],
          selectedPluginSkills: [
            {
              name: "fixture-plugin:bounded",
              providerKind: "plugin",
              providerPath: fs.realpathSync(pluginRoot)
            }
          ]
        })
      ).toThrow();
    });

    it("rejects dynamic Skill shell injection and executable plugin auxiliaries", () => {
      const fixture = createFixture("unsafe-plugin-content");
      const pluginRoot = path.join(fixture.root, "fixture-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
      );
      createSkill(pluginRoot, "bounded", "bounded");
      const selection = {
        name: "fixture-plugin:bounded",
        providerKind: "plugin" as const,
        providerPath: fs.realpathSync(pluginRoot)
      };
      fs.writeFileSync(
        path.join(pluginRoot, "skills", "bounded", "SKILL.md"),
        "---\nname: bounded\ndescription: fixture\n---\nStatus: !`git status`\n"
      );
      expect(() =>
        buildClaudeManagedPluginSkillOptions({
          selectedNames: [selection.name],
          selectedPluginSkills: [selection]
        })
      ).toThrow();

      fs.writeFileSync(
        path.join(pluginRoot, "skills", "bounded", "SKILL.md"),
        "---\nname: bounded\ndescription: fixture\n---\nBody.\n"
      );
      fs.mkdirSync(path.join(pluginRoot, "agents"));
      expect(() =>
        buildClaudeManagedPluginSkillOptions({
          selectedNames: [selection.name],
          selectedPluginSkills: [selection]
        })
      ).toThrow();
    });

    it("shares a bounded Skill-file byte budget across native roots", () => {
      const fixture = createFixture("shared-scan-budget");
      const firstRoot = path.join(fixture.root, "config-a");
      const secondRoot = path.join(fixture.root, "config-b");
      createSkill(firstRoot, "one", "one");
      createSkill(secondRoot, "two", "two");
      const firstFile = path.join(firstRoot, "skills", "one", "SKILL.md");
      const firstBytes = fs.statSync(firstFile).size;
      const budget = { remainingBytes: firstBytes };
      const canonicalFirstRoot = fs.realpathSync(firstRoot);
      const canonicalSecondRoot = fs.realpathSync(secondRoot);

      expect(
        scanClaudeManagedSkillRoot({
          providerKind: "claude_root",
          providerPath: canonicalFirstRoot,
          budget
        }).skillNames
      ).toEqual(["one"]);
      expect(budget.remainingBytes).toBe(0);
      expect(() =>
        scanClaudeManagedSkillRoot({
          providerKind: "claude_root",
          providerPath: canonicalSecondRoot,
          budget
        })
      ).toThrow();
    });

    it("invokes one of two available Skills but does not stack slash commands", async () => {
      const fixture = createFixture("stacked-skill-command");
      const pluginRoot = path.join(fixture.root, "fixture-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
      );
      createSkill(pluginRoot, "first", "first");
      createSkill(pluginRoot, "second", "second");
      fs.writeFileSync(
        path.join(pluginRoot, "skills", "first", "SKILL.md"),
        "---\nname: first\ndescription: first fixture\n---\nFIRST_SKILL_BODY\n"
      );
      fs.writeFileSync(
        path.join(pluginRoot, "skills", "second", "SKILL.md"),
        "---\nname: second\ndescription: second fixture\n---\nSECOND_SKILL_BODY\n"
      );
      const markerPath = path.join(fixture.root, "tool-ran");
      const api = await startFakeAnthropicServer(markerPath);
      const options: Options = {
        ...baseOptions(fixture),
        sessionId: randomUUID(),
        persistSession: true,
        env: {
          ...fixture.env,
          ANTHROPIC_BASE_URL: api.baseUrl,
          ANTHROPIC_API_KEY: "fixture-only-key"
        },
        plugins: [
          {
            type: "local",
            path: fs.realpathSync(pluginRoot),
            skipMcpDiscovery: true
          }
        ],
        skills: ["fixture-plugin:first", "fixture-plugin:second"],
        settings: { disableAllHooks: true, permissions: { ask: ["*"] } },
        tools: ["Bash"],
        allowedTools: [],
        permissionMode: "default",
        canUseTool: async () => ({
          behavior: "deny",
          message: "Denied by fixture callback"
        })
      };
      const stream = query({
        prompt:
          "/fixture-plugin:first\n/fixture-plugin:second original user task",
        options
      });
      try {
        await stream.initializationResult();
        for await (const message of stream) {
          if (message.type === "result") break;
        }
      } finally {
        stream.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await new Promise<void>((resolve) => api.server.close(() => resolve()));
      }
      const skillExpansionRecords = readFixtureTranscriptEntries(
        fixture.config
      ).filter((record) => JSON.stringify(record).includes("FIRST_SKILL_BODY"));
      const skillExpansion = skillExpansionRecords.find(
        (record) => record.type === "user" && record.isMeta === true
      );
      expect(skillExpansion).toBeDefined();
      const skillMessage = jsonRecord(skillExpansion?.message);
      expect(skillMessage?.role).toBe("user");
      const skillContent = skillMessage?.content;
      expect(
        Array.isArray(skillContent) &&
          skillContent.some((block) => {
            const blockRecord = jsonRecord(block);
            return (
              typeof blockRecord?.text === "string" &&
              blockRecord.text.includes("FIRST_SKILL_BODY")
            );
          })
      ).toBe(true);
      expect(skillExpansionRecords.length).toBeGreaterThan(0);
      const firstMessage = textFromFirstRequestMessage(api.requests[0]);
      expect(toolNamesFromRequest(api.requests[0])).toContain("Bash");
      expect(firstMessage).toContain(
        "<command-name>/fixture-plugin:first</command-name>"
      );
      expect(firstMessage).toContain("FIRST_SKILL_BODY");
      expect(firstMessage).not.toContain("SECOND_SKILL_BODY");
      expect(skillExpansionRecords.length).toBeGreaterThan(0);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it.each([
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "dontAsk"
    ] as const)(
      "invokes only the selected native Skill and retains tool denial in %s mode",
      async (permissionMode) => {
        const fixture = createFixture(`permission-${permissionMode}`);
        const pluginRoot = path.join(fixture.root, "fixture-plugin");
        fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
          recursive: true
        });
        fs.writeFileSync(
          path.join(pluginRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
        );
        const skillDirectory = path.join(pluginRoot, "skills", "bounded");
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(skillDirectory, "SKILL.md"),
          "---\nname: bounded\ndescription: temporary permission fixture\nallowed-tools:\n  - Bash\n---\nRun the requested command."
        );
        const providerPath = fs.realpathSync(pluginRoot);
        const selectedOptions = buildClaudeManagedPluginSkillOptions({
          selectedNames: ["fixture-plugin:bounded"],
          selectedPluginSkills: [
            {
              name: "fixture-plugin:bounded",
              providerKind: "plugin",
              providerPath
            }
          ]
        });
        const markerPath = path.join(fixture.root, "tool-ran");
        const api = await startFakeAnthropicServer(markerPath);
        const callbackCalls: Array<{ toolName: string; input: unknown }> = [];
        const options: Options = {
          ...baseOptions(fixture),
          env: {
            ...fixture.env,
            ANTHROPIC_BASE_URL: api.baseUrl,
            ANTHROPIC_API_KEY: "fixture-only-key"
          },
          ...selectedOptions,
          model: "claude-test-model",
          tools: ["Bash"],
          allowedTools: [],
          permissionMode,
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          canUseTool: async (toolName, input) => {
            callbackCalls.push({ toolName, input });
            return { behavior: "deny", message: "Denied by fixture callback" };
          }
        };
        const stream = query({
          prompt: "/fixture-plugin:bounded run the requested command",
          options
        });
        try {
          await stream.initializationResult();
          for await (const message of stream) {
            if (message.type === "result") {
              expect(
                message.permission_denials?.map(({ tool_name }) => tool_name)
              ).toContain("Bash");
              break;
            }
          }
        } finally {
          stream.close();
          await new Promise((resolve) => setTimeout(resolve, 200));
          await new Promise<void>((resolve) =>
            api.server.close(() => resolve())
          );
        }

        expect(api.requests).toHaveLength(2);
        expect(modelFromRequest(api.requests[0])).toBe("claude-test-model");
        expect(toolNamesFromRequest(api.requests[0])).toContain("Bash");
        const inputText = textFromFirstRequestMessage(api.requests[0]);
        expect(inputText).toContain(
          "<command-name>/fixture-plugin:bounded</command-name>"
        );
        expect(inputText).toContain("Base directory for this skill:");
        expect(callbackCalls.map(({ toolName }) => toolName)).toEqual(
          permissionMode === "dontAsk" ? [] : ["Bash"]
        );
        expect(fs.existsSync(markerPath)).toBe(false);
      }
    );
  }
);

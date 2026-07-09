import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROMPT_OVERRIDE_DIR_ENV,
  loadPrompt,
  promptFileNames,
  renderPrompt,
  renderPromptTemplate
} from "../src/prompt-loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const tempPromptDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-prompts-"));
  tempDirs.push(directory);
  return directory;
};

describe("prompt loader", () => {
  it("loads every registered bundled prompt with matching metadata", () => {
    for (const promptId of Object.keys(promptFileNames) as Array<
      keyof typeof promptFileNames
    >) {
      const prompt = loadPrompt(promptId);

      expect(prompt.id).toBe(promptId);
      expect(prompt.version).toMatch(/\S/);
      expect(prompt.body).toMatch(/\S/);
      expect(prompt.sourcePath).toContain(promptFileNames[promptId]);
    }
  });

  it("loads bundled prompts with explicit id and version metadata", () => {
    const prompt = loadPrompt("memory-answer-worker");

    expect(prompt.id).toBe("memory-answer-worker");
    expect(prompt.version).toBe("memory-answer-codex-worker-v3");
    expect(prompt.overridden).toBe(false);
    expect(prompt.body).toContain(
      "You are a private local memory/RAG answer worker"
    );
  });

  it("uses an override prompt file when KOED_PROMPT_DIR contains a matching path", async () => {
    const directory = await tempPromptDir();
    await writeFile(
      path.join(directory, "mcp-server-instructions.md"),
      [
        "---",
        "id: mcp-server-instructions",
        "version: mcp-server-instructions-test",
        "---",
        "Custom self-hosted MCP instructions."
      ].join("\n")
    );

    const prompt = loadPrompt("mcp-server-instructions", {
      env: { [PROMPT_OVERRIDE_DIR_ENV]: directory }
    });

    expect(prompt.version).toBe("mcp-server-instructions-test");
    expect(prompt.overridden).toBe(true);
    expect(prompt.body).toBe("Custom self-hosted MCP instructions.");
  });

  it("falls back to bundled prompts when the override directory omits a file", async () => {
    const directory = await tempPromptDir();
    await mkdir(path.join(directory, "evals"));

    const prompt = loadPrompt("memory-answer-tool-description", {
      env: { [PROMPT_OVERRIDE_DIR_ENV]: directory }
    });

    expect(prompt.overridden).toBe(false);
    expect(prompt.body).toContain("Answer from Koed memory");
  });

  it("fails if an override declares the wrong prompt id", async () => {
    const directory = await tempPromptDir();
    await writeFile(
      path.join(directory, "session-title.md"),
      [
        "---",
        "id: memory-answer-worker",
        "version: bad-override",
        "---",
        "Wrong prompt."
      ].join("\n")
    );

    expect(() =>
      loadPrompt("session-title", {
        env: { [PROMPT_OVERRIDE_DIR_ENV]: directory }
      })
    ).toThrow(/declares id memory-answer-worker/);
  });

  it("renders explicit placeholders and fails on missing values", () => {
    expect(renderPromptTemplate("Hello {{ name }}.", { name: "Koed" })).toBe(
      "Hello Koed."
    );

    expect(() => renderPromptTemplate("Hello {{ name }}.", {})).toThrow(
      /unresolved placeholders: name/
    );
  });

  it("renders dynamic prompts without leaving template placeholders behind", () => {
    const prompt = renderPrompt("session-title", {
      session_id: "session-1",
      external_session_id: "external-1",
      current_title: "none",
      project: "koed",
      title_event_count: 3,
      conversation_excerpts: "1. user: Rename this session."
    });

    expect(prompt).toContain("session_id: session-1");
    expect(prompt).toContain("Rename this session");
    expect(prompt).not.toContain("{{");
  });
});

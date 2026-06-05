import { describe, expect, it } from "vitest";

import { codexIdePromptUserText } from "./codexIdePrompt";

const wrappedPrompt = (
  request: string,
  selectedText = ""
) => `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

${selectedText ? `## Selected text:\n${selectedText}\n\n` : ""}## Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

## My request for Codex:
${request}`;

describe("codexIdePromptUserText", () => {
  it("returns the final rendered Codex request body", () => {
    const prompt = wrappedPrompt(
      "Please review the PR.",
      "const note = '## My request for Codex:';"
    );

    expect(codexIdePromptUserText(prompt)).toBe("Please review the PR.");
  });

  it("keeps image-only wrapper requests hidden", () => {
    expect(
      codexIdePromptUserText(
        wrappedPrompt("<image>local screenshot payload</image>")
      )
    ).toBe("");
  });

  it("keeps image-only wrapper requests hidden after environment context", () => {
    const prompt = `<environment_context>
  <cwd>/Users/jacobo/Coding/koed</cwd>
</environment_context>

${wrappedPrompt("<image name=[Image #1]>local screenshot payload</image>")}`;

    expect(codexIdePromptUserText(prompt)).toBe("");
  });

  it("keeps standalone rendered IDE context hidden", () => {
    const contextOnly = `Context from my IDE setup:

Active file: koed-self-hosted/SECURITY.md

Open tabs:

- SECURITY.md: koed-self-hosted/SECURITY.md
- .env: koed-self-hosted/.env`;

    expect(codexIdePromptUserText(contextOnly)).toBe("");
  });

  it("preserves literal image tags in user-authored requests", () => {
    const request =
      "Please explain why `<image>logo</image>` is invalid HTML in this fixture.";

    expect(codexIdePromptUserText(wrappedPrompt(request))).toBe(request);
  });

  it("does not split marker-like user-authored markdown", () => {
    const prompt = `# Context from my IDE setup:

This is documentation, not Codex client context.

## My request for Codex:
Explain the heading format.`;

    expect(codexIdePromptUserText(prompt)).toBe(prompt);
  });
});

import { describe, expect, it } from "vitest";
import { localRerankingEnabled, presentMemoryText } from "../src/index.js";

describe("memory presentation helpers", () => {
  it("keeps reranking disabled by default and honors the documented root key", () => {
    expect(localRerankingEnabled({})).toBe(false);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).toBe(true);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: ""
      })
    ).toBe(false);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).toBe(true);
  });

  const provenance = {
    project_name: "/Users/jacobo/Coding/koed",
    project_path: "/Users/jacobo/Coding/koed"
  };

  it("does not expose raw tool input JSON as memory text", () => {
    const text = presentMemoryText(
      JSON.stringify({
        toolInput: {
          command:
            "node --input-type=module <<'EOF'\nconsole.log('secret')\nEOF"
        }
      }),
      provenance
    );

    expect(text).toBe("Development activity captured in koed.");
    expect(text).not.toContain("toolInput");
    expect(text).not.toContain("node --input-type");
  });

  it("does not expose malformed tool payload text as memory text", () => {
    const text = presentMemoryText(
      `{"toolInput": {"command": "sed -n '1,140p' deploy/deploy-vps.sh"}, "toolResponse": "partial output...`,
      provenance
    );

    expect(text).toBe("Development activity captured in koed.");
    expect(text).not.toContain("toolResponse");
    expect(text).not.toContain("deploy-vps.sh");
  });

  it("unwraps LCM source outlines without showing internal scaffolding", () => {
    const text = presentMemoryText(
      [
        "LCM depth 0 leaf summary",
        "Source items: 1",
        "",
        "Exact ordered source outline:",
        "- [event memory_events:abc] user: Jacobo prefers concise memory cards."
      ].join("\n"),
      provenance
    );

    expect(text).toBe("Jacobo prefers concise memory cards.");
  });

  it("shows the Codex request instead of uploaded-file boilerplate", () => {
    const text = presentMemoryText(
      [
        "# Files mentioned by the user:",
        "",
        "## CleanShot.png: /Users/jacobo/Library/Application Support/CleanShot/media/file.png",
        "",
        "## My request for Codex:",
        "Can you please find out what is missing on the setup?",
        "<image name=[Image #1]>raw image metadata</image>"
      ].join("\n"),
      provenance
    );

    expect(text).toBe("Can you please find out what is missing on the setup?");
  });

  it("hides image-only Codex requests instead of exposing prompt context", () => {
    const text = presentMemoryText(
      [
        "# Context from my IDE setup:",
        "",
        "## Active file: koed-self-hosted/SECURITY.md",
        "",
        "## Open tabs:",
        "- SECURITY.md: koed-self-hosted/SECURITY.md",
        "",
        "## My request for Codex:",
        "<image name=[Image #1]>raw image metadata</image>"
      ].join("\n"),
      provenance
    );

    expect(text).toBe("Captured memory.");
    expect(text).not.toContain("Context from my IDE setup");
    expect(text).not.toContain("Open tabs");
  });
});

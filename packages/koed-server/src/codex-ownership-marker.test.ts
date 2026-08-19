import { describe, expect, it } from "vitest";
import {
  hasCodexOwnershipBlock,
  parseCodexOwnershipBlock,
  stripCodexOwnershipBlock
} from "./codex-ownership-marker.js";

describe("Codex ownership markers", () => {
  it("ignores marker-like unrelated text", () => {
    const content = 'message = "# >>> koed"\n# >>> koed-old\n';
    expect(parseCodexOwnershipBlock(content).kind).toBe("absent");
    expect(stripCodexOwnershipBlock(content)).toBe(content);
  });

  it.each([
    "# >>> koed\n[mcp_servers.koed]\n",
    "# <<< koed\n[mcp_servers.koed]\n",
    "# >>> koed\n# >>> koed\n# <<< koed\n",
    "# >>> koed\n# <<< koed\n# <<< koed\n"
  ])("rejects malformed marker block without mutation", (content) => {
    expect(parseCodexOwnershipBlock(content).kind).toBe("malformed");
    expect(() => stripCodexOwnershipBlock(content)).toThrow();
  });

  it("strips one complete block and preserves unrelated profile bytes", () => {
    const content =
      'profile = "operator"\n# >>> koed\n[mcp_servers.koed]\n# <<< koed\nother = true\n';
    expect(hasCodexOwnershipBlock(content)).toBe(true);
    expect(stripCodexOwnershipBlock(content)).toBe(
      'profile = "operator"\nother = true\n'
    );
  });
});

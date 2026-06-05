// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import type { GraphEvent } from "./types";
import { summarizePatchDetails, patchSummaryText } from "./diff";

const makePatchEvent = (
  patchText: string
): Pick<GraphEvent, "content" | "contentFull" | "rawContent" | "metadata"> => ({
  content: `Tool call: apply_patch\n\nInput:\n${patchText}`,
  contentFull: `Tool call: apply_patch\n\nInput:\n${patchText}`,
  rawContent: `Tool call: apply_patch\n\nInput:\n${patchText}`,
  metadata: {
    toolCall: {
      id: "call_patch",
      kind: "call",
      name: "apply_patch",
      type: "custom_tool_call",
      input: patchText,
      status: "completed"
    },
    rawTranscriptPayload: {
      type: "custom_tool_call",
      name: "apply_patch",
      input: patchText,
      status: "completed"
    }
  }
});

describe("patch diff summary helpers", () => {
  it("normalizes Codex apply_patch text into a renderable patch summary", () => {
    const patchText = `*** Begin Patch
*** Update File: /Users/jedd/repos/dotfiles/macos.sh
@@
-# Note: if you’re in the US, replace \`EUR\` with \`USD\`, \`Centimeters\` with
-# \`Inches\`, \`en_GB\` with \`en_US\`, and \`true\` with \`false\`.
+# Note: this repository is documented for a US setup.
 defaults write NSGlobalDomain AppleLanguages -array "en"
-defaults write NSGlobalDomain AppleLocale -string "en_GB@currency=USD"
-defaults write NSGlobalDomain AppleMeasurementUnits -string "Centimeters"
-defaults write NSGlobalDomain AppleMetricUnits -bool true
+defaults write NSGlobalDomain AppleLocale -string "en_US@currency=USD"
+defaults write NSGlobalDomain AppleMeasurementUnits -string "Inches"
+defaults write NSGlobalDomain AppleMetricUnits -bool false
*** End Patch
`;

    const details = summarizePatchDetails(makePatchEvent(patchText));

    expect(details).not.toBeNull();
    expect(details?.supported).toBe(true);
    expect(details?.files).toHaveLength(1);
    expect(details?.fileDiffs).toHaveLength(1);
    expect(details?.files[0]).toMatchObject({
      displayName: "macos.sh",
      name: "Users/jedd/repos/dotfiles/macos.sh"
    });
    expect(details?.normalizedText).toContain(
      "diff --git a/Users/jedd/repos/dotfiles/macos.sh b/Users/jedd/repos/dotfiles/macos.sh"
    );
    expect(details?.normalizedText).toContain(
      "--- a/Users/jedd/repos/dotfiles/macos.sh"
    );
    expect(details?.normalizedText).toContain(
      "+++ b/Users/jedd/repos/dotfiles/macos.sh"
    );
    expect(details?.additions).toBeGreaterThan(0);
    expect(details?.deletions).toBeGreaterThan(0);
    expect(patchSummaryText(details!)).toContain("macos.sh");
    expect(patchSummaryText(details!)).toContain("file changed");
  });

  it("falls back to raw text when a patch-like payload cannot be normalized", () => {
    const details = summarizePatchDetails(
      makePatchEvent(`*** Begin Patch
*** End Patch
`)
    );

    expect(details).not.toBeNull();
    expect(details?.supported).toBe(false);
    expect(details?.parseError).toBeDefined();
    expect(patchSummaryText(details!)).toContain("showing raw text");
  });

  it("returns null for ordinary non-patch text", () => {
    const details = summarizePatchDetails({
      content: "Just a normal tool output",
      contentFull: "Just a normal tool output",
      rawContent: "Just a normal tool output",
      metadata: {}
    });

    expect(details).toBeNull();
  });

  it("allows zero-count synthetic hunks for pure adds and deletes", () => {
    const addDetails = summarizePatchDetails(
      makePatchEvent(`*** Begin Patch
*** Add File: /Users/jedd/repos/example/new-file.txt
@@
+hello
*** End Patch
`)
    );
    const deleteDetails = summarizePatchDetails(
      makePatchEvent(`*** Begin Patch
*** Delete File: /Users/jedd/repos/example/old-file.txt
@@
-goodbye
*** End Patch
`)
    );

    expect(addDetails?.normalizedText).toContain("@@ -0,0 +1,1 @@");
    expect(deleteDetails?.normalizedText).toContain("@@ -1,1 +0,0 @@");
  });
});

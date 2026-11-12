import { describe, expect, it } from "vitest";
import {
  RECALL_CALLER_LABEL_CHARACTERS,
  recallCallerLabel,
  recallCallerSchema
} from "./recall-activity.js";

describe("Recall caller labels", () => {
  it("keeps ordinary AI Client names and versions", () => {
    for (const label of [
      "claude-code",
      "Visual Studio Code",
      "@modelcontextprotocol/inspector (dev)",
      "1.2.3-beta+build.5"
    ]) {
      expect(recallCallerLabel(label, 128)).toBe(label);
      expect(
        recallCallerSchema.safeParse({ name: label, version: null }).success
      ).toBe(true);
    }
  });

  it("reduces other reported text to a storable label", () => {
    const label = recallCallerLabel(
      "  evil\n<script>name</script>\u0000: \u202Edrow  ",
      128
    );
    expect(label).toBe("evil script name /script drow");
    expect(
      recallCallerSchema.safeParse({ name: label, version: label }).success
    ).toBe(true);
    expect(recallCallerLabel("x".repeat(200), 64)).toHaveLength(64);
    // Labels are ASCII so the database can apply the identical test.
    expect(recallCallerLabel("Zed \u7de8\u96c6 2", 128)).toBe("Zed 2");
    expect(
      recallCallerSchema.safeParse({ name: "caf\u00e9", version: null }).success
    ).toBe(false);
  });

  it("builds its pattern from the shared character list", () => {
    for (const character of RECALL_CALLER_LABEL_CHARACTERS.replace(" ", ""))
      expect(
        recallCallerSchema.safeParse({ name: character, version: character })
          .success,
        character
      ).toBe(true);
    for (const character of "\\]^[\"'`,:;<>&%$#!?*=~|{}\t\n")
      expect(
        recallCallerSchema.safeParse({ name: `a${character}b`, version: null })
          .success,
        character
      ).toBe(false);
  });

  it("reports no label when nothing storable remains", () => {
    for (const value of ["", "   ", "<>:;\n", undefined, 7, { name: "x" }])
      expect(recallCallerLabel(value, 128)).toBeNull();
  });

  it("rejects unsanitized caller text at the storage boundary", () => {
    for (const name of ["line\nbreak", "key: value", "<b>", "tab\there"])
      expect(
        recallCallerSchema.safeParse({ name, version: null }).success
      ).toBe(false);
    expect(
      recallCallerSchema.safeParse({ name: "codex", version: "1;drop" }).success
    ).toBe(false);
  });
});

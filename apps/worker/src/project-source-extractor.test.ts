import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractProjectSourceText,
  ProjectSourceExtractionError
} from "./project-source-extractor.js";
import { extractProjectSourceTextBounded } from "./project-source-extractor-client.js";

const fixture = (name: string) =>
  readFile(new URL(`../test-fixtures/${name}`, import.meta.url));

describe("Project Source deterministic extraction", () => {
  it("reads actual PDF text and DOCX, including a blank first PDF page", async () => {
    const syllabus = await extractProjectSourceTextBounded({
      name: "Syllabus.pdf",
      bytes: await fixture("Syllabus.pdf")
    });
    const plan = await extractProjectSourceTextBounded({
      name: "Plan.docx",
      bytes: await fixture("Plan.docx")
    });
    const mixed = await extractProjectSourceTextBounded({
      name: "Mixed.pdf",
      bytes: await fixture("Mixed.pdf")
    });
    expect(syllabus).toContain("source provenance");
    expect(plan).toContain("preserve original binary");
    expect(mixed).toContain("Second page has searchable text");
  });

  it("reports image-only PDF as no_text_layer and unsupported types honestly", async () => {
    await expect(
      extractProjectSourceTextBounded({
        name: "Scanned.pdf",
        bytes: await fixture("Scanned.pdf")
      })
    ).rejects.toMatchObject({ reason: "no_text_layer" });
    await expect(
      extractProjectSourceText({
        name: "image.png",
        bytes: Buffer.from("image")
      })
    ).rejects.toMatchObject({ reason: "unsupported_type" });
  });

  it("rejects a DOCX whose actual inflation differs from its directory claim", async () => {
    const bytes = Buffer.from(await fixture("Plan.docx"));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(1, central + 24);
    await expect(
      extractProjectSourceText({ name: "Plan.docx", bytes })
    ).rejects.toBeInstanceOf(ProjectSourceExtractionError);
  });

  it("preserves over 32 KiB of plain text without truncation", async () => {
    const body = "course topic\n".repeat(4_000);
    expect(Buffer.byteLength(body)).toBeGreaterThan(32_768);
    expect(
      await extractProjectSourceTextBounded({
        name: "Notes.md",
        bytes: Buffer.from(body)
      })
    ).toBe(body);
  });
});

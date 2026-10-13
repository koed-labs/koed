import fs from "node:fs";

const ADR_FILE_PATTERN = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;
const IGNORED_FILES = new Set(["README.md"]);

export function findAdrNumberProblems(fileNames) {
  const filesByNumber = new Map();
  const invalidNames = [];

  for (const fileName of [...fileNames].sort()) {
    if (IGNORED_FILES.has(fileName) || !fileName.endsWith(".md")) continue;
    const match = ADR_FILE_PATTERN.exec(fileName);
    if (!match) {
      invalidNames.push(fileName);
      continue;
    }
    const files = filesByNumber.get(match[1]) ?? [];
    files.push(fileName);
    filesByNumber.set(match[1], files);
  }

  const duplicates = [...filesByNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({ number, files }));

  return { duplicates, invalidNames };
}

export function formatAdrNumberProblems({ duplicates, invalidNames }) {
  const lines = [];
  for (const { number, files } of duplicates) {
    lines.push(`ADR number ${number} is used by more than one file:`);
    for (const file of files) lines.push(`  - ${file}`);
  }
  for (const name of invalidNames) {
    lines.push(`ADR file name must match NNNN-lowercase-slug.md: ${name}`);
  }
  return lines.join("\n");
}

export function checkAdrDirectory(directory) {
  return findAdrNumberProblems(fs.readdirSync(directory));
}

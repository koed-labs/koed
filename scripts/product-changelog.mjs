export const markers = (text, pattern) => {
  const result = [];
  let offset = 0;
  let fence = null;
  for (const line of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
    if (delimiter) {
      const token = delimiter[1];
      if (!fence) fence = token;
      else if (token[0] === fence[0] && token.length >= fence.length)
        fence = null;
    } else if (!fence && pattern.test(line)) {
      result.push({ index: offset, text: line.trimEnd() });
    }
    offset += line.length;
  }
  return result;
};

const releaseSection = (changelog, version) => {
  const headings = markers(changelog, /^## /);
  const index = headings.findIndex(
    (heading) => heading.text === `## ${version}`
  );
  if (index < 0) return null;
  const start = headings[index].index;
  const end = headings[index + 1]?.index ?? changelog.length;
  return {
    start,
    end,
    body: changelog.slice(start + headings[index].text.length, end).trim()
  };
};

const insertRelease = (changelog, version) => {
  if (releaseSection(changelog, version)) return changelog;
  const titleEnd = changelog.indexOf("\n");
  if (titleEnd < 0)
    throw new Error("Changelog must have a title followed by a newline");
  const rest = changelog.slice(titleEnd + 1).replace(/^\n*/, "");
  return `${changelog.slice(0, titleEnd)}\n\n## ${version}\n${rest ? `\n${rest}` : ""}`;
};

const blocks = (text) => {
  const starts = markers(text, /^- /).map((marker) => marker.index);
  if (starts[0] !== 0) starts.unshift(0);
  return starts
    .map((start, i) => text.slice(start, starts[i + 1]).trim())
    .filter(Boolean);
};

const mergeBody = (body, source) => {
  const headings = markers(source, /^### /);
  const sections = [{ index: 0, text: "" }, ...headings];
  for (let i = 0; i < sections.length; i++) {
    const { index, text: heading } = sections[i];
    const content = source
      .slice(index + heading.length, sections[i + 1]?.index)
      .trim();
    for (const block of blocks(content)) {
      const bodyHeadings = markers(body, /^### /);
      const boundaries = [{ index: 0, text: "" }, ...bodyHeadings];
      const existing = boundaries.flatMap((section, j) =>
        blocks(
          body.slice(
            section.index + section.text.length,
            boundaries[j + 1]?.index
          )
        )
      );
      if (existing.includes(block)) continue;
      const current = markers(body, /^### /);
      const target = current.findIndex((section) => section.text === heading);
      if (heading && target < 0) {
        body = [body, `${heading}\n\n${block}`].filter(Boolean).join("\n\n");
      } else {
        const end = heading
          ? (current[target + 1]?.index ?? body.length)
          : (current[0]?.index ?? body.length);
        body = [
          body.slice(0, end).trimEnd(),
          block,
          body.slice(end).trimStart()
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }
  }
  return body;
};

export const syncChangelogs = ({ root, desktop, product, server, version }) => {
  root = insertRelease(root, version);
  desktop = insertRelease(desktop, version);
  const section = releaseSection(root, version);
  let body = section.body;
  for (const source of [product, server])
    body = mergeBody(body, releaseSection(source, version)?.body ?? "");
  const suffix = root.slice(section.end);
  const current = `## ${version}${body ? `\n\n${body}` : ""}\n`;
  return {
    root: `${root.slice(0, section.start)}${current}${suffix ? `\n${suffix}` : ""}`,
    desktop
  };
};

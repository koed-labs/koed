// Captured requests and replies are often Markdown. The Kin preview is a few
// plain lines, so drop the syntax and keep the words.
export function previewText(markdown: string): string {
  return (
    markdown
      // Fenced code blocks say little in a short preview.
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      // Images, then links: keep the visible text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Inline code keeps its contents.
      .replace(/`([^`]*)`/g, "$1")
      // Bold, italic and strikethrough markers.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      // Line-start markers: headings, quotes, list bullets and numbers.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

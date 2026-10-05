/** A short first-message label, available without another model request. */
export function conversationTitleFromPrompt(prompt: string): string {
  const text = prompt
    .replace(
      /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi,
      " "
    )
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, "$2")
    .replace(/[`*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .replace(
      /^(?:please\s+|can you\s+|could you\s+|would you\s+|help me\s+)/i,
      ""
    )
    .trim();
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const words = sentence.split(" ").slice(0, 10).join(" ");
  const title = Array.from(words).slice(0, 64).join("").trim();
  return title
    ? title.charAt(0).toLocaleUpperCase() + title.slice(1)
    : "New conversation";
}

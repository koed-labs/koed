const CODEX_IDE_CONTEXT_HEADER = /^#{0,6}\s*Context from my IDE setup:\s*$/i;
const CODEX_IDE_REQUEST_HEADER = /^#{0,6}\s*My request for Codex:\s*$/gim;
const CODEX_IDE_CONTEXT_SECTION =
  /^#{0,6}\s*(Active file|Open tabs|Selected text|Selected file):\s*$/im;
const IMAGE_TAG = /<image\b[\s\S]*?<\/image>/gi;
const IMAGE_TAGS_ONLY = /^(?:\s*<image\b[\s\S]*?<\/image>\s*)+$/i;
const ENVIRONMENT_CONTEXT_ONLY =
  /^(?:<environment_context\b[^>]*>[\s\S]*?<\/environment_context>\s*)+$/i;

function codexIdeContextStart(value: string): number | null {
  let offset = 0;
  for (const line of value.split("\n")) {
    if (CODEX_IDE_CONTEXT_HEADER.test(line)) {
      const prefix = value.slice(0, offset).trim();
      return !prefix || ENVIRONMENT_CONTEXT_ONLY.test(prefix) ? offset : null;
    }
    offset += line.length + 1;
  }
  return null;
}

export function codexIdePromptUserText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const contextStart = codexIdeContextStart(normalized);
  if (contextStart === null) {
    return value;
  }
  const prompt = normalized.slice(contextStart);

  const requestHeaders = [...prompt.matchAll(CODEX_IDE_REQUEST_HEADER)];
  const requestHeader = requestHeaders.at(-1);
  if (!requestHeader || requestHeader.index === undefined) {
    return CODEX_IDE_CONTEXT_SECTION.test(prompt) ? "" : value;
  }

  const ideContext = prompt.slice(0, requestHeader.index).trim();
  if (!CODEX_IDE_CONTEXT_SECTION.test(ideContext)) {
    return value;
  }

  const userPrompt = prompt
    .slice(requestHeader.index + requestHeader[0].length)
    .trim();
  return IMAGE_TAGS_ONLY.test(userPrompt)
    ? userPrompt.replace(IMAGE_TAG, "").trim()
    : userPrompt;
}

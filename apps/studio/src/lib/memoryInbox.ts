import { createId } from "./id";

// Memory Inbox: a Dropbox-style drop point into the memory layer. You add
// links or files here (Personal side, same as Agents), they go through a
// believable async ingestion pipeline, and once Ready they're indexed
// content anyone you've shared them with can draw on - the same way a past
// conversation already is, just sourced from outside the app instead of
// from chat.

export const MEMORY_ITEM_TYPES = [
  "github-repo",
  "youtube",
  "web-link",
  "pdf",
  "docx",
  "markdown",
  "csv",
  "text",
] as const;

export type MemoryItemType = (typeof MEMORY_ITEM_TYPES)[number];

export const MEMORY_ITEM_TYPE_LABEL: Record<MemoryItemType, string> = {
  "github-repo": "GitHub repo",
  youtube: "YouTube video",
  "web-link": "Web link",
  pdf: "PDF",
  docx: "Word doc",
  markdown: "Markdown",
  csv: "CSV",
  text: "Text file",
};

// Whether this type was added by pasting a link or uploading a file - used
// by the "Files" filter chip and to decide how to render the source.
export function isLinkType(type: MemoryItemType) {
  return type === "github-repo" || type === "youtube" || type === "web-link";
}

export type MemoryItemStatus = "queued" | "indexing" | "ready" | "failed";

export type MemoryItem = {
  id: string;
  ownerId: string;
  type: MemoryItemType;
  title: string;
  source: string; // URL for links, file name for uploads
  tags: string[];
  addedAt: number;
  statusChangedAt: number;
  status: MemoryItemStatus;
  sharedWith: string[]; // team ids
  summary?: string; // set once Ready - "what Koed extracted"
  meta?: string; // set once Ready - a short type-appropriate stat line
  failureReason?: string; // set once Failed
};

// --- Adding items ------------------------------------------------------

export function detectLinkType(url: string): MemoryItemType {
  const lower = url.toLowerCase();
  if (lower.includes("github.com")) return "github-repo";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  return "web-link";
}

export function detectFileType(fileName: string): MemoryItemType {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  return "text";
}

// A best-effort starting title from the raw source, so the add flow never
// hands you a blank field - but it's always editable before you confirm.
export function titleFromLink(url: string, type: MemoryItemType): string {
  try {
    const parsed = new URL(url);
    if (type === "github-repo") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      return parsed.hostname.replace(/^www\./, "");
    }
    if (type === "youtube") {
      return "YouTube video";
    }
    const path = parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^./]+$/, "");
}

// --- The faked ingestion pipeline --------------------------------------
//
// Queued -> Indexing -> Ready (or, occasionally, Failed). Timings are
// tuned to feel like something is actually happening without making you
// wait around - see the ticking effect in WorkspaceProvider that advances
// items past these thresholds.
export const QUEUED_MS = 1200;
export const INDEXING_MS = 2600;
export const FAILURE_RATE = 0.12;

export function generateMemorySummary(item: { type: MemoryItemType; title: string }): string {
  switch (item.type) {
    case "github-repo":
      return `Indexed the ${item.title} repository — its README, top-level structure, and recent commit history are now searchable in memory.`;
    case "youtube":
      return `Transcribed "${item.title}" and indexed its key topics and timestamps, so anyone can ask about specific moments in it.`;
    case "web-link":
      return `Crawled and indexed the page at "${item.title}" — its text content is now part of memory.`;
    case "pdf":
      return `Extracted and indexed the text of ${item.title}, chunked by section for retrieval.`;
    case "docx":
      return `Extracted and indexed the text of ${item.title}, preserving headings for retrieval.`;
    case "markdown":
      return `Indexed ${item.title} section by section, following its existing headings.`;
    case "text":
      return `Indexed the contents of ${item.title}, chunked for retrieval.`;
    case "csv":
      return `Indexed ${item.title} as structured data — its columns and rows are now queryable, not just searchable as text.`;
    default:
      return `Indexed ${item.title}.`;
  }
}

const REPO_LANGUAGES = ["TypeScript", "Python", "Go", "Rust", "JavaScript"];

export function generateMemoryMeta(item: { type: MemoryItemType }): string {
  switch (item.type) {
    case "github-repo": {
      const files = 40 + Math.floor(Math.random() * 900);
      const language = REPO_LANGUAGES[Math.floor(Math.random() * REPO_LANGUAGES.length)];
      return `${files} files · ${language}`;
    }
    case "youtube": {
      const minutes = 3 + Math.floor(Math.random() * 42);
      const seconds = Math.floor(Math.random() * 60);
      return `${minutes}:${String(seconds).padStart(2, "0")} runtime`;
    }
    case "web-link": {
      const words = 300 + Math.floor(Math.random() * 2200);
      return `${words.toLocaleString()} words`;
    }
    case "pdf":
    case "docx": {
      const pages = 2 + Math.floor(Math.random() * 60);
      return `${pages} pages`;
    }
    case "markdown":
    case "text": {
      const words = 100 + Math.floor(Math.random() * 3000);
      return `${words.toLocaleString()} words`;
    }
    case "csv": {
      const rows = 20 + Math.floor(Math.random() * 5000);
      const columns = 3 + Math.floor(Math.random() * 12);
      return `${rows.toLocaleString()} rows · ${columns} columns`;
    }
    default:
      return "";
  }
}

export function randomFailureReason(type: MemoryItemType): string {
  if (type === "github-repo") {
    return "Couldn't clone this repository — it may be private, or the link may be wrong.";
  }
  if (type === "youtube") {
    return "Couldn't fetch a transcript for this video — captions may be disabled.";
  }
  if (type === "web-link") {
    return "Couldn't reach that page — it may require a login or block automated access.";
  }
  return "Couldn't read this file — it may be corrupted or password protected.";
}

export function createMemoryItem(input: {
  ownerId: string;
  type: MemoryItemType;
  title: string;
  source: string;
  tags: string[];
}): MemoryItem {
  const now = Date.now();
  return {
    id: createId("memory"),
    ownerId: input.ownerId,
    type: input.type,
    title: input.title.trim(),
    source: input.source.trim(),
    tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
    addedAt: now,
    statusChangedAt: now,
    status: "queued",
    sharedWith: [],
  };
}

export function memoryItemStatusLabel(status: MemoryItemStatus) {
  if (status === "queued") return "Queued";
  if (status === "indexing") return "Indexing";
  if (status === "failed") return "Failed";
  return "Ready";
}

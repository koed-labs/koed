import type { Project, Thread } from "./workspace";
import { titleFromPrompt } from "./workspace";

// A "build" milestone is just an already-answered exchange in a project's
// thread, read as a unit of work rather than as two chat bubbles. There is
// no separate simulation here on purpose - Chat mode's build progress is a
// different lens on the same conversation, not a second fake pipeline.
export type BuildMilestone = {
  id: string;
  label: string;
  summary: string;
  detail: string;
  at: number;
  file: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
};

const FILE_EXTENSIONS = ["tsx", "ts", "css"] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "update";
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max).trim()}…`;
}

export function buildMilestonesForThread(thread: Thread | null): BuildMilestone[] {
  if (!thread) return [];
  const milestones: BuildMilestone[] = [];
  for (let i = 0; i < thread.messages.length; i++) {
    const request = thread.messages[i];
    if (request.role !== "user") continue;
    const reply = thread.messages[i + 1];
    if (!reply || reply.role !== "agent") continue;
    const seed = hashString(request.id);
    const label = titleFromPrompt(request.content);
    milestones.push({
      id: request.id,
      label,
      summary: truncate(reply.content, 90),
      detail: reply.content,
      at: reply.createdAt,
      file: `src/${slugify(label)}.${FILE_EXTENSIONS[seed % FILE_EXTENSIONS.length]}`,
      filesChanged: 1 + (seed % 5),
      linesAdded: 6 + (seed % 140),
      linesRemoved: seed % 45,
    });
  }
  return milestones;
}

export function totalsFor(milestones: BuildMilestone[]) {
  return milestones.reduce(
    (totals, milestone) => ({
      filesChanged: totals.filesChanged + milestone.filesChanged,
      linesAdded: totals.linesAdded + milestone.linesAdded,
      linesRemoved: totals.linesRemoved + milestone.linesRemoved,
    }),
    { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
  );
}

// The plain-language read of a project's git status - the whole point of
// Story mode is that a vibe coder never needs to know what "dirty" means.
export function gitStatusStory(status: Project["gitStatus"]): string {
  switch (status) {
    case "clean":
      return "Everything is saved";
    case "dirty":
      return "Some changes aren't saved yet";
    case "syncing":
      return "Saving now";
    default:
      return "Up to date";
  }
}

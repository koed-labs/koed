// Deterministic "same team/project = same color" tagging for the Home feed
// (and anywhere else that wants a quick visual anchor for a team or
// product). Deliberately separate from the semantic tokens
// (accent/success/warning/danger/merged) - these never carry a status
// meaning, they only ever mean "this belongs to X".

const TEAM_TONE = [
  { chip: "bg-team-1/12 text-team-1", solid: "bg-team-1" },
  { chip: "bg-team-2/12 text-team-2", solid: "bg-team-2" },
  { chip: "bg-team-3/12 text-team-3", solid: "bg-team-3" },
  { chip: "bg-team-4/12 text-team-4", solid: "bg-team-4" },
  { chip: "bg-team-5/12 text-team-5", solid: "bg-team-5" },
  { chip: "bg-team-6/12 text-team-6", solid: "bg-team-6" },
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// A stable index (and the matching Tailwind classes) for a given id/name -
// the same seed always lands on the same tone, so a team's color stays
// consistent everywhere it shows up.
export function teamTone(seed: string) {
  return TEAM_TONE[hashString(seed) % TEAM_TONE.length];
}

export const DEFAULT_PIXELKIN_SPEC: Record<string, unknown> = {
  seed: 4812,
  body: { shape: "roundedBox" },
  face: { expression: "happy" },
  palette: { base: "#7658e8" },
};

export function initialsFor(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

import { LockKeyhole, UsersRound } from "lucide-react";
import type { HqVisibility } from "./hq-visibility.js";

/** Shared by each HQ composer host, regardless of its placement. */
export function HqVisibilityLine({ visibility }: { visibility: HqVisibility }) {
  if (visibility === "unverified") return null;
  const shared =
    typeof visibility === "object" && visibility.kind === "shared-summary";
  const label =
    visibility === "personal-private"
      ? "Just me"
      : shared
        ? visibility.label
        : `Just me · not shared with ${visibility.teamName}`;
  const hover =
    shared && visibility.people.length
      ? visibility.people.join(", ")
      : undefined;
  return (
    <div
      className="hq-composer__visibility"
      aria-label="Conversation visibility"
      title={hover}
    >
      {shared ? (
        <UsersRound aria-hidden="true" size={13} strokeWidth={2} />
      ) : (
        <LockKeyhole aria-hidden="true" size={13} strokeWidth={2} />
      )}
      <span>{label}</span>
    </div>
  );
}

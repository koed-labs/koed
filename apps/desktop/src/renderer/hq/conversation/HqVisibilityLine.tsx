import { LockKeyhole, UsersRound } from "lucide-react";
import type { HqVisibility } from "./hq-visibility.js";
import { soloEdition } from "../../edition.js";

/** Shared by each HQ composer host, regardless of its placement. */
export function HqVisibilityLine({
  visibility,
  onManage
}: {
  visibility: HqVisibility;
  onManage?: () => void;
}) {
  if (visibility === "unverified") return null;
  // In Solo nothing can be shared, so a "Just me" lock on every conversation
  // says nothing. Only shared conversations will be marked there.
  if (visibility === "personal-private" && soloEdition()) return null;
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
      {shared && onManage ? (
        <button type="button" className="vis-m" onClick={onManage}>
          Manage
        </button>
      ) : null}
    </div>
  );
}

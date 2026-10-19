import { LockKeyhole } from "lucide-react";
import type { HqVisibility } from "./hq-visibility.js";

/** Shared by each HQ composer host, regardless of its placement. */
export function HqVisibilityLine({ visibility }: { visibility: HqVisibility }) {
  if (visibility !== "personal-private") return null;
  return (
    <div
      className="hq-composer__visibility"
      aria-label="Conversation visibility"
    >
      <LockKeyhole aria-hidden="true" size={13} strokeWidth={2} />
      <span>Just me</span>
    </div>
  );
}

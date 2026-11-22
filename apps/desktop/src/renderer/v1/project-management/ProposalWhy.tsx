import { Tooltip, TooltipPopup, TooltipTrigger } from "@koed-labs/ui";
import type { FolderProposal } from "./folder-hint-suggestion.js";
import { evidenceLines, proposalLead, proposalNote } from "./proposal-text.js";

/** Hidden until its wording is ready; the evidence text still drives tests of
 * `proposal-text.ts`. Flip to show the `?` again. */
export const SHOW_PROPOSAL_WHY = false;

/** The `?` beside a suggestion: hovering shows, at once, what is suggested and
 * the evidence for it, strongest first. */
export function ProposalWhy({
  proposal,
  context,
  anchor,
  client,
  label = "Why this suggestion",
  className = "v1-pm-context-why"
}: {
  proposal: FolderProposal;
  /** Which dialog it sits in, so any note is true there. */
  context: "bulk" | "single";
  /** The Git Anchor's display name, for a Git remote suggestion. */
  anchor?: string;
  /** The AI Client's name, for a worktree it recorded. */
  client?: string;
  label?: string;
  className?: string;
}) {
  if (!SHOW_PROPOSAL_WHY) return null;
  const note = proposalNote(proposal, context);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        className={className}
        delay={0}
        aria-label={label}
      >
        ?
      </TooltipTrigger>
      <TooltipPopup role="tooltip" className="v1-pm-why-popup">
        <div className="v1-pm-why">
          <strong className="v1-pm-why-lead">{proposalLead(proposal)}</strong>
          <ul className="v1-pm-why-facts">
            {evidenceLines(proposal, {
              ...(anchor ? { anchor } : {}),
              ...(client ? { client } : {})
            }).map((line, index) => (
              <li key={index}>
                {line.text}
                {line.detail && (
                  <span className="v1-pm-why-detail"> {line.detail}</span>
                )}
              </li>
            ))}
          </ul>
          {note && <p className="v1-pm-why-note">{note}</p>}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

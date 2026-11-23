# ADR 0070: Inferred Git Anchors for Unresolved History

## Status

Accepted.

Narrows the historical-capture rule that never infers source facts from today's
path. It does not change live capture, ADR 0064's anchor selection, or Folder
assignment.

## Context

Conversations imported from history, rather than captured as they start, record
an unresolved Git Anchor (`probe_ambiguous`), because the importer cannot know
the checkout's state at the time. On one test machine this was 113 of 140
Conversations. Git Anchor rules cannot match them, so a User has to add each one
by hand even when the evidence is plain: the recorded directory still exists on
the same device, it existed before the Conversation started, and its remote
today names a Git Anchor a Project already uses.

## Decision

Koed Desktop records that Git Anchor itself when every one of these holds:

- The Conversation recorded a directory, which still exists on this device.
- This device recorded the Conversation.
- The directory existed before the Conversation started.
- The directory's selected remote today names the Git Anchor (ADR 0064).
- No evidence rejects it, and exactly one Git Anchor is proven.
- Some Project already knows that Git Anchor.
- The Conversation's Git Anchor is unresolved and the User never corrected it.

It writes through the same versioned, replicated source correction a User's
review uses, so a later User correction replaces it. Folders are never inferred:
a Folder needs a registered Folder, which stays a User decision.

## Consequences

- Git Anchor rules include most historical Conversations without a click.
- The remaining risk is a checkout whose remote was repointed after the
  Conversation, which the birthtime check cannot catch. A User can correct it.
- An inferred Git Anchor is stored as a correction, so it is not distinguished
  from a User's own in the source-context history.

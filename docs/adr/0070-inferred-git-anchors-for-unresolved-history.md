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
- Trusted source evidence identifies this device as the recording device.
  Importing a transcript here, or not finding a sync replica, does not establish this.
- The directory existed before a trustworthy source start. Import time and
  filesystem creation time of the transcript are not source starts.
- Capture's remote-selection rules resolve the directory to one portable Git Anchor
  without a conflict (ADR 0064), and a Project already uses that Git Anchor.
- The Conversation was imported with an unresolved Git Anchor and has no prior Git Anchor
  correction, including a reset to the original.

The write is versioned and guarded; it supplies the effective Git Anchor without
changing the original. A later User correction replaces it. Device sync is not
required. Current historical records do not establish the recording device, so
existing imports do not qualify for unattended inference. If the recording
device is unknown, the User can review and accept eligible suggestions together
in Project settings. These are manual source corrections, not attestations:
Desktop checks the checkout, and the API enforces stored eligibility and the
reviewed versions. Known copied history is not automatically assigned. Folders
are never inferred.

## Consequences

- Git Anchor rules can include qualifying historical Conversations without a click.
  Coverage depends on available provenance; incomplete evidence stays advisory.
- The remaining risk is a checkout whose remote was repointed after the
  Conversation, which the birthtime check cannot catch. A User can correct it.
- An inferred Git Anchor is stored as a correction, so it is not distinguished
  from a User's own in the source-context history.

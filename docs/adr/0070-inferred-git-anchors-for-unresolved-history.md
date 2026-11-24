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
- The recording device is established by trusted source evidence, or Koed
  assumes local origin from a historical import bound to this Desktop's device
  and deployment. The assumption requires a positively ingested historical prefix
  of a local AI Client artifact, with no known copy or replica. It is not proof
  of the recording device: history can be copied into a local AI Client's files.
  The absence of a sync replica on its own is not evidence of import or origin.
- The recorded directory and its resolved Git directory both existed before a
  trustworthy source start. For a linked worktree this is its own Git directory,
  not the repository's shared Git directory. Missing or newer checkout-age
  evidence leaves an otherwise eligible remote match advisory. Import time and
  filesystem creation time of the transcript are not source starts. Currently
  only the native start on the initial primary Codex rollout qualifies.
- Capture's remote-selection rules resolve the directory to one portable Git Anchor
  without a conflict (ADR 0064), and a Project already uses that Git Anchor.
- The Conversation was imported with an unresolved Git Anchor and has no prior Git Anchor
  correction, including a reset to the original.

The write is versioned and guarded; it supplies the effective Git Anchor without
changing the original. An assumed-local import has distinct advisory provenance
and uses an `assumed-local-import` review. Desktop pins the authenticated owner
and backend for source-context and evidence requests. It submits the exact
artifact, import source, native start, deployment, and device it validated.
The API matches that basis against stored evidence at preview and again at
apply. Desktop separately rechecks the same basis and the identities of the
recorded directory, its resolved Git directory, and the common Git directory
before apply. Only the worktree's own Git directory is subject to the age check. A later User correction replaces the
inference. Device sync is not required.

The source-context API is owner-authorized, not Desktop-attested. Current
Desktop-specific credentials do not authorize these routes. The API checks
stored evidence and Project eligibility; it cannot verify Desktop filesystem
checks or recording origin. An authorized owner API client can still make
manual corrections.

An eligible remote match can still be explicitly reviewed in Project settings
when the Git directory's age is missing or newer. Desktop warns that it could
not verify where the Conversation was recorded. Manual approval does not require
historical Git directory age, but Desktop rechecks the staged remote key, path,
and checkout identity at preview and again at apply. A missing or replaced
checkout blocks the save. The API still enforces stored eligibility and the
reviewed versions. If a legacy signed import qualifies only with its importing
Desktop's authority, only that Desktop offers Add. Known copied history does not
qualify for inference. Folders are never inferred.

## Consequences

- Git Anchor rules can include qualifying historical Conversations without a click.
  Coverage depends on available provenance; incomplete evidence stays advisory.
- Unmarked copies and checkout remotes repointed after the Conversation can
  still lead to incorrect inference. A User can correct it.
- An inferred Git Anchor is stored as a correction, so it is not distinguished
  from a User's own in the source-context history.

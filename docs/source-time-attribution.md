# Source-Time Attribution

Historical import and first live ingestion use the same source-evidence policy.
A Transcript Watcher may run after a checkout, Folder, or remote has changed.
Observing that path now does not establish the original Git Anchor or Folder
lifetime, even when the path still exists.

## Evidence And Precedence

1. A Supported Capture Hook at a new Conversation's native `SessionStart`
   (`startup`, not resume) records Folder and selected repository context in the
   existing source-context pin. Pi records the equivalent verified new-session
   observation through its existing local runtime endpoint. The pin is keyed by
   AI Client and external Conversation ID, and its original context is immutable.
   The selected anchor includes explicit local or accepted associated selections;
   native `origin` metadata cannot replace that selection or a recorded selection
   conflict. Later observations update current Folder context only.
2. Without a reliable repository pin, consistent native source-time portable Git metadata
   can establish a Git Anchor. Codex Session metadata records the remote URL,
   timestamp, and Folder; branch is retained only when consistent. This evidence
   does not establish a local checkout ID, current device, or Folder lifetime.
   A generic failed/unavailable startup probe supplies no selected-anchor evidence
   and does not suppress this native metadata. Explicit selection failures and
   conflicts do suppress fallback.
3. Without either source, repository assignment remains explicitly unresolved.
   A missing remote is not proof of a non-Git source. Neither current Git discovery
   nor path-only synthetic non-Git identity fills this gap. The recorded Folder
   path remains source metadata independently of Git identity.

The new-session observation must come from the AI Client lifecycle, never from
the Watcher's first discovery of a transcript. Existing source pins lacking the
optional repository field remain readable; a resume or later startup signal
cannot backfill them from today's filesystem. Reliable native metadata remains
usable for those older pins. Missing startup evidence cannot be reconstructed
automatically from an unchanged-looking path.

## Assignment And Recovery

The database retains existing Captured Session assignments and explicit User
corrections on replay and continued capture. These capture changes do not migrate
or automatically repair previously recorded mistaken assignments. Users recover
uncertain context through the existing source-correction and Project-membership
operations. Named Project membership remains independent of original Git and
Folder facts; adding a Conversation to a Project does not assert a historical
checkout identity.

Path-local catalog labels are attached by the Codex Watcher only when their
recorded checkout and anchor match the source-time pin. They cannot supply an
otherwise missing source association. Repository identity remains unrelated to
authorization, Team visibility, and AI-client synthesis.

Native transcripts without complete source-time Git data, missed startup hooks,
and pre-upgrade source pins can therefore remain unresolved. This is intentional
uncertainty, not evidence that their Memory is absent. It preserves recoverability
without introducing another membership or identity authority.

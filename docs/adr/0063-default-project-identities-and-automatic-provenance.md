# Default Project identities and automatic provenance

Status: Accepted, 27 October 2026. Implements PV-06 in `tickets.md`.

## Context

A User can capture the same Git Anchor on two devices before pairing them.
Random Project identities would create two automatic Projects after pairing.
Merging Projects by name or source would also merge independent User-created groupings.
Treating every automatic name as a User rename would create a false conflict.

The existing membership journal retains real authors, immutable revisions, and causal parents.
Its signed witness and owner boundaries must remain intact.

## Decision

Derive each automatic Project identity from a domain-separated canonical source key.
A portable Git Anchor excludes checkout paths, labels, remote aliases, and receiving owner aliases.
An exact Folder retains its originating deployment, device, profile, and directory lifetime.
The native Project uses the deterministic UUID directly under its owning User.
Native seed-rule UUIDs include the local owner because their table has a global key.
The existing portable inclusion identity joins those seed rules after authorized owner translation.
User-created Projects keep their independently generated identities.

Retain automatic initialization as explicit provenance on its initial catalog and rule revisions.
The provenance binds the same canonical source and deterministic Project identity.
It cannot describe a later edit or a different source.
Keep the real author, every revision, and the complete causal frontier.
Choose a deterministic retained representative when the remaining heads are equivalent automatic roots.
This choice does not synthesize an author or rewrite a revision.

A real User operation supersedes an automatic root that its device had not observed.
Concurrent real User operations still require review of their exact heads.
Automatic retirement also retains its provenance. A concurrent User edit takes precedence over that automatic action.
Database guards require the selected view to match a retained head and reject an available view that hides concurrent User intent.

Source decisions use the existing signed, encrypted Personal configuration transport.
The `project_defaults_v1` capability carries managed, retired, and suppressed source decisions.
An initialized source publishes as managed; the membership journal carries its initialization history.
Retirement and suppression only advance the decision to prevent future automatic creation.
A delayed managed decision cannot undo suppression.
Explicit source inclusion remains a separate, available User operation.

Only a current authorized group witness can introduce a decision.
Owner aliases change only inside that authorized receipt transaction.
An equal source key supplies no source access, native Folder association, or execution capability.

## Consequences

Paired devices converge even when they created their defaults offline.
Automatic labels can resolve without presenting a false rename conflict.
Names, explicit rule edits, removals, and deletions retain their User review requirements.

The deterministic identifier can reveal equality to an observer who already knows the source key.
It is an organization identity, not a secret or an authorization token.
Owner checks, signed group authority, verified source readiness, and local execution proof remain independent.

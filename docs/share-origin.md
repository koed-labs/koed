# Share Origin storage and invite acceptance

Team invitation and Workspace Access rows carry nullable `actor_kind` and
`access_mode`. A null actor means the share predates recorded provenance; it
must not be displayed as a person-made share. `access_mode` is populated only
for an agent acting on a User's behalf. The Team database has no Share Origin
Conversation id.

The Personal backend stores `share_origins` for its authenticated owner. Each
row is qualified by Team backend id. An invitation target uses the invite UUID;
a Workspace Access target uses the existing `(team_workspace_id, team_user_id)`
key and the version of that grant. The origin is either a named Conversation or
the share window. A `not_recorded` origin is reserved for unknown history.
Neither a renderer-provided backend id nor an unverified Agent name can create
an Agent provenance row: the local edge resolves the claimed managed text action
and its AI Client permission mode before sending Team metadata.
Native Action Grant review uses the same verified action reference and binds
`actor_kind` and `access_mode` into the exact reviewed invitation body. The
approved grant only resolves for a command with that body.

When an invite is accepted, Team copies its actor and access mode to the
resulting Workspace Access row and records the resulting grant version on the
accepted invite. The inviter's Personal local edge sees that version when it
lists the Team's invitations and links its invitation origin to the exact
backend-qualified Workspace Access key and version. Later re-grants create new
versions and leave earlier Personal origins intact. The link is retried on
subsequent invitation reads, so a Team acceptance can occur while the inviter's
Personal backend is offline.

The Personal Conversation id is never sent to Team routes, DTOs, audits or
events. Sharing read models must resolve Personal origins only for their owner.

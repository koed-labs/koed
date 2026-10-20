# Current device witnesses for retained Personal configuration

Status: Accepted

## Context

Personal configuration belongs to one User across paired devices. Project names,
inclusions, removals, and exclusions must survive offline delivery and device
removal. Their causal history must remain usable when another authorized device
forwards it to a new peer.

Checking every historical author against today's active members would make old
Project roots and removals unusable after device removal. Preserving independent
proof of every past writer, admission, and delivery would add a historical
authority protocol to the configuration journal.

Source-context transport already uses an authorized device as the witness for
retained causal history. Original source facts have a separate verified origin
binding.

## Decision

A currently authorized device signs a complete retained configuration history.
The enclosing Personal group and its current authority authorize that witness.
The signature covers every revision, its historical author attribution, its
selector, and its causal parents.

A revision identifier binds its normalized body. Receipt rejects a different
body for an existing identifier, including changed author attribution or parents.
The encrypted signed archive identifies the witness responsible for introducing
history. Historical author attribution remains part of that witness's statement;
read authorization comes from the current group and the owning User.

A removed device cannot send a packet as a current witness. An authorized device
can forward previously retained decisions, including removals from old devices.
Conflict detection uses causal edges. It retains competing heads until the User
resolves exactly the reviewed frontier.

Membership references remain separate from source authority. A configuration
history can retain a reference while its source is unavailable. Only verified
source receipt can bind that reference to eligible Memory. Forwarding Project
history cannot establish original Git or Folder facts, local filesystem
acceptance, or Team access.

## Consequences

The journal can preserve Personal configuration through device removal and key
rotation without treating a historical author's current status as a conflict
winner. Complete histories retain removal decisions and prevent an offline
packet from silently restoring a deleted inclusion.

An authorized witness is trusted to attest historical attribution for its User's
configuration. Audit and review surfaces must preserve the signed witness
identity alongside that attribution. Source bodies retain their separate origin
verification, and Team grants retain their existing authority and snapshots.

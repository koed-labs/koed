# Organize Conversations without losing the source

Keep three things separate: what the AI Client recorded, what Koed can establish
about the source, and how you group Conversations in named Projects.

## What each AI Client records

| AI Client                                 | Capture and source evidence                                                                                                                                                                                                                                               | Recall                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Codex](codex-integration.md)             | The Transcript Watcher reads native JSONL. Session metadata records an ID, timestamp, and working directory. Consistent source-time metadata can establish a portable Git Anchor, not an exact Folder. A reliable original pin takes precedence.                          | Koed memory tools through the MCP Server.                                                                  |
| [Claude Code](claude-code-integration.md) | The Transcript Watcher reads native JSONL and takes the recorded working directory from the matching session. The transcript supplies no native source-time Git Anchor. A `startup` or `clear` lifecycle event can pin context; copied history on `resume` cannot.        | Koed memory tools through the MCP Server.                                                                  |
| [Pi](pi-integration.md)                   | The Transcript Watcher reads persistent JSONL sessions. The header records an ID, working directory, and optional parent session, but no native Git Anchor. Only explicit `new` and `fork` events can pin originals. `--no-session` leaves no automatic capture artifact. | Koed tools through the Pi extension and Local AI Runtime; transcript capture alone does not enable recall. |

Titles, tags, local catalog labels, branch or commit names, and fork or subagent
lineage do not assign Project membership. Koed does not sync native client
Projects. See [Source-Time Attribution](source-time-attribution.md) for what
counts as original evidence and when it stays unresolved.

## Choose a Folder, Git Anchor, or named Project

- **Folder** matches one exact directory lifetime on a device and local profile.
  It does not match subfolders, or a replacement directory at the same path.
- **Git Anchor** matches the selected repository across matching clones and
  worktrees, independently of Folder selection.
- **Anchor** is a Git Anchor or a Folder. Project settings lists a Project's
  Anchors and adds one with **Add Anchor**.
- **Named Project** groups Conversations directly or through its Anchors. An
  Anchor matches existing and future Conversations. A Conversation
  can belong to several named Projects, but Projects do not nest. An exclusion
  overrides every inclusion reason in that Project only.

**Add to Project** changes membership without changing source context.
**Correct source context** previews a change to the effective Folder or Git
Anchor used for matching while retaining the original and preserving direct
inclusions and exclusions. A later path observation does not replace the original.
Neither action moves Memory or grants access, including Team or Workspace Access.

For steps, see [Named Project setup](desktop-ui.md#named-project-setup) and
[Conversation Project and source cards](desktop-ui.md#conversation-project-and-source-cards).
See the [Personal selection contract](personal-selection-contract.md) for
matching and recall semantics.

## Review hints before applying them

Local registry observations, Git worktree links, and matching remotes can
corroborate a hint. On macOS, Claude Desktop's private, local, unauthenticated
session records can suggest a parent path when the session ID and recorded
working directory agree. Treat that link as a weak clue to corroborate, not a
native Project sync, source-time pin, or Folder assignment. Koed reads no
equivalent client-recorded worktree link for Codex or Pi.

Desktop offers Folder actions only for exact references backed by recorded
server evidence, not for paths or Folders known only to the local registry.
Reviewing a hint does not register a Folder or write an observation.
When confirming a Folder hint, Desktop rechecks server evidence and re-scores
the exact candidate on the device. A changed candidate needs fresh approval.
Desktop does not currently offer the main checkout’s Folder as a worktree-parent
suggestion. A Git link or client session record can point to the parent checkout
but does not establish which device recorded the Conversation.

Guarded historical Git Anchor hints use reviewed source correction and a
fresh device-side score before preview and apply.
When saving a Project suggestion, Koed previews whether the correction would
newly include the Conversation in that exact Project through its Anchors. This is
not direct membership. A Folder hint alone never changes attribution or
membership.

For unresolved historical Conversations never corrected by a User, Koed can
infer an effective Git Anchor when recording origin is established or the
history was imported from this device's local AI Client and is not a known
copy. Both the recorded directory and its own Git directory must predate a
trustworthy source start, and the current remote must resolve to a Git Anchor a
Project already uses. A remote match with insufficient checkout-age evidence
can still be suggested for review. Koed assumes local
origin for qualifying imports; it does not verify where they were recorded.
Device sync is not required. When Koed cannot infer an anchor, eligible Project
suggestions remain available for review. Neither inference nor correction rewrites
the original. See
[ADR 0070](adr/0070-inferred-git-anchors-for-unresolved-history.md).

See [Desktop IPC](personal-memory-desktop-ipc.md) for the review contract.

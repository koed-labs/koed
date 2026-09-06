# ADR 0033: Runner-Owned Workspaces And Local Execution Checkpoints

- Status: Accepted
- Date: 2026-08-18

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Exclusive Execution Handoff And Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)
- [0017 Verified Development Workspace Snapshots](./0017-verified-development-workspace-snapshots.md)
- [0032 AI Client Instance, Capability, And Permission Contracts](./0032-ai-client-instance-capability-and-permission-contracts.md)
- [0035 File Access Uses Runner-Owned Rooted Capabilities](./0035-runner-owned-rooted-file-authority.md)
- [0036 Runner-Owned Scoped Terminal Authority](./0036-runner-owned-scoped-terminal-authority.md)

## Context

A managed coding Conversation needs an exact execution directory and a durable
way to show or restore the file changes made by one agent turn. The selected
Project may be a clean repository, a dirty checkout, a linked worktree, a
local-only repository, or a non-Git directory. Git branch names and remote URLs
do not identify one writable checkout and do not grant filesystem authority.

Koed does not need a repository-transfer protocol to provide local View changes
and Restore. Prompt-critical checkpoint work must also remain bounded when a
Project contains many files.

## Decision

The assigned runner owns all execution-workspace and checkpoint operations.
Git is the first supported checkpoint driver. Non-Git Projects can run managed
Conversations, but View changes and Restore are unavailable.

### Execution Workspace Binding

Each execution generation binds an immutable local workspace identity:

- Personal User, managed execution, deployment, and device;
- Project and opaque workspace id;
- canonical path retained by the runner;
- repository common-directory and worktree identity where Git is available;
- base object, branch or detached state, ownership class, and lifecycle state.

The coordinator receives opaque identity and capability state, not local paths,
Git administration, credentials, hooks, or environment configuration.

By default, a managed Conversation uses the checkout selected by the User. A
dedicated Koed-owned worktree is an explicit execution-mode choice. Koed never
claims cleanup ownership over a User checkout. Worktree creation and cleanup
remain idempotent, identity-checked operations and never use display names in
paths or refs.

### Per-Turn Checkpoints

Before each mutating prompt reaches the AI Client, the runner captures a
baseline checkpoint. After the provider turn reaches its durable source
boundary, the runner captures a terminal checkpoint. Prompt dispatch is fenced
on a ready baseline. Provider startup is independent from checkpoint capture,
and the Conversation is rendered optimistically. Provider output can be shown
as soon as it is durable; terminal checkpoint completion does not block its
display.

Capture uses one isolated temporary Git index and a fixed sequence of bulk Git
commands:

1. resolve and recheck `HEAD` and branch identity;
2. load `HEAD`, or an empty tree for an unborn repository, into the temporary
   index;
3. run `git add -A` against the selected Project;
4. reject concurrent workspace or repository mutation;
5. write one tree and one synthetic commit;
6. publish the commit under its exact hidden ref.

The active index, worktree, branch, and `HEAD` are not mutated. Ignored files
remain outside the checkpoint according to normal Git behavior. Tracked files,
eligible untracked files, renames, deletions, modes, symlinks, submodules, and
filters follow Git's content-tree semantics.

Checkpoint state is minimal and durable: execution, generation, command,
sequence, kind, `pending | ready | failed | unsupported`, repository/worktree
identity, ref, commit object, provider/source boundary where applicable, and
timestamps. A terminal capture interrupted after provider acceptance is retried
without resending the prompt.

### Hidden Refs

Each checkpoint has one content commit:

```text
refs/koed/checkpoints/<execution-id>/<generation>/<sequence>/<kind>
```

`kind` is `baseline`, `terminal`, or `recovery`. Synthetic commits use a fixed
Koed identity and content-free message. Ref publication and deletion verify the
expected object id. Temporary indexes are always removed.

Koed refs are local implementation state. Ordinary pushes and Koed source
control surfaces do not include them. A User-configured mirror or wildcard
refspec can copy arbitrary local refs; Koed does not claim otherwise.

### Diffs And Rooted File Reads

A turn diff compares that prompt's baseline and terminal commits. A full
Conversation diff compares the first baseline with the latest terminal.
Results are bounded, encrypted durable records derived by the runner. The
renderer cannot submit Git refs, object ids, absolute paths, or workspace roots.

The same ready commits back rooted browse, read, search, and file-mention
operations. Content authorization for those explicit reads remains a separate
runner boundary under ADR 0035; it is not performed during prompt-critical
checkpoint capture.

### Restore

Restore is an explicit forward operation by the owning User. It changes Project
file contents only; it does not rewrite provider history, Conversation source,
Memory, commits, branches, `HEAD`, or the User's staging arrangement.

The runner:

1. requires the execution generation to be running and idle;
2. resolves a ready target checkpoint owned by that execution;
3. captures and durably records a recovery checkpoint of the current contents;
4. proves the workspace still matches that recovery checkpoint;
5. materializes the target through an isolated temporary index;
6. removes only non-ignored paths present in recovery but absent from target;
7. verifies the resulting content tree and preserves the active Git index.

If the workspace changes after recovery capture, Restore fails rather than
discarding the newer work. A retry reconciles a completed Restore from the
target tree or resumes from its durable recovery checkpoint. Recovery refs are
retained for a later explicit recovery action. Restore records a terminal
checkpoint and refreshes the full diff before completing its command. The
Restore command diff starts at its own recovery checkpoint; prompt diffs start
at their own baseline checkpoint.

### Lifecycle And Portability

Hiding, settling, archiving, or deleting a Conversation does not delete its
workspace or checkpoints. Cleanup is a separate runner-owned operation with
identity, lease, ownership, and dirty-state checks.

Checkpoints are not synchronized or transferred between devices. Execution
handoff and fork portability use the verified source and Development Workspace
Snapshot contracts in ADRs 0016 and 0017. Any future checkpoint egress requires
an explicit classification, validation, and transfer design before a checkpoint
leaves its device.

## Consequences

- Git process count per checkpoint is bounded independently of Project file
  count.
- Managed Conversation UI and provider startup are not delayed by terminal
  checkpoint work.
- View changes and content-only Restore have a small, auditable local contract.
- Staged versus unstaged state is intentionally not reconstructed by Restore.
- Checkpoint capture does not provide secret scanning, transfer eligibility,
  cross-device synchronization, or repository synchronization.
- Non-Git coding remains available with checkpoint capabilities reported as
  unsupported.

## Required Evidence

- baseline capture completes before provider mutation;
- terminal capture follows a durable provider turn and retries without prompt
  replay;
- capture uses a bounded number of Git processes on large Projects;
- capture preserves the active index and working state;
- concurrent branch, `HEAD`, or workspace mutation fails closed;
- hidden refs are created, verified, cleaned, and omitted by ordinary pushes;
- turn/full diffs and rooted file operations resolve only recorded checkpoints;
- Restore keeps a recovery checkpoint, preserves ignored files and the active
  index, removes target-absent files, and refuses a changed precondition;
- non-Git Projects continue coding without checkpoint controls;
- real managed turns still reach canonical ingestion, Memory Events,
  embeddings, and `memory_answer`.

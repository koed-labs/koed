# Team continuous sharing: operational alpha tickets

On 21 October 2026, the User approved a smaller first milestone: make the
completed sharing flows operational for an internal trial. These tickets
replace the previous fourteen-ticket execution sequence.

The [archived tickets](../2026-10-21-package-2/tickets.md) preserve
that sequence, its acceptance criteria, and its recorded status. The
[archived implementation plan](../2026-10-21-package-2/implementation-plan.md)
preserves the engineering design. Deferred capabilities remain follow-up work.
Completing this alpha does not complete all of Package 2.

## Current state and trial scope

P2-01 through P2-08 are locally complete. Their evidence is in the
[validation record](../../team-continuous-sharing-validation.md).
P2-09 is partially implemented across storage, processing, API, and Desktop.
Its acceptance remains incomplete; ALPHA-01 has disabled its editing controls.
P2-10 through P2-14 remain unimplemented. The combined native journey remains open.

The first trial uses one publishing device, one owner, one teammate, and one
Team Workspace. Use deliberately selected test Conversations. Start with
individual Conversation sharing and Git Anchor sharing.

Retain the completed Folder, Project, independent-destination, and detail-change
capabilities. Their local acceptance remains valid within its recorded scope.
The first walkthrough does not require the full selector/control matrix.
Record which capabilities the walkthrough covers before expanding the trial.

The first deliverable is a running Desktop and local Docker Team Backend,
with a repeatable walkthrough and known limitations. Work starts at ALPHA-01.

## Constraints for every ticket

- Preserve current owner consent, Workspace Access, privacy policy, and
  separately authorized Conversation Source Access. Personal API Tokens remain
  Personal-only. Personal Projects and local Folder metadata remain private.
- Preserve exact source revisions and independent sharing reasons. Pause retains
  published access. Stop removes that rule's access. Explain remaining reasons.
- Reject stale approvals and obsolete publication work. Current restrictions
  must apply to direct reads, recall, evidence, expansion, and cached results.
- Reuse the existing transaction owner, publication pipeline, and retry storage.
  Keep the current alpha contract. Add no compatibility layer or backend LLM synthesis.
- Use the local Docker daemon for the Team Backend. Reuse existing Embedding
  and Privacy services. Run heavy builds and checks sequentially to limit RAM use.
- Run tests only when a specific acceptance requirement or changed boundary
  needs evidence. Reuse valid results. Avoid broad fixture work and repeated suites.
- Fix blockers to this trial. Put other implementation follow-ups in
  [TODO.md](../../../TODO.md). Keep deferred features out of the alpha completion gate.
- Preserve the User's decision to omit the changeset. This plan does not
  authorize push, merge, deployment, or release publication.

## ALPHA-01: Disable unfinished content-policy editing

Status: locally complete. Dependencies: none.

Make the completed sharing flows usable with the existing privacy policy.
Disable P2-09 amendments consistently without removing current protections.

- [x] Remove or disable content-policy editing in Desktop for every selector.
- [x] Reject the unfinished operation through HTTP, native commands, and local
      delivery before new approval, mutation, or queue creation.
- [x] Handle any existing queued content-policy amendment explicitly. Keep its
      status accurate. Do not silently apply it or report acknowledgment.
- [x] Preserve current privacy enforcement, stored restrictions, and existing
      approval records. Do not broaden access while disabling editing.
- [x] Keep reviewed creation, detail changes, and pause/resume/stop available.
      Make sure that disabling policy edits does not break their shared code.
- [x] Add focused evidence for the disabled entry points and affected shared
      paths. Reuse prior acceptance where implementation remains unchanged.

Scope: isolate the unfinished feature with the smallest coherent change.
Avoid a general feature-management framework or a broad rollback of shared code.
Do not finish P2-09's historical reprocessing or additional acceptance matrix.

Evidence: [ALPHA-01 validation](../../team-continuous-sharing-validation.md#alpha-01-disable-unfinished-content-policy-editing).

## ALPHA-02: Run matching Desktop and Team Backend builds

Status: locally complete. Dependencies: ALPHA-01 locally complete.

Run the alpha from the current workspace. Use matching source and compiled
runtime artifacts so that the walkthrough exercises the actual implementation.

- [x] Build the affected runtime and Desktop from the same source state.
      Apply the current schema to the isolated local development database.
- [x] Run the Team Backend with the local Docker daemon and existing model
      services. Preserve unrelated Personal and Team data.
- [x] Open the native Desktop against the intended backend. Make sure that
      sign-in, Workspace selection, and the publisher connection work.
- [x] Prepare one owner, one teammate, one Workspace, and a small set of
      deliberately selected Conversations. Reuse suitable existing trial data.
- [x] Record the running build identity, local endpoint, and exact startup
      commands without credentials. Do not rely on temporary source overlays.

Scope: make the app operational. No new fixture framework, model installation,
remote deployment, or second publishing device is required.

## ALPHA-03: Demonstrate sharing and teammate recall

Status: locally complete. Dependencies: ALPHA-02 locally complete.

Complete one native Desktop journey using the running backend. Record the
owner's actions and the teammate's observed access at each step.

- [x] Review and share one Conversation. Show pending and acknowledged state.
      Recall its authorized Memory as the teammate and open its evidence.
- [x] Capture a later turn and complete an LCM Summary through the existing
      AI Client workflow. Make sure that both reach the teammate when eligible.
- [x] Review and share a Git Anchor. Demonstrate an existing member and a
      future matching Conversation, with no unrelated Conversation admitted.
- [x] Pause the rule. Keep previously published access and withhold new content.
      Resume and demonstrate automatic catch-up.
- [x] Demonstrate overlapping direct and Git Anchor reasons for one source.
      Stop one reason and retain only independently authorized content.
- [x] Stop the final reason. Deny fresh and previously obtained Team reads,
      recall, evidence, and expansion. Keep the owner's Personal Memory intact.
- [x] Demonstrate required privacy masking and denial of unshared content.
      Make sure that Personal-only API Tokens cannot perform Team operations.

Scope: prove the essential workflow through the app and supported recall path.
Use focused automated checks only where the walkthrough cannot prove a changed
permission boundary. Fix failures before recording this ticket as complete.

## ALPHA-04: Demonstrate brief disconnect and restart recovery

Status: locally complete. Dependencies: ALPHA-02 locally complete.

Show accurate state during an ordinary interruption on the same publishing
device. This ticket uses existing durable retry behavior.

- [x] Review a stop online through Desktop, then briefly disconnect the Team
      Backend while its delivery is queued. Show remote acknowledgment pending.
- [x] Preserve the queued operation across a local app restart. Do not claim
      that remote access ended before the backend accepts the stop.
- [x] Restore connectivity. Apply the stop once, show acknowledgment, and
      demonstrate teammate denial and rejection of obsolete queued publication.
- [x] Make sure that retry creates no duplicate rule or contribution and
      leaves unrelated sharing unchanged.
- [x] If recovery requires unavailable history or publisher takeover, show an
      accurate limitation. Do not infer a complete baseline or restore access.

Scope: a brief interruption with usable history and one publisher. The User
accepted reviewed-stop recovery for this alpha. Fresh offline-stop initiation
is not required for this milestone.
Extended outage recovery, expired-history reconstruction, and device takeover
remain deferred under P2-13 and P2-14.

## ALPHA-05: Deliver the trial and record its limits

Status: locally complete. Dependencies: ALPHA-03 and ALPHA-04 locally complete.

Give the User a working app and a repeatable trial guide. Clearly separate
observed behavior from capabilities that only have prior local acceptance.

- [x] Resolve blockers found in ALPHA-01 through ALPHA-04. Record other work
      in TODO.md without adding it to this milestone.
- [x] Complete applicable formatting, lint, type, and build checks for changed
      files. Reuse successful checks when no relevant code changed afterward.
- [x] Run only the additional focused tests needed for changed permission
      boundaries or unresolved failures. Record any unavailable evidence.
- [x] Record the native journey and current build in the validation document.
      Keep the deferred full-package matrix explicitly open.
- [x] Provide exact launch instructions, account roles, a short walkthrough,
      known limitations, and a safe way to stop the trial.
- [x] Explain that Workspace exclusion is unavailable. Stop controls affect
      individual reasons, and another reason can retain access.
- [x] Mark the alpha ready only when the User can launch and try the recorded
      workflow. Do not report the original Package 2 as complete.

Scope: hand over the operational internal alpha. Broader deployment readiness,
all feature combinations, and deferred capabilities are later milestones.

## Deferred follow-up work

The original criteria remain in the archived tickets. These items are deferred,
not completed or canceled. Resume them through a separately scoped milestone.

| Original ticket                                                                                           | Capability                              | Alpha boundary                                                                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [P2-09](../2026-10-21-package-2/tickets.md#p2-09-change-a-rules-content-policy)                           | Edit a rule's content policy            | Keep current policy enforcement. Disable unfinished amendments.                                               |
| [P2-10](../2026-10-21-package-2/tickets.md#p2-10-exclude-a-conversation-from-one-workspace)               | Exclude a Conversation from a Workspace | Use deliberately selected trial content. Prioritize before routine sharing of mixed private and work content. |
| [P2-11](../2026-10-21-package-2/tickets.md#p2-11-remove-an-exclusion-and-catch-up-eligible-sharing)       | Remove an exclusion and catch up        | Follow P2-10. Keep its explicit review and lifecycle guarantees.                                              |
| [P2-12](../2026-10-21-package-2/tickets.md#p2-12-convert-an-existing-snapshot-explicitly)                 | Convert a snapshot                      | Keep snapshots fixed. Use a separately reviewed continuous rule.                                              |
| [P2-13](../2026-10-21-package-2/tickets.md#p2-13-recover-a-selection-rule-after-an-extended-interruption) | Recover after extended interruption     | Demonstrate only brief disconnect recovery with usable history.                                               |
| [P2-14](../2026-10-21-package-2/tickets.md#p2-14-continue-a-rule-from-another-personal-device)            | Transfer publication to another device  | Keep one designated publisher per rule.                                                                       |

The original combined two-owner, two-Workspace, two-device journey, complete
selector/control matrix, and broad package suites remain deferred. Existing
permission guarantees still apply to every enabled operation.

# Plan and ticket orchestrator

Use this prompt to coordinate an approved investigation or implementation plan.
By default, read [PLAN.md](PLAN.md) for scope and [tickets.md](tickets.md) for
work items and progress. Use other paths when the User specifies them.

## Invocation and authority

Creating, editing, or reviewing this document does not start ticket execution.
When the User explicitly invokes it to execute a plan, carry out the work within
the approved scope and existing authorization. Plan approval alone does not
authorize production implementation, deployment, or external publication.

Follow applicable system, developer, User, and repository instructions.
This document does not override them or establish historical approvals.
Honor current pauses, stop conditions, model choices, and workflow preferences
only where the current instructions or approved plan establish them.
Do not carry requirements from an unrelated investigation into new work.

The plan defines the objective, limits, and overall completion criteria.
The tickets define deliverables, acceptance criteria, dependencies, and progress.
If they conflict, explain the conflict and resolve it before dependent work.
Do not silently weaken either document.

Use required memory recall and applicable skills according to current instructions.
Record relevant constraints and evidence without treating recalled information as
proof of the current implementation.

## Initialization

1. Read applicable repository instructions, the approved plan, and all tickets.
2. Identify whether the work is research, prototyping, implementation, or a mixture.
3. Inspect the current branch, working tree, relevant code, and retained evidence.
4. Preserve unrelated changes and work already in progress.
5. Reconcile recorded progress against actual artifacts and the current revision.
6. Identify missing prerequisites, unresolved decisions, and explicit pauses.
7. Derive the next eligible tickets from their dependency edges.
8. Record the initial state and begin authorized, eligible work.

Do not hardcode ticket IDs, providers, execution order, or product requirements
in this prompt. Obtain them from the current plan and tickets.
Do not assume that a checkbox, worker summary, or historical review proves
current completion.

## Scheduling and dependencies

Work on tickets whose prerequisites are resolved and whose required inputs exist.
Parallelize only independent work with separate ownership of files and resources.
Respect the available agent capacity and any explicit concurrency limit.
Use isolated checkouts when shared edits would conflict.

A completed prerequisite does not automatically make its dependents executable.
Check whether its outcome supplies the capability, evidence, or decision they need.
A negative finding can enable a synthesis ticket while blocking an experiment
that requires the missing capability.

Do not remove dependency edges to manufacture progress. If the approved criteria
permit a report to summarize blocked or untested work, provide the recorded
blocker evidence as its input. Otherwise, propose the necessary plan amendment
and wait for a decision before changing those requirements.

Keep experiments bounded to unresolved questions. Reuse unaffected evidence
when its versions, configuration, and tested behavior remain relevant.

## Delegation and model selection

Delegate only when the User or applicable instructions authorize agent delegation.
Explicit invocation of this orchestrator authorizes bounded delegation within the
approved scope, subject to higher-priority instructions and available tools.
Editing this prompt does not authorize or start delegation.

Inherit the current model and reasoning settings unless the User or applicable
instructions specify an override. If an explicitly required configuration is
unavailable, report the blocker rather than silently substituting another.
If delegation is unavailable and is not required, work sequentially.
Report any resulting limit on independent review.

Give each worker one ticket or a bounded remediation task with:

- Its exact deliverable and acceptance criteria.
- Applicable instructions and relevant plan sections.
- Prerequisite outcomes and evidence paths.
- Its permitted scope, checkout, and owned files or resources.
- Relevant implementation entry points or research questions.
- Required validation and evidence.
- Current approval boundaries and stop conditions.
- The requirement to report blockers and necessary User input promptly.

Workers must not delegate further unless explicitly authorized.
The orchestrator is the sole writer of the ticket progress record.
Workers must not waive criteria or change the approved scope.

Require a concise return report containing the ticket, tested revision or content
digest, outcome, changed files, criterion evidence, commands and results,
remaining uncertainty, and cleanup or still-active operations.
For experiments, distinguish live observations, fixtures, and source-only findings.

If a ticket exceeds one context, propose a bounded split that preserves its
criteria and dependencies. Follow the plan's approval rules for restructuring;
never use a split to change product scope without authorization.

## Progress tracking

Use the existing ticket format and status vocabulary. If none is defined, use
Open, In progress, Awaiting review, Changes required, Done, Blocked, and Paused.
Keep triage labels separate from execution state where the ticket format does so.

For each active ticket, record:

- Status, owner, attempt, and latest update.
- Checkout and tested revision or artifact digest.
- Evidence paths and acceptance-criterion results.
- Review verdict and remaining findings.
- Blockers, required decisions, and any still-active operation.

Append concise entries when work starts, returns for review, needs remediation,
is integrated, or completes. Preserve earlier evidence and its original scope.
Preserve ticket IDs, titles, dependencies, and criteria unless a permitted plan
revision explicitly changes them.
Check acceptance boxes only after review accepts the supporting evidence.

## Research outcomes and implementation outcomes

Keep ticket completion separate from the capability being investigated.
Classify research outcomes using the plan's vocabulary, such as supported,
bridge required, unsupported, blocked, or untested.

A research ticket can be Done with a negative finding when its acceptance
criteria allow that outcome and the evidence answers the required question.
An unavailable environment can be recorded as untested; it completes the ticket
only if the criteria explicitly permit that result and require no missing proof.
Missing evidence for a required experiment leaves the ticket Blocked or incomplete.

An implementation ticket is Done only when its required behavior is implemented
and validated. A written limitation does not satisfy a required behavior.
A prototype proves only the behavior exercised within its documented boundaries;
it does not establish production readiness or authorize a rollout.

## Review

The orchestrator owns acceptance review and the final completion assessment.
Delegate substantive implementation and remediation where authorized to preserve
reviewer independence. Perform explicitly designated independent review or
reproduction steps as the plan requires.
If independent review is required but unavailable, record that gap rather than
claiming a self-review satisfies it.

For every returned ticket:

1. Inspect the actual artifacts and relevant code or sources.
2. Compare the result with every acceptance criterion.
3. Verify that evidence matches the tested revision, versions, and configuration.
4. Run checks needed to resolve uncertainty or required by repository instructions.
5. Check for scope drift, weakened safeguards, and missing failure cases.
6. Record Pass, Changes required, or Blocked with specific evidence.
7. Request bounded remediation and review its affected behavior.

For research, distinguish observed behavior from documented claims and inference.
Refresh time-sensitive sources and pin relevant versions or source revisions.
Do not present fixtures as live results, one client mode as proof of another,
or historical evidence as proof of a changed implementation.
For performance claims, measure the behavior that matters to the plan rather
than substituting an intermediate event for the intended outcome.

## Blockers and User input

Use existing authorization. Do not invent a need for confirmation.
When required input is missing, record the exact blocker and ask for the smallest
decision or action needed. Silence does not provide approval.

Pause the affected work and its dependents. Continue independent, authorized work
unless the User or plan requires a global pause, or the unresolved decision could
affect that work's scope or safety.
If a global pause applies, stop dispatching and interrupt affected workers where
supported. Preserve their files and record operations with uncertain outcomes.
Do not terminate unrelated processes.

Examples of required input include authentication, authorization outside the
approved scope, product decisions, criterion waivers, instruction conflicts,
and repository-required release confirmation.
A technical blocker that needs no User decision blocks only work that depends on it.
After input arrives, reconcile interrupted work before resuming.

## Integration and completion

After a ticket passes review:

1. Integrate its artifacts without overwriting unrelated work.
2. Run checks affected by integration.
3. Recheck findings against the integrated revision or final artifacts.
4. Record evidence and the final verdict in the ticket record.
5. Mark Done only when its criteria pass.
6. Reassess which dependent tickets are now executable.

If integration invalidates an earlier verdict, repeat the affected checks.
Apply the plan's product, security, recovery, and release constraints throughout.
Do not infer deployment or external publication authorization from a ticket title.
Obtain any required approval after preparing the concrete result for review.

Continue until the approved completion criteria are met, an applicable pause
requires stopping, or no authorized ticket remains executable.
Assess the final deliverables against the overall plan as well as individual tickets.
An investigation may finish with a supported decision to defer implementation
when the plan permits it. Blocked implementation remains incomplete.

## Efficient work and communication

Keep context and tool output focused. Give workers the necessary constraints and
file references rather than unrelated conversation history.
Retain detailed logs in evidence files and summarize routine successful checks.
Do not repeatedly poll unchanged state or rerun passing checks without a relevant
change, failure, unresolved concern, or explicit validation requirement.
Do not reduce effort by skipping required evidence or accepting unsupported claims.

Provide concise progress updates with completed work, findings, active tickets,
and blockers. Keep the ticket record accurate throughout execution.

At the end, report completed and remaining tickets, final artifacts or revision,
validation and review results, research conclusions where relevant, limitations,
and any required User action.
Claim full completion only when the approved plan's completion criteria are met.

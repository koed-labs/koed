# Scheduled Jobs runtime (HQ-602)

The assigned device's Local AI Runtime checks due Jobs every 30 seconds. It
uses the device's sealed Desktop credential to ask the loopback Personal API
to materialize occurrences. The API records an attempt, queues a new prompt
in the bound Managed Conversation, and records the exact command binding in
one database transaction. The existing supervised Managed Conversation worker
executes that prompt through the User's selected AI Client. Closing the
Desktop window does not stop that worker or the Local AI Runtime process.

The scheduler uses the Job's IANA timezone and calendar rule. It records
occurrences more than 15 minutes late as missed, and overlapping occurrences
as skipped. A tick drains missed history before the current due occurrence.
An expired active turn records an interrupted attempt with uncertain effects;
the old command cannot run automatically again. A queued turn that never
launched can be canceled immediately. An interrupted active turn blocks later
prompts in that Conversation until the User interrupts it and the AI Client
session has closed. The runtime records that exact provider quiescence receipt
before the next ordinary User prompt can run. The old attempt and its uncertain
outcome remain in history. Retry uses the same run row with a new attempt after
the User reviews the prior effects. If the provider session cannot be reached
and closed, the old command remains indeterminate and later prompts stay
blocked until a separate verified recovery; a missing in-memory session is not
treated as proof that the provider stopped.

Before a scheduled command is claimed or used, the runtime checks its exact
owner, assigned device, Job and Conversation versions, command generation,
attempt binding, Project lifecycle, and any current Team Workspace Project
authority. A denied command is withheld from the AI Client. Loss of authority
ends the attempt for review and cannot resume it when access returns. A
temporary failure to read Team authority is recorded as unknown, while a
confirmed changed binding has a distinct reason. Ordinary Personal
Conversation turns in the same execution do not inherit an old Job's authority
gate after the interrupted provider turn has been safely quiesced.

An existing captured Conversation without an attested, compatible Managed
Conversation execution cannot be resumed safely by this runtime. Its due
occurrence is recorded as a failed, no-effect attempt for review; no new
Conversation or provider thread is guessed. A Job bound to a current Managed
Conversation can run normally. HQ-603 can guide creation of a dedicated
Managed Job Conversation through the standard flow.

The Local AI Runtime only sends the sealed Desktop credential to an HTTP
loopback Personal API. A remote Personal API cannot run this local scheduler;
ordinary Managed Conversation work remains available. Job execution never
uses a backend LLM or a Team credential in the AI Client environment.

The local scheduler also stays unavailable when the selected backend owns remote Managed Conversation execution. It creates no local occurrence or prompt in that mode, because the remote worker claims a different command store. Changing a backend does not grant a remote worker access to a local Job.

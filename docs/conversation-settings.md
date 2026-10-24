# Conversation settings

Ask, Project launches, and active managed Conversations use the same agent
input surface. The surrounding controller supplies the draft, capabilities,
and submission action. The input supplies the text field, settings controls,
keyboard behavior, and Send or Interrupt action.

The compact composer uses the selected prototype A design.
Permissions appear on the left. The AI Client selector sits immediately before
the model and reasoning selector. Device handoff remains a separate action.

The model menu contains a model row and a reasoning bar. The bar highlights
the selected value without a separate heading or repeated value. The model row
opens the selected AI Client's model catalog. The menu has no AI Client selector.
The AI Client selector uses the selected provider's mark. The model selector has
no leading icon.

## HQ Conversation surface

The HQ-enabled Desktop has its own centered blank composer and a docked
composer after the first queued message. Its Project, Ask first, AI Client,
model, and reasoning controls use the same managed runtime capabilities as the
existing Desktop. One compact model/reasoning control uses the saved
Conversations assignment for AI Client, model, and effort.
That control shows the selected model and a colored effort indicator. Its
popover offers only the model's supported effort levels as stacked heat bars,
resets to Medium when supported, and opens a model list grouped by available
AI Client. An active Conversation keeps its AI Client locked. The selected
model and effort are applied to the next turn, with the expected prior settings
included in the same prompt request.

New HQ Conversations use the saved Conversations assignment
for AI Client, model, and effort, but start in **Ask first** (`supervised`) when
that mode is supported. The picker offers **Full access** as an explicit
choice; `auto_edit` and `auto` are in More permissions. Unsupported modes are
disabled. The existing Desktop retains its current launch default.

While the user types, a current low-usage report may suggest an alternative AI
Client with fresh, verified evidence of room. Accepting it before the first
message changes only this new Conversation's selection; Undo restores the
previous selection. The saved Conversations assignment is unchanged. An active
Conversation keeps its AI Client: accepting the suggestion opens a new chat
with the typed draft and the alternative selected. A Project HQ Conversation
shows the warning without a switch action. **Keep** silences that window's
warning until its reported reset, or for one hour if no reset was reported.

The HQ attachment control browses Project files through the current managed
execution. If used before the first message, it starts an empty Conversation,
keeps the draft, and opens the file picker after an execution exists. The
selected file is represented by the runtime's mention command ID when the
prompt is sent. This control does not upload arbitrary local files.

HQ replies use the captured timeline and show live runtime approval and
question items. Approval decisions and answer payloads go through the existing
runtime response API. A per-turn model, effort, or permission edit is sent only
with the next prompt as `settingsChange`, bound to the last reported settings.
An uncertain launch or send keeps its exact request identity and draft; HQ
does not resend it automatically. A captured-only Conversation is read-only.
Before dispatch, HQ saves the exact pending request, identity, settings, and
attachments through the existing encrypted, owner-scoped recovery store. On
reload, it checks that saved identity against the runtime; an unknown outcome
requires manual recovery and never triggers an automatic resend. If secure
recovery is unavailable, sending pauses. Once a prompt is accepted as queued,
the next draft can be written while the reply is running.

## New Conversations

Ask and **New** use the saved **Conversations** assignment from Agent Configuration.
The assignment supplies the AI Client, model, and reasoning effort. Users can select
an available AI Client, model, reasoning level, and permission mode before
they start. Sending the first message starts the Conversation and queues that
message behind runtime startup. Starting without a message remains available.

An uncertain start retains its request identity for an explicit retry.
An uncertain first prompt retains its exact text and message identity.
Desktop disables text edits until an explicit retry resolves that prompt.
It does not submit the prompt again automatically.
After a definite rejection, an edited prompt receives a new message identity.
The launch identity stays the same for both retry paths.

The selected Project stays fixed after a launch attempt starts.
Ask and Projects share provisional titles, identity updates, and restart recovery.

New Conversations start on this device. The existing handoff action controls
subsequent device changes. This change does not add remote launch support.

## Existing Conversations

Model, reasoning, and permission edits remain pending until the next message.
Pending edits do not add a separate status or undo row. Settings remain visible
during a turn, but editing is disabled until the turn ends. Changing AI Client
requires a new Conversation. Menus explain unavailable choices and use the
shared keyboard navigation, focus, dismissal, and positioning behavior.

The catalog comes from the selected AI Client instance. A model change retains
a compatible reasoning level or selects a reported default. Models without a
reasoning override have no reasoning bar. Unknown settings remain unavailable
instead of silently selecting a different AI Client or model.

The composer distinguishes the selection for the next prompt from usage for
the last observed turn. The context display retains provider-reported token
counts. Its tooltip identifies the source model. The selected reasoning level
appears in the settings control, separate from previous usage.

The API checks capability evidence before local admission. The Worker checks
that evidence again before dispatch. Concurrent changes and active operations
can reject a pending edit. Desktop restores a definitively rejected prompt.
It does not automatically retry uncertain provider operations.

## Runtime contract

Prompt requests can contain `settingsChange`, with complete `expected` and
`next` settings. Each contains `model`, nullable `reasoningEffort`, and
`permissionMode`. Ownership and device fields are not accepted in this object.

The repository compares expected settings while it holds the execution lock.
It rejects a change while another command remains unfinished. It persists the
next settings and queues the prompt in the same transaction. Every new prompt
retains its own encrypted settings snapshot. Existing request formats remain
valid, and no database migration is required.

The cached session identity includes all three turn settings. A change closes
the old runtime and resumes its existing Conversation. Codex receives the
settings through its app-server configuration. Claude receives native model,
effort, and permission options. Pi receives the model, thinking level, and
permission extension configuration through its managed runtime.

Historical Conversation items remain unchanged. These edits do not change
Capture Policy, Recall, Team permissions, or saved AI Client defaults.

## Browser fixture

The browser fixture uses production controls with simulated runtime responses.
It does not call a live AI Client.

```sh
pnpm --filter @koed/desktop dev --port 5199
```

The fixture URL is
`http://127.0.0.1:5199/browser-validation.html?view=conversation-settings`.

The throwaway variants and switcher are removed.

## Database schema

Migration `0039_conversation_agent_default` adds the Conversations setting.
Migration `0037_coding_project_runtime` already creates the runtime acknowledgement column.
Migration `0040_repair_conversation_start_authority` repairs databases that recorded an earlier version of `0037` without this column.
The repair preserves runtime bindings and leaves their acknowledgement unset.

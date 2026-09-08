# Conversation settings

The compact composer uses the selected prototype A design.
Permissions appear on the left. The AI Client selector sits immediately before
the model and reasoning selector. Device handoff remains a separate action.

The model menu contains a model row and a reasoning bar. The bar highlights
the selected value without a separate heading or repeated value. The model row
opens the selected AI Client's model catalog. The menu has no AI Client selector.
The AI Client selector uses the selected provider's mark. The model selector has
no leading icon.

## New Conversations

**New** opens the composer with the current launch settings. Users can select
an available AI Client, model, reasoning level, and permission mode before
they start. Sending the first message starts the Conversation and queues that
message behind runtime startup. Starting without a message remains available.

An uncertain start retains its request identity for an explicit retry. An
uncertain first prompt is not submitted again automatically. A rejected first
prompt remains available as a draft.

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

The throwaway variants and switcher are removed. The User requested no changeset
for this implementation.

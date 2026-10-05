# Koed Studio Home

Koed Studio is a separate experimental interface for Personal workflows.
The existing `apps/desktop` application remains unchanged.
The first slice reads real Koed data and does not start AI work or approve requests.

## Application boundaries

The React Home screen serves both Electron and a local browser.
A gateway, a small server between the screen and Koed, reads the existing Personal API.
The gateway keeps the API Token outside browser code and returns a bounded view of authorized data.

The gateway listens on the loopback interface only.
It is a local, single-operator preview, not a hosted multi-user web application.
Local processes can read the preview without a separate browser login.
Use it only on a trusted, single-user machine.
Cloud deployment requires browser authentication, user isolation and an approved remote API contract.
Do not expose this preview through a public tunnel or reverse proxy.

Electron uses a separate application name and configuration directory.
It starts its own gateway on an available local port.
It neither starts nor stops the Koed backend.
The browser and Electron therefore use the same Home data contract without sharing desktop configuration.

## First slice

Home surfaces workflow invitations, not captured-history results.
Managed execution states and pending requests can supply factual status cards.
Each card has an explicit workflow destination. Until that destination is wired,
its action is unavailable rather than opening a captured-content viewer.
The attention scan is bounded, so coverage warnings remain visible when data is incomplete.
An unavailable backend is not an empty workspace.
An authorization failure clears the previous Home data.

Captured-content drawers are not mounted from Home or sidebar Chats.
Home does not generate an AI briefing or claim to cover all events since the last visit.
New-conversation setup and approval submission remain outside this slice.

## Synthetic workflow demo

Open `http://localhost:43110/?demo=1` for the separate interactive demo.
The Demo data indicator distinguishes it from the live Home preview.
Its fictional records illustrate chat continuation, collaborative discussion,
agent decisions, work review and a personalised before/after change briefing.
Destinations open in the main working area, never a captured-memory drawer.

Demo messages, decisions and review outcomes are local simulation only.
The demo does not mount the live Home data reader, call Koed APIs, launch agents
or write to the database. In-memory changes reset when the page reloads or the
demo is reset. These screens illustrate workflows, not completed integrations.
Use the live-preview link to leave the demo.

## Prototype separation

The original design workspace is `koed-studio-prototype`.
Preserve the imported skin, navigation names and page layout.
Limit interface changes to real data, loading states, errors and unavailable actions.
Discuss any wider visual or workflow changes with the user before implementing them.
The import contains its screens so future page work can reuse the design.
Only Home is served by the integration gateway.
The active layout does not mount the synthetic workspace provider.

`apps/studio/prototype-baseline.json` records source hashes for the imported prototype.
Use this baseline to compare later design changes before importing them.
Never overwrite integrated files with an entire new prototype export.
Keep Collaborative changes in the design workspace until their page is selected for integration.

## Follow-up work

See [Home wiring plan](studio-home-wiring-plan.md) for the element-by-element audit,
reuse boundaries and acceptance checks. Implementation tasks are tracked in `TODO.md`.

Define a paginated, owner-scoped attention endpoint before removing partial-coverage warnings.
Connect conversation creation and request responses through their existing authorization checks.
Define a per-user seen marker before labelling results as unread across devices.
Add automatic recommendations only with evidence, freshness, dismissal rules and a processing budget.
Prepare before/after project changes and per-user relevance separately from rendering Home.

The Home page uses existing Koed routes and does not alter database tables or synthesis boundaries.
The local adapter is not a replacement for API authorization.
Each backend request must still authenticate with the configured Personal API Token.

## Automatic refresh

Personal Home refreshes its activity feed, conversation metadata and available models on entry, every 30 seconds after the previous refresh finishes, and when the window becomes active or reconnects. Hidden or offline windows do not poll. Requests cannot overlap. Each refresh has a 15-second timeout; failed automatic refreshes back off to 60 seconds, then at most 120 seconds. A failed refresh shows the manual Refresh control until a successful refresh. Existing content and composer drafts survive temporary failures; denied access clears protected data.

Home uses `/studio-api/home?mode=metadata` to skip all per-conversation runtime-history scans. Pending actions come from the dedicated compact Home feed. The legacy full snapshot endpoint still serves callers that need runtime coverage; metadata snapshots explicitly report `coverage.requests: false`. Home does not download full messages or attachments for polling. Each browser response is limited to 1 MiB (access checks to 32 KiB). An activity refresh shares a 4 MiB budget across all loaded pages, with at most 32 requests and a shared timeout. Oversized streams are cancelled, the previous verified feed remains visible, and Refresh becomes available. Metadata and model requests add at most 2 MiB per cycle. Pagination fetches more data only when requested by the user.

## Home composer execution and folders

Personal Home shows Local execution without a Cloud toggle. The model selection identifies the configured local AI Client and its model; the actual launch uses `runnerKind: "local_device"`. The previous Home Cloud label was only UI state and never changed the launch request or routed work to a Koed cloud runner.

The Personal folder label opens a project-folder picker. Existing registered local Projects can be selected, or Electron can open its native folder picker through the existing CSRF-protected `/studio-api/projects/choose-folder` endpoint. A chosen folder is registered through `/studio-api/projects` using the server-issued selection ID, then selected for the draft. Registration accepts an omitted name so discovery preserves an existing Project name or supplies the new folder's default name. Explicit names remain supported for the sidebar's Create Project flow. Cancellation or registration failure preserves the previous choice and draft. Folder selection does not send a message or launch an AI Client. Explicit directory selection preserves that exact directory even when it is inside a parent Git repository; automatic repository discovery still uses the repository root.

No folder explicitly selects a standalone chat, overriding any previous sidebar Project selection. Its later launch uses `projectId: null` and `contextKind: "independent"`; the existing runtime creates its internal managed workspace. Home Send carries the chosen model, permission settings and selected Project into New Chat and submits the question after the chat is ready. Browser mode can select registered Projects or No folder; native folder selection is shown only when the gateway advertises that capability.

The same folder selector is available in Personal New Chat and chats opened from Agents. Folder changes before the first send retain the draft and update the launch project and resource scope; No folder starts an independent chat. The picker opens above the composer in chat windows so its options remain visible. Local execution is the default shared composer display. Existing chats display their runtime project, and choosing a destination uses the existing reviewed Project Move flow. Active tasks, unsupported AI Clients, recovery, and Team-request bindings keep their folder changes disabled with an explanation. Existing sessions cannot be switched to No folder through this selector. Pull request chats retain their repository context.

Home Send submits the first question after New Chat has loaded verified AI Client settings and device recovery. A saved Personal Agent is optional; when mentioned with `@`, its active profile is validated before sending. Home supports optional Personal Agent selection through `@`; no Agent is preselected and no Agent dropdown is shown. The handoff retains the question, project choice, provider, model, reasoning, permissions, and exact Client. It submits once using the existing durable idempotency path, shows the accepted question and response in the conversation, and retains the draft on failure for explicit retry. A previous unresolved send blocks automatic submission. Sidebar New Chat, suggested drafts, and Team handoffs continue to open drafts until the User sends. Explicit incoming questions take precedence over stale saved drafts.

With a valid model and question, Home Send is enabled even when no Agent has been selected. It opens New Chat directly with the original question, model, reasoning, permissions, exact AI Client and folder selection. Home does not open a required Agent chooser or silently select a saved Agent. The explicit Home submission is also queued when no Agent is selected. Direct chats omit Agent fields from the prompt request and use the existing backend direct-conversation path. New Chat supports sending and following up without a saved Agent; optional Agent selection uses `@`.

Direct-chat history retains accepted user prompts while queued, running, failed, or canceled, as well as completed prompts; only completed tasks supply a final assistant answer. Codex first prompts without a captured source generation use native session identity validation, while explicit archive resumes of an existing generation retain strict source-rebase verification.

Codex source rebasing recognizes both supported capture runtimes, `codex` and `codex-cli`, and still requires a matching active generation, provider thread and local session. This covers transcripts captured by the watcher as well as the managed app-server integration.

AI replies in the shared Agent message view render GitHub-flavored Markdown using the same renderer as Pull Request descriptions: headings, emphasis, lists, task lists, quotes, code and tables. User messages retain their literal text. The existing URL filtering and disabled remote-image/raw-HTML behavior also apply to AI replies. Stored conversation text and copy/forward actions retain the original Markdown.

After the first message is accepted, New chat selects its managed Conversation in the sidebar and opens its Project or the standalone Conversations list. The title starts as a short label from the first message, without an extra model request. The captured-session title store retains it across reloads. Users can rename a Conversation from its sidebar row; manual titles remain protected from generated title updates.

New AI chats remember the model, exact AI Client and reasoning setting from the last accepted AI message. The shared composer applies these defaults on Home and other fresh chat surfaces; explicit handoffs, resumed conversation settings and selected Agent defaults take priority. Local desktop preferences persist as a small settings file in the Koed home directory and browser storage supplies an immediate cache. No message content or credentials are stored in this preference. An unavailable saved model remains visible with the existing availability warning instead of silently switching models.

A selected folder that inherits Git only from a parent directory runs as a plain-folder Project at its exact selected path. Koed does not checkpoint the parent repository. Selecting an actual repository root keeps normal Git checkpoints and review/restore capabilities.

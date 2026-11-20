# Floating Kin

Floating Kin is an opt-in macOS Desktop companion for recent captured work. It
shows Personal Conversations whose activity Koed has captured, not whether an
AI Client is running, waiting, or finished. A quiet Kin does not mean the AI
Client is idle. Capture can lag or miss activity, and imported history does not
count as recent activity.

Enable **Floating Kin** under **Settings → General**. Desktop shows the Kin over
other windows without moving focus there. Use **Window → Focus Floating Kin**
for keyboard access. The Floating Kin uses the Koed mark’s rounded-square shape
and blue-to-yellow gradient to distinguish it from Project Kins in Conversation
chips. It stays visible below the chips even while a summary is open. When there’s
no recent capture, the Kin sleeps; hover or focus it to see the message. Drag the
Kin to move the overlay for the current Desktop session. The Kin and its controls
receive clicks; clicks in the surrounding transparent space pass through. Disable
the preference to hide it. Quitting Desktop closes the Kin even if the Local AI
Runtime stays up.

Choose **Summarize Conversation** for the latest captured work in a
Conversation, or **Summarize Project** for context from its Project. The Project
action requires a resolved Project. There is no free-text prompt. An answer
separates the account of captured work from any inference. **As of** is the time
of the newest cited source, calculated by Koed. It is not the current state of
the AI Client. The answer identifies its sources and the synthesis AI Client,
model, and reasoning effort when available.

## Read and synthesis path

1. The Desktop window uses a dedicated preload to ask the main process for
   metadata or to request a fixed summary. It does not receive API credentials
   or raw capture. The main process reads an authenticated loopback registration
   for the existing Local AI Runtime. The Kin never starts or resumes a runtime,
   including after **Stop Koed**. If Koed is stopped, start it explicitly from
   Desktop to use the Kin again.
2. The runtime asks the local API for recent Personal activity. The API derives
   User identity from the Personal API Token. Desktop polls a bounded feed of
   captured messages from the last 30 minutes, ordered by captured activity
   time. Replay and imports do not create a fresh activity signal. Displayed
   information is limited to Conversation, Project, AI Client, and time metadata.
   There is no Team path.
3. For a Conversation summary, the API can supply eligible captured items from
   the latest unfinished Claude Code or Codex turn before its Memory Events
   seal. Pi uses sealed Personal Memory only: its raw turn boundary is not yet
   verified here. If a safe turn boundary or eligible items cannot be established,
   the read uses applicable sealed Personal Memory or returns no evidence. A
   Project summary uses sealed Personal Memory for the selected Project and only
   if it still matches the Conversation's resolved Project. Evidence requires the
   local runtime registration proof as well as the Personal API Token. Evidence
   is bounded and filtered for owner access, deletion, exclusion, and capture
   eligibility. Approval Activity, hidden reasoning, and generic raw records
   are not passed to the synthesis AI Client. The API does not do LLM synthesis.
4. The runtime passes the evidence as data to a short, separate synthesis task
   using the explicit Memory Answer assignment. The selected AI Client can
   differ from the AI Client shown in the captured activity. This preview can
   synthesize with Claude Code or Pi without action tools. Codex capture can
   appear in the Kin, but a Codex synthesis assignment is unavailable until its
   action-tool restrictions are verified. There is no fallback. The assignment
   needs a current capability snapshot for the configured executable and profile.
   Review it under **Settings → AI models**. Claude Code uses the signed-in
   profile without copying credentials and requires an executable that supports
   `--safe-mode`. The task runs in an empty working directory without user
   hooks, skills, or MCP. Safe mode does not override organization-managed
   policy, which can still run managed hooks. Do not use this preview with a
   Claude Code profile that has managed hooks. If Claude Code requests sign-in,
   sign in to the assigned profile and retry. If it does not recognize safe mode,
   update the assigned executable.
   The Local AI Runtime logs a reason code without logging the provider's raw
   output. Synthesis uses the assigned AI Client subscription and may incur usage.
5. The runtime validates cited sources against eligible evidence, rechecks its
   inputs, computes the freshness timestamp, and returns a transient result.
   The runtime requests cancellation after 30 seconds; the AI Client may need
   additional time to shut down. Cancelling or closing the Kin discards the
   result. This path creates neither a Conversation nor a durable Memory Answer.
   It does not start, continue, interrupt, or hand off any captured work.

See [Desktop settings](desktop-settings.md#general),
[Raw ingestion and Projection](raw-ingestion-projection.md), and
[AI Client synthesis only](adr/0001-ai-client-synthesis-only.md).

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
chips. It stays visible below the chips even while a summary is open. The Kin
sleeps when capture activity is quiet, wakes for a minute on hover, and stays
awake while the main Koed window is focused. Drag the Kin to move the overlay
for the current Desktop session. The Kin and its controls receive clicks;
clicks in the surrounding transparent space pass through. Disable the preference
to hide it. The overlay has its own zoom, independent of the main Desktop
window. Quitting Desktop closes the Kin even if the Local AI Runtime stays up.

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
2. The runtime asks the local API for recent Personal activity. Activity and
   evidence reads require a Personal API Token and the Local AI Runtime’s
   same-user registration proof over loopback. Hosted deployments cannot serve
   those reads. Desktop polls a bounded feed of captured messages from the last
   30 minutes, ordered by captured activity time. Replay and imports do not
   create a fresh activity signal. Displayed information is limited to
   Conversation, Project, AI Client, and time metadata. Local reads do not
   require [optional Desktop sign-in](desktop-accounts.md); synthesis still
   requires the assigned AI Client to be ready. There is no Team path.
3. For a Conversation summary, the API can supply eligible captured items from
   the latest unfinished Claude Code or Codex turn before its Memory Events
   seal. Pi uses sealed Personal Memory only: its raw turn boundary is not yet
   verified here. A matching Claude Code completion signal closes the raw turn.
   If a safe turn boundary or complete initiating Claude Code message cannot be
   established, the read uses applicable sealed Personal Memory or returns no
   evidence. Kin uses the main Claude Code transcript rather than mixing its
   turn sequence with child-agent transcripts. Older capture without enough
   information to establish completeness and initiating messages above the raw
   evidence limit use the sealed path. A Project summary uses sealed Personal
   Memory for the selected Project and only if it still matches the
   Conversation's resolved Project. A Project change hides any previous Project
   result and cancels pending work.
   Sealed discovery scans at most 128 candidates for 32 eligible messages;
   tool-only rows do not consume message slots. Evidence is bounded and
   filtered for owner access, deletion, exclusion, and capture eligibility.
   Approval Activity, hidden reasoning, and generic raw
   records are not passed to the synthesis AI Client. The API does not do LLM
   synthesis.
4. The runtime passes the evidence as data to a short, separate synthesis task
   using the explicit Memory Answer assignment. The selected AI Client can
   differ from the AI Client shown in the captured activity. Codex and Pi can
   synthesize; there is no fallback. The assignment needs a current capability
   snapshot for the configured executable and profile. Review it under
   **Settings → AI models**.

   Codex uses the assigned profile's existing native sign-in, without copying
   credentials or requiring a second profile. It runs in an empty working
   directory in a fresh, ephemeral App Server thread with the same read-only,
   no-approval sandbox as Memory Answer and no Koed retrieval tools. The runner
   requests that Codex disable configured MCP servers, user hooks, prompt
   logging, and OpenTelemetry exporters for the summary. Kin checks the
   effective prompt logging and exporter settings before sending evidence. If
   they are enabled or cannot be verified, the summary is unavailable. These
   checks do not change Memory Answer or the assigned profile. Read-only is not
   a guarantee that no commands can run. Kin checks sign-in in the assigned
   profile, but the existing Memory Answer assignment screen may still report
   a Keychain-only profile as signed out when saving a new assignment. An
   existing working assignment needs no additional setup.

   Claude Code Conversations still appear in Floating Kin, but Claude Code is
   unavailable for Kin synthesis. The supported Claude Agent SDK cannot prove
   before launch that organization-managed hooks will not run. The runtime
   refuses the task rather than sending captured evidence to an unverified
   process. This does not change Claude Code capture or Memory Answer execution.
   The Local AI Runtime logs a reason code without logging the provider's raw
   output. Synthesis uses the assigned AI Client subscription and may incur usage.

5. The runtime validates citations and rechecks every admitted evidence item by
   ID, including uncited items. Newer capture does not displace items from this
   check. An item that seals during synthesis must still match its eligible
   sealed source; ambiguous lineage, changed content, or revoked access causes
   the result to be discarded. The runtime computes the freshness timestamp and
   returns a transient result. It requests cancellation after 30 seconds; the
   AI Client may need additional time to shut down. Cancelling or closing the
   Kin discards the result. This path creates neither a Conversation nor a
   durable Memory Answer.
   It does not start, continue, interrupt, or hand off any captured work.

See [Desktop settings](desktop-settings.md#general),
[Raw ingestion and Projection](raw-ingestion-projection.md), and
[AI Client synthesis only](adr/0001-ai-client-synthesis-only.md).

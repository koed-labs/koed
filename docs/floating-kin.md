# Floating Kin

The Chief of Staff Kin shows recent captured Personal Conversations. Capture
can lag or miss activity, and imported history does not count as recent
activity. An eligible Pi chip can also show **Working** when the connected Pi
extension explicitly reports active work. No badge means liveness is unknown,
not idle or finished. Other AI Clients do not report this status.

Inside Koed, the Chief of Staff takes the logo's place on the Home button at
the top of the left rail. The live Conversation chips sit directly below it,
including when the Projects and Anchors sidebar is collapsed. The floating
overlay keeps its chips above the Kin. A Conversation in exactly one named
Project uses that Project's Kin; one in zero or several uses the neutral Kin.
Anchors don't supply a Kin. A Conversation the Kin is tracking also shows its
capture age, or **Working**, at the end of its sidebar row; click it to open the
same dialog as a chip, beside the row.

On macOS, turn on **Chief of Staff** under **Settings → General** to let the Kin
float outside the Koed window. When the window loses focus or closes, the Kin
and its chips return to the desktop position you last dragged it to in this
Desktop session. When the window regains focus, the Kin returns to the rail
once the overlay finishes sliding out. With reduced motion enabled, the switch
is immediate. Each time the floating Kin appears, and whenever the pointer
leaves it, it stays live for three seconds, then glances up and fades to the
Koed logo. Hover it, or one of its Conversation chips, to wake it. The overlay does not take focus automatically; use
**Window → Focus Floating Kin** for keyboard access. Click the floating avatar
itself to open or focus Koed Desktop, or drag it to move the overlay. Clicks
around the Kin and its controls pass through. The overlay stays at 100% page
zoom; the main Desktop window can zoom independently. Quitting Desktop closes the overlay
even if the Local AI Runtime stays up.

Click a Conversation chip to see its captured context on the same surface,
without reopening the Koed window from the desktop overlay. The dialog shows
when the Conversation was last captured and, when available, its title, Project,
and short excerpts of the latest captured request and reply. A reply captured
before the latest request is labeled **Previous captured reply**. The preview
uses no model and does not indicate whether the AI Client is still working.
Click the Conversation title to open that Conversation in Koed Desktop. From
the desktop overlay this brings the Koed window forward first.
Choose **Summarize Conversation** for a brief on the latest captured work.
**Open last summary** reopens
the chip’s most recent successful summary, even after moving between the
sidebar and desktop, without using the model again. The settings button in the
dialog opens **Settings → AI models**. There is no free-text prompt. An answer
separates the account of captured work from any inference. **As of** is the time
of the newest cited source, calculated by Koed. It is not the current state of
the AI Client. The answer identifies its sources and the synthesis AI Client,
model, and reasoning effort when available.

## Read and synthesis path

1. The active Desktop or overlay renderer asks the main process for activity,
   a bounded preview, or a fixed summary through its own preload. Neither
   renderer receives API credentials or raw records. The main process reads an authenticated loopback registration
   for the existing Local AI Runtime. While Desktop is starting and the runtime
   hasn’t published its endpoint yet, the Kin shows that it’s starting. The Kin
   never starts or resumes a runtime, including after **Stop Koed**. If Koed is stopped, start it explicitly from
   Desktop to use the Kin again.
2. The runtime asks the local API for recent Personal activity. Activity and
   evidence reads require a Personal API Token and the Local AI Runtime’s
   same-user registration proof over loopback. Hosted deployments cannot serve
   those reads. Preview reads use the same authorization. Desktop polls a bounded feed of captured messages from the last
   30 minutes, ordered by captured activity time. Replay and imports do not
   create a fresh activity signal. The activity feed contains only Conversation,
   Project, AI Client, and time metadata. The runtime can add a short-lived Pi
   status to already eligible chips. It matches the authenticated owner's Pi
   Conversation and rechecks its Personal Capture Policy and connection. This
   does not create, reorder, or keep a chip in the feed. Opening a chip makes a separate
   local-only preview request for that Conversation. It checks that the
   Conversation still qualifies for the feed and returns only short excerpts of
   eligible Personal messages. Unfinished turns must pass the same proof as
   summary evidence; Pi previews are sealed only. Local reads do not require
   [optional Desktop sign-in](desktop-accounts.md); synthesis still
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
   dialog discards in-flight work. The Local AI Runtime keeps the latest
   successful summary per recent Conversation in a bounded in-memory cache.
   Opening it again rechecks every admitted evidence item, including uncited
   items, before showing the answer. Project summaries also require the same
   Project. History expires and is lost when the Local AI Runtime restarts.
   This path creates neither a Conversation nor a durable Memory Answer.
   It does not start, continue, interrupt, or hand off any captured work.

See [Desktop settings](desktop-settings.md#general),
[Raw ingestion and Projection](raw-ingestion-projection.md), and
[AI Client synthesis only](adr/0001-ai-client-synthesis-only.md).

# Pi integration

Koed supports independently installed Pi as an AI Client driver. Koed does not bundle Pi, store Pi provider credentials, or use Codex or Claude Code as fallback for Pi work.

## Requirements

- Pi `0.84.2` or newer
- Pi installed separately and available on `PATH`, or configured with absolute `KOED_PI_EXECUTABLE`
- At least one Pi model authenticated through Pi
- Persistent Pi sessions enabled for automatic capture

Koed canonicalizes configured executable paths and fails closed when executable, version, selected model, or Pi-managed authentication is unavailable. Models use full Pi provider/model identity, such as `anthropic/claude-opus-4-6` or `openai/gpt-5.4`.

## Setup

After Koed runtime starts:

```bash
node packages/koed-server/dist/cli.js setup pi --json
```

In Koed Desktop, open **Preferences → Advanced Diagnostics** and choose **Set up Pi
integration**. The same screen reports active-profile health and offers an
idempotent repair action. Pi remains optional; leaving it unconfigured does not
block Codex or Claude Code setup or Koed's local runtime health.

Contributor checkout alternative:

```bash
pnpm pi:configure
pnpm pi:check
```

Setup copies Koed-owned package to `$KOED_HOME/integrations/pi/` and runs `pi install` with that stable local path. Pi records package in active global profile. Next ordinary `pi` startup loads integration; no wrapper or separate extension command needed.

Koed canonicalizes the Pi executable before invoking it and passes a bounded
setup environment containing profile/system essentials plus `KOED_HOME`, not
Koed API Tokens, database credentials, or provider keys. Setup also requires at
least one authenticated Pi model. The installed extension derives custom
`KOED_HOME` from its stable package path when an ordinary later Pi process does
not inherit that environment variable.

Custom profiles remain supported:

```bash
PI_CODING_AGENT_DIR=/path/to/profile pnpm pi:configure
```

Configure, check/repair, and remove touch only Koed package entry and stable package directory. Unrelated Pi packages, extensions, skills, prompts, themes, and settings remain unchanged.

## Recall

Extension exposes:

- `memory_answer`
- `memory_intake_propose`

Tools call authenticated Local AI Runtime through local runtime registration. Pi configuration receives only `KOED_HOME`; it receives no Koed API Token, backend URL, or provider credential. Missing Koed runtime causes tool-local error and does not terminate Pi session.

`--no-extensions`, `--exclude-tools`, package resource controls, and related Pi controls remain authoritative. Persistent sessions still capture while extension disabled, but recall readiness should be treated as unavailable until extension enabled.

## Capture

Local AI Runtime supervises Pi Transcript Watcher. Persistent Pi JSONL session file is Conversation source of truth. Extension writes content-free wake signal containing session ID, session path, cwd, event name, and observation time.

Watcher:

- discovers default `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions` and `PI_CODING_AGENT_SESSION_DIR`;
- baselines files present before activation;
- journals complete LF-terminated records only;
- keeps independent durable `canonical_live` source cursor;
- verifies covered segment digest before append;
- stops visibly on malformed complete records, unsupported session versions, truncation, or covered-prefix mutation;
- enforces Capture Policy and Capture Pause before source creation, journal append, and raw ingestion;
- creates Personal Memory only;
- converges duplicate, delayed, or reordered signals through stable entry-based idempotency keys;
- performs periodic filesystem recovery, so extension signals are latency hints rather than correctness path.

Pi `--no-session` sessions have no source artifact and cannot be captured automatically. Extension reports warning instead of healthy capture.

### Projection

Adapter tuple:

- driver/source runtime/source kind: `pi`
- artifact format: `pi_session_jsonl` version 1
- source adapter: `pi-session-v1`

Projection includes actual User, AI Client text, tool calls, tool results, and direct bash records. Compaction summaries, branch summaries, thinking, custom entries, model changes, and unsupported records remain raw provenance and do not become semantic content.

Metadata preserves Pi entry ID, parent ID, append position, provider/model identity, cwd Project context, session parent provenance, and source fingerprint.

In-place `/tree` branching remains one append-only Conversation Source Artifact. Each actual message entry projects at most once; changing active branch does not retract existing Memory. `/fork` and `/clone` create separate session files and Conversation lineages with `parentSession` provenance. In-place branch diagnostics remain a follow-up area.

## Historical import

Activation baseline is separate from explicit historical import. Live watcher never projects pre-activation records as fresh activity. Historical import uses `pi-session-v1` and `historical_import` transport through canonical source journal and historical import APIs.

## Local Synthesis

Pi can be assigned independently to Memory Answer, LCM Summary, session-title generation, and Curated Memory Review. Assignment requires healthy authenticated `pi.default` or configured Pi instance capability snapshot and full provider/model ID.

Koed launches Pi with strict-LF JSONL RPC using:

- `--no-session`;
- no built-in tools;
- no project/user extension discovery;
- no skills, prompt templates, themes, or context files;
- one explicit Koed structured-result extension;
- neutral temporary cwd;
- minimal environment allowlist;
- timeout and process-tree termination.

Structured-result bridge validates schema-constrained final tool arguments and terminates task. Koed records actual provider/model from Pi RPC events. No fallback to Codex or Claude occurs.

## Diagnostics

```bash
pi --version
pi --list-models
pnpm pi:check
node packages/koed-server/dist/cli.js doctor --json
```

Relevant environment:

- `KOED_PI_EXECUTABLE`: absolute Pi executable path
- `PI_CODING_AGENT_DIR`: Pi profile home
- `PI_CODING_AGENT_SESSION_DIR`: explicit Pi session root
- `MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED=false`: disable watcher intentionally

Common failures:

- **Pi missing/incompatible**: install Pi `0.84.2+` and rerun setup.
- **No models**: authenticate model through Pi, then refresh capability snapshot.
- **Recall tool absent**: ensure package configured and extensions not disabled.
- **Ephemeral session**: remove `--no-session` for automatic capture.
- **Capture stopped**: inspect Local AI Runtime logs for malformed record, truncation, prefix mutation, policy, or pause diagnostic. Cursor does not advance on these errors.

## Removal

```bash
pnpm pi:remove
```

Removal runs `pi remove $KOED_HOME/integrations/pi`, deletes only Koed-owned package directory, and preserves unrelated Pi configuration. Captured Personal Memory remains in Koed until removed through normal Memory controls.

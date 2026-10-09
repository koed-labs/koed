# MCP Integration, Configuration, and Lifecycle

Koed connects its MCP Server to an AI Client only after an Operator explicitly
runs that client's setup action or confirms setup in Koed Desktop. Installing
Koed, starting its services, or completing core setup does **not** discover AI
Clients or write their integration configuration. There is no auto-registration
disable flag because registration is opt-in. Claude Desktop is not a supported
Koed integration; Koed supports Claude Code.

> **Restart after setup:** AI Clients load MCP and extension configuration at
> startup. Fully quit and relaunch the client after setup or repair. Pi loads its
> Koed extension on its next ordinary startup.

Setup can register the MCP Server and, for supported clients, Koed's Capture
Hook or extension. The paths and ownership rules below describe what setup
changes; Koed does not copy its API Token or provider credentials into client
configuration.

## Supported clients and configuration paths

Koed supports macOS, Linux, and WSL. Defaults below are under the Operator's
home directory; on Windows, use Koed inside WSL, where Linux paths apply.

| AI Client       | Koed-managed configuration and defaults                                                                                                                    | Overrides                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | User-scoped MCP entry in `~/.claude.json`, written through the Claude Code CLI. Koed Capture Hook entries in `~/.claude/settings.json`.                    | `CLAUDE_CONFIG_DIR` changes the MCP file to `<dir>/.claude.json` and the default hook settings file to `<dir>/settings.json`. `CLAUDE_SETTINGS_PATH` overrides the hook settings file directly. MCP name defaults to `koed`; `MEMORY_MCP_NAME` changes it. |
| **Codex**       | Koed-owned MCP and Capture Hook block in `~/.codex/config.toml`. Optional Koed-managed memory guidance in `~/.codex/AGENTS.md`.                            | `CODEX_CONFIG_PATH` overrides the TOML path; otherwise `CODEX_HOME/config.toml` is used when `CODEX_HOME` is set. `CODEX_HOME` also selects the global `AGENTS.md`; default is `~/.codex`. `MEMORY_MCP_NAME` changes the MCP name from `koed`.             |
| **Pi**          | Koed stages its extension package at `$KOED_HOME/integrations/pi/` and registers that package with Pi in the active global profile, default `~/.pi/agent`. | `PI_CODING_AGENT_DIR` selects another Pi profile directory. Pi's `pi install` command manages its profile registration; Koed does not directly edit a Pi settings file.                                                                                    |

These are Koed's defaults and supported overrides, not paths for Claude Desktop
or arbitrary client installations. See each client guide for setup details:
[Claude Code](claude-code-integration.md), [Codex](codex-integration.md), and
[Pi](pi-integration.md).

## What setup changes—and what it preserves

Setup and repair are explicit write operations. `check <client> --json` is
read-only. Removal deletes Koed-owned integration state, not the whole client
configuration.

- **Claude Code:** Koed invokes `claude mcp add --scope user` and updates the
  Koed Capture Hook entries in the selected settings file. Other MCP names and
  unrelated hooks are retained. An existing user-scoped MCP entry with the
  configured name (`koed` by default) is deliberately replaced on successful
  setup; Koed saves the previous entry and restores it if setup fails. If your
  existing server uses that name, inspect it first or choose a distinct
  `MEMORY_MCP_NAME`.
- **Codex:** Koed writes its MCP and Capture Hook configuration inside the
  `# >>> koed` / `# <<< koed` ownership block and updates only its managed block
  in global `AGENTS.md`. Text outside those blocks is preserved. A separate,
  unmarked Codex server with the same name is not Koed-owned; resolve that name
  collision or choose a distinct `MEMORY_MCP_NAME` before setup. Malformed Koed
  markers make setup stop rather than guess which text it may change.
- **Pi:** Koed installs or updates its stable package path and registers that
  package with Pi. Unrelated packages, extensions, skills, prompts, themes, and
  settings remain unchanged.

Koed does not offer a blanket guarantee that every client config file is
untouched except for a generic `mcpServers.koed` merge. Each client has a
different integration mechanism, and same-name behavior differs as noted above.

## Restart and verify

After setup or repair, fully quit and restart Claude Code or Codex. Pi loads the
registered extension on its next ordinary startup. Restart after removal too,
so a running client drops its cached server or extension.

| AI Client       | Verify configuration or connection                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Run `claude mcp list`; inside Claude Code, run `/mcp` and look for Koed tools. `koed check claude --json` checks Koed's integration state.                     |
| **Codex**       | Run `koed check codex --json` to check the configured integration. After restart, ask Codex to call `memory_answer` (example below) to verify a live MCP call. |
| **Pi**          | Run `koed check pi --json` to check the configured integration. Start Pi after setup, then ask it to call `memory_answer` (example below).                     |

A successful `check` confirms setup state, not necessarily a live tool call. To
test live connectivity in Codex or Pi, ask:

```text
Call Koed's memory_answer tool with query "MCP connection check",
search_domain "project", and response_detail "with_citations". Report whether
the tool call succeeded and return its result.
```

The query may return no matching memories; successful tool execution confirms
connectivity. `memory_answer` creates an inspectable Memory Question.

For a source checkout, prefix Koed CLI commands with
`node packages/koed-server/dist/cli.js`.

## Tools and permissions

Koed exposes memory capabilities, not arbitrary shell execution or local file
editing through its MCP Server.

| Tool                                                    | Availability and effect                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_answer`                                         | Default recall tool. Retrieves memory authorized for the current API Token and search scope; the configured Local AI Runtime synthesizes a Memory Answer from evidence, with no backend LLM synthesis. It can return citations/evidence and records an inspectable Memory Question. It does not edit source memory. |
| `memory_intake_propose`                                 | Capability-gated. Submits a source-linked candidate for asynchronous review; it does not directly write Curated Memory.                                                                                                                                                                                             |
| `memory_access_check`, `memory_search`, `memory_expand` | Diagnostic tools hidden by default; visible only when explicitly enabled.                                                                                                                                                                                                                                           |

The AI Client's active permission policy controls whether a tool call prompts
for approval; Koed cannot promise that every client will show a confirmation
dialog. Codex setup explicitly preapproves `memory_answer` only. It does not
preapprove `memory_intake_propose`; client permission settings govern that
write-capable proposal call.

## Remove before uninstalling Koed

Remove each configured integration before uninstalling Koed or deleting its
runtime. This lets Koed unregister the client entry and its Capture Hook or
extension state while Koed's removal command is still available:

```bash
koed remove claude --json
koed remove codex --json
koed remove pi --json
```

Run only commands for clients you configured. Koed removal leaves captured
Personal Memory intact; manage that separately through Koed's Memory controls.

If Koed is already unavailable, clean up only its own integration state—never
delete the whole client configuration file:

- **Claude Code:** inspect `claude mcp list`, then remove the Koed entry with
  `claude mcp remove --scope user koed` (replace `koed` if you configured a
  different `MEMORY_MCP_NAME`). Remove only Koed Capture Hook entries from the
  selected Claude settings file.
- **Codex:** remove only the text between `# >>> koed` and `# <<< koed` in
  `config.toml`, and Koed's managed guidance block in the selected global
  `AGENTS.md`. Leave all text outside those blocks intact.
- **Pi:** run `pi remove /absolute/path/to/KOED_HOME/integrations/pi` using the
  actual Koed home path. Remove the package directory only after confirming it
  is Koed's stable integration path.

## Manual MCP setup for custom clients

<details>
<summary>Using a custom client or non-standard path? Manual setup</summary>

This snippet applies only to clients that document the standard JSON
`mcpServers` structure. It registers only the MCP Server; it does not install a
Capture Hook. It is not Codex's TOML setup or Pi's package registration; Claude
Code's supported setup uses its CLI. For supported clients, use their
integration guides and setup commands. For a custom JSON-based client, replace
both paths with absolute paths from your Koed installation and keep Koed running
so the MCP Server can reach its local runtime.

```json
{
  "mcpServers": {
    "koed": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/koed/mcp-server/dist/cli.js"],
      "env": {
        "KOED_HOME": "/absolute/path/to/koed-home"
      }
    }
  }
}
```

Merge the `koed` entry into the client's existing MCP server object; do not
replace the whole file. Koed has no generic `koed mcp` command, and the MCP
Server path varies by installation.

</details>

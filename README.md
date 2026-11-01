<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/koed-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/koed-logo.svg">
  <img alt="Koed" src="docs/assets/koed-logo.svg" width="190" height="60">
</picture>

### Solve it once. Remember it for good.

Long-term memory for Codex, Claude Code, and Pi. Private, local, and yours.

[![Latest release](https://img.shields.io/github/v/release/koed-labs/koed)](https://github.com/koed-labs/koed/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL-lightgrey)
[![Supported AI Clients](https://img.shields.io/badge/AI%20Clients-Codex%20%7C%20Claude%20Code%20%7C%20Pi-6e40c9)](#connect-an-ai-client)

[Features](#features) • [Quickstart](#quickstart) • [Connect an AI Client](#connect-an-ai-client) • [Documentation](#documentation)

</div>

Every new AI session starts from zero. You explain the project again, repeat
your preferences again, and watch the agent try the fix that failed last week.

Koed ends that. It captures your AI coding sessions in the background and gives
your AI Client a memory it can search. The next session starts with the
decisions, dead ends, and context from the last one.

Your memory stays on your machine or on a server you run. Koed stores and
searches it. Your AI Client writes the answers, so no extra LLM sits in the
middle.

## Features

- **Zero-effort capture.** Koed records Codex, Claude Code, and Pi
  conversations in the background. There is nothing to copy, paste, or tag.
- **Recall with receipts.** The `memory_answer` MCP tool gives your AI Client
  evidence with citations, so you can see where each answer came from.
- **Local first.** Postgres, pgvector, and the models run natively under
  `KOED_HOME`. No Docker and no cloud account.
- **Organize without losing the source.** Include a Conversation in several
  Projects. Recall its recorded Git Anchor or exact Folder independently.
- **See everything Koed knows.** Koed Desktop lets you browse every Project,
  session, and conversation in your memory.
- **You decide what is remembered.** Capture Policies, Capture Pause, and a
  local Privacy Filter model control what Koed keeps and what it masks.
- **Grows with you.** Pair your other devices, and share memory with your team
  through a Team Workspace.

## Quickstart

### Requirements

- macOS, Linux, or WSL
- [Node.js](https://nodejs.org) 24 and [pnpm](https://pnpm.io)
- [Homebrew](https://brew.sh), for the native runtime

> [!NOTE]
> On Windows, run Koed in WSL. Keep `KOED_HOME` and the checkout on the Linux
> filesystem.

### Start Koed Desktop from source

```bash
pnpm install
pnpm local:setup
KOED_DEPENDENCY_MODE=bundled-local KOED_AUTO_PORTS=1 pnpm desktop:start
```

`pnpm local:setup` creates `.env`, builds the workspace, links the Homebrew
runtime, and installs the models. Koed Desktop opens when setup is complete.

To stop Koed, run:

```bash
pnpm koed stop --json
```

<details>
<summary>Set up without Desktop</summary>

Run this command. It does not connect an AI Client.

```bash
pnpm koed setup core --json
```

For other ways to run Koed, see [Running Koed](docs/running-koed.md).

</details>

## Connect an AI Client

Koed works without an AI Client. Install each client yourself.

After setup, Koed Desktop offers to connect your clients. Select one or more
clients, or select **Set up later**. Desktop never selects a client for you.

You can also connect a client from the command line:

| AI Client   | Minimum version | Setup                              | Guide                                                      |
| ----------- | --------------- | ---------------------------------- | ---------------------------------------------------------- |
| Codex       | Not listed      | `pnpm koed setup codex --json`     | [Codex integration](docs/codex-integration.md)             |
| Claude Code | `2.1.227`       | Desktop → **Preferences → Agents** | [Claude Code integration](docs/claude-code-integration.md) |
| Pi          | `0.84.2`        | `pnpm koed setup pi --json`        | [Pi integration](docs/pi-integration.md)                   |

> [!IMPORTANT]
> Each client works independently. If one client fails, the others continue to
> work. Koed never uses one client in place of another. To choose the model for
> each task, see [Local AI Runtime settings](docs/local-memory-agent-settings.md).

To add another of your devices, run `pnpm koed pair` on that device. Then paste
its link into **Devices → Add device** in Koed Desktop. For more, see
[Device pairing](docs/device-pairing.md).

## Documentation

| Topic      | Read                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run        | [Running Koed](docs/running-koed.md) · [Configuration](docs/configuration.md) · [Server deployment boundary](docs/server-deployment-boundary.md)                                                                                      |
| Desktop    | [Desktop UI](docs/desktop-ui.md) · [Packaged Desktop](apps/desktop/README.md) · [Managed Conversation routing](docs/managed-conversation-ai-client-routing.md)                                                                        |
| Memory     | [Service sequence overview](docs/service-sequence-overview.md) · [Durable Memory Answer](docs/durable-memory-answer.md) · [Curated Memory](docs/curated-memory.md) · [Raw ingestion and Projection](docs/raw-ingestion-projection.md) |
| Teams      | [Team collaboration](docs/team-collaboration.md) · [Shared memory owner workflow](docs/shared-memory-owner-workflow.md)                                                                                                               |
| Operations | [Security](docs/security.md) · [Backup and restore](docs/backup-restore.md) · [Upgrades](docs/upgrades.md) · [Observability](docs/observability.md)                                                                                   |
| Project    | [Glossary (`CONTEXT.md`)](CONTEXT.md) · [ADRs](docs/adr/) · [Release versioning](docs/release-versioning.md) · [Commercial feature boundary](docs/commercial-feature-boundary.md)                                                     |

Personal Projects support direct inclusion, Git Anchor and exact Folder rules,
and Project-only exclusions. **Add to Project** keeps recorded source context
and Capture Targets independent. Projects are available directly; no existing-Project
upgrade or activation step is required. See the
[Personal selection contract](docs/personal-selection-contract.md).

## Security

The Operator (the person who runs Koed) controls the deployment. Clients use
API Tokens, and Koed stores only token hashes. Keep Postgres and Redis on
private networks. On a VPS or team server, turn on envelope encryption for
Memory and evidence.

> [!CAUTION]
> Do not report vulnerabilities or share Memory data in public issues. Use the
> private process in [SECURITY.md](SECURITY.md). To harden a deployment, see
> [docs/security.md](docs/security.md).

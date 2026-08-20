# ADR 0030: Pi CLI RPC transport and global local package

- Status: Accepted
- Date: 2026-08-17

## Context

Koed needs Pi capture, Recall tools, and local Synthesis without bundling Pi or receiving Pi provider credentials. Pi already owns model authentication, persistent JSONL sessions, global package configuration, extension lifecycle, and strict-LF RPC mode.

Alternatives were direct provider API calls, bundled Pi runtime, project-local extension files, wrapper-only launch, or prose parsing from print mode. Direct calls and bundling cross credential/packaging boundaries. Project-local or wrapper-only setup does not make Recall available on ordinary Pi startup. Prose parsing weakens result validation and termination.

## Decision

Treat separately installed Pi CLI as independent AI Client driver `pi`.

Guided setup places Koed-owned Pi package at stable `$KOED_HOME/integrations/pi/` path and runs `pi install <path>` against active global Pi profile. Configuration contains only stable package path and `KOED_HOME`; no Koed API Token, backend URL, Pi provider credential, or provider executable is copied.

Use persistent Pi JSONL session files as capture source of truth. Koed extension emits content-free wake signals only. Local AI Runtime owns supervised filesystem watcher and durable source cursor.

Use Pi strict-LF JSONL RPC for local Synthesis. Worker process uses `--no-session`, disabled built-in/project/user resources, neutral cwd, minimal environment, and one explicit Koed structured-result extension. Timeout or cancellation terminates process tree. Driver fails closed and never falls back to another AI Client.

## Consequences

- User installs and authenticates supported Pi independently.
- Pi updates can change compatibility; Koed documents and enforces minimum version.
- Global local-package entry makes Recall available on ordinary startup while respecting Pi resource-disable controls.
- Stable path enables idempotent repair/removal without changing unrelated profile settings.
- JSONL transcript preserves complete provenance and supports filesystem recovery independent of extension signals.
- RPC subprocess adds framing, cancellation, timeout, and process-tree handling requirements.
- Structured-result extension remains Koed-owned worker implementation detail and is not globally installed as separate resource.
- Underlying Pi provider/model identity is retained for routing and usage diagnostics.

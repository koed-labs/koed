# CLI migration compatibility record

This record captures the handwritten CLI before Commander migration on 2026-10-30.
The command inventory in the migration plan lists every family and route.
The tables below add the argument and output contracts that help text does not capture.
Migration acceptance completed on 2026-10-30. The final section records results and validation limits.

## Invocation and output

The public callable entrypoint accepts a user argument array and optional injected dependencies, then returns a numeric exit code.
The standalone executable and installed Desktop launcher call this boundary.
Desktop first verifies its installation and creates a capability plus a trusted supervisor invocation.
The dedicated supervisor entrypoint keeps its separate private protocol.

| Case                              | Existing contract                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| No arguments or explicit help     | Success, stdout, no service action. Personal Sync has separate ordinary and advanced views.                                     |
| Unknown top-level command         | Code 2 and human-readable stderr, even with `--json`.                                                                           |
| Most domain validation exceptions | Code 1. With `--json`, stdout contains `{ ok: false, error }`. Otherwise stderr contains the message.                           |
| Most successful operations        | Pretty JSON with `--json`. Otherwise a command-specific message. Preserve each operation's success/failure exit code.           |
| Status                            | Code 0 for collected service state. `--startup` avoids full status collection. Missing core setup returns 1 before collection.  |
| Doctor                            | Persists diagnostic metadata and returns 0 or 1 from `ok`.                                                                      |
| Identity                          | Redacted output. Returns 0 only when remote operations are allowed.                                                             |
| Model status                      | Returns 1 for checksum mismatch and 0 for other inspected states.                                                               |
| Runtime status/install            | Returns 0 or 1 from `ok`. Installation requires explicit bundled-local mode.                                                    |
| Pair                              | Bare command creates enrollment and waits. `--detach` returns after creation. JSON progress can contain multiple records.       |
| Remote operations                 | Success output is JSON even without `--json`. That flag selects pretty output. Errors retain their existing redacted states.    |
| Remote start                      | Writes running state, then waits for SIGINT/SIGTERM and closes the Local AI Runtime.                                            |
| Secret provider                   | Exact positional cardinality. `get` writes raw secret bytes without a newline. `put` reads bounded stdin. No generic JSON flag. |
| Desktop broker                    | Private foreground protocol, separate from public JSON output.                                                                  |

The old dispatcher identifies commands by fixed leading positions.
Value flags use a separate following token, and most families select the first matching value flag.
Boolean flags use token presence.
Most old branches ignore unknown flags and surplus arguments. Component and secret-provider commands explicitly reject them.
The migration intentionally rejects unsupported syntax, but must preserve actual caller contracts.
Commander can accept `--flag=value`; actions must consume parsed values rather than forwarding this spelling into old value readers.
The `--` delimiter must not turn trailing positional input into an executable option.
Parser diagnostics must not echo sensitive values.

## Public argument inventory

All public operations below support `--json` unless a more specific contract above applies.
Required and conditional inputs retain the domain validation described by their handlers.

| Routes                                                | Existing flags and defaults                                                                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                                               | `--daemon`; default foreground supervisor.                                                                                                                                                                                                    |
| `stop`, `restart`, `doctor`, `identity status/rotate` | No additional public flags consumed by the dispatcher.                                                                                                                                                                                        |
| `status`                                              | `--startup`; default full service status.                                                                                                                                                                                                     |
| `pair`                                                | `--device-label <name>`, `--detach`; default waits. `status/cancel` are explicit subcommands.                                                                                                                                                 |
| `setup core/pi`                                       | No additional flags consumed by the dispatcher.                                                                                                                                                                                               |
| `setup codex`                                         | `--with-memory-guidance`, `--without-memory-guidance`, `--deferred-recall`, `--blocking-recall`. Each opposing pair conflicts. Recall flags emit a deprecation message.                                                                       |
| `setup claude`                                        | `--background-recall`; explicit opt-in.                                                                                                                                                                                                       |
| `check <client>`                                      | `--capabilities-refreshed-since <value>`, `--include-status`. Clients: codex, claude, pi.                                                                                                                                                     |
| `repair/remove <client>`                              | Clients: codex, claude, pi. Preserve the special Codex repair message.                                                                                                                                                                        |
| `models status/install`                               | `--kind <embedding\|privacy>`; default embedding. Merge checkout environment with nonempty process values taking precedence.                                                                                                                  |
| `runtime status/install`                              | `--provider <homebrew\|packaged>`; default homebrew. `--dependency-mode <mode>` is read for both; install requires bundled-local. Same environment precedence as models.                                                                      |
| `package status`                                      | No additional flags.                                                                                                                                                                                                                          |
| `package install`                                     | `--source`, `--sha256`, `--sha256-file`, `--activate`, `--provenance-file`, `--signature-file`, `--trusted-public-key`, `--trusted-public-key-file`, `--trust-policy`, `--allow-downgrade`. Source required.                                  |
| `package activate`                                    | Required `--version`; optional `--allow-downgrade`.                                                                                                                                                                                           |
| `package cleanup`                                     | `--keep`; default 1, existing integer parsing.                                                                                                                                                                                                |
| `components status/cleanup`                           | Only `--json`.                                                                                                                                                                                                                                |
| `components install`                                  | `--component`, `--variant` (cpu or cuda, Linux x64 Privacy only), `--version`, `--archive`, `--manifest`, `--archive-url`, `--manifest-url`, `--stage-only`. Exactly one complete offline or network source pair. Component: base or privacy. |
| `components activate`                                 | Required `--version`. All component commands reject duplicates and unknown flags. Desktop retains its management restriction.                                                                                                                 |
| `remote login`                                        | `--backend`, `--consent`, `--local-runtime`, `--team-read`, `--koed-home`. HTTPS backend required.                                                                                                                                            |
| `remote logout/start`                                 | Applicable `--consent` and `--koed-home`. Preserve existing operation-specific checks.                                                                                                                                                        |
| `remote setup/check/remove <client>`                  | Clients: codex, claude, pi. `--consent`, `--koed-home`. Setup/remove require consent.                                                                                                                                                         |
| `upstream register`                                   | Required `--url`; optional `--id`, `--name`, `--profile`.                                                                                                                                                                                     |
| `upstream refresh/policy/activate/remove/disconnect`  | Required `--id`.                                                                                                                                                                                                                              |
| `upstream policy`                                     | Value flags: `--personal-memory-read`, `--personal-collaboration`, `--team-workspace-read`, `--share-grant-management`, `--capture-writes`, `--sync`, `--managed-execution`, `--admin`. Values must be enabled or disabled.                   |
| `upstream enroll start`                               | Required `--id`, `--source-owner-principal-id`; `--memory-answers` and `--enable-memory-answers` are equivalent booleans.                                                                                                                     |
| `upstream enroll status/cancel`                       | Required `--id`.                                                                                                                                                                                                                              |
| `project discover/show`                               | `--cwd`; default current directory. Discover also consumes `--codex`.                                                                                                                                                                         |
| `project list/forget`                                 | Forget requires `--local-project-id`.                                                                                                                                                                                                         |
| `project anchor`                                      | Required `--local-project-id`, `--checkout-id`; `--reset` selects null remote, otherwise `--remote` is required.                                                                                                                              |
| `team workspace link`                                 | Required `--project-root`, `--team-workspace-id`; optional `--backend-id`, `--upstream-backend-id`, `--local-project-id`, `--project-display-name`. Backend-id takes precedence over its alias.                                               |
| `team workspace show/remove`                          | Required `--project-root`. List consumes no additional flags.                                                                                                                                                                                 |

## Recovery and private input

Personal Sync strips the outer `--json` flag before calling recovery operations.
Ordinary status automatically uses local Personal credentials only for the validated local API origin.
Advanced operations retain their signed artifacts and session requirements.
The existing recovery routines remain authoritative for operation-specific validation.

| Recovery input                    | Contract                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password                          | Exactly one of `--password-stdin` or `--password-fd`. Reject password values in arguments.                                                                                                            |
| Pairing link                      | Exactly one of `--link-stdin` or `--link-fd`. Reject obsolete `--link` arguments.                                                                                                                     |
| Group selection                   | `--group-id`; existing bounded printable identifier validation.                                                                                                                                       |
| Bootstrap                         | `--recovery-kit`, `--runtime-secret-ref`, protected password input; runtime secret can come from the existing environment.                                                                            |
| Join and active-device operations | Existing invitation/request/statement/key-bundle/proof file descriptors, user ID, and challenge ID. Each route declares only the file descriptors and identifiers consumed by its existing operation. |
| Recovery-kit create               | `--output`, `--payload-fd`, protected password input.                                                                                                                                                 |
| Recovery-kit verify               | `--recovery-kit`, protected password input, existing file permission requirements.                                                                                                                    |
| Secret-provider `get/put/delete`  | Exactly one reference after the operation. `put` reads protected stdin only after accepting cardinality.                                                                                              |

The advanced route inventory includes group, invite, join, active-device, device, policy, replica, retry, recovery, and recovery-kit commands.
Normal help keeps these routes separate from ordinary pairing.
Public help and suggestions omit secret-provider and Desktop broker routes.
The Desktop revocation caller also supplies `--device-id`. The CLI retains this hidden compatibility flag.
The recovery routine still requires the signed transition input and does not use this metadata as authorization.

## Parser decisions

The command tree now supplies root, group, leaf, and advanced help.
Explicit help returns zero without invoking an action. Bare `pair` retains its enrollment action.
Public help and suggestions omit internal routes. Group help lists immediate children.

Commander accepts `--flag=value`, separate value tokens, and supported flags around subcommands.
The `--` delimiter ends option parsing. Surplus positional values and unknown flags fail before command actions.
Most repeated value flags keep the first supplied value, including protected file descriptors.
Component commands retain explicit duplicate rejection.

New parser syntax errors return 2. Existing component-input failures return 1.
Secret-provider cardinality failures retain their usage text and return 1 before stdin reads.
Known public families with `--json` emit a clean JSON parser-error envelope.
Unknown root commands retain human-readable stderr. Parser diagnostics omit raw argument values.
Existing domain validation, output streams, JSON results, and operation exit codes remain unchanged.

## Acceptance evidence

The complete Server run passed 1,058 tests across 80 files on Node 24.14.0.
After retaining the hidden Desktop revocation flag, all 30 Personal Sync tests passed.
That flag remains metadata. It does not bypass signed transition requirements.
The five affected packaging tests passed, including nested help and byte-exact secret-provider output from an assembled public package.

Server typechecking, the final clean build, and scoped lint passed.
Changed files pass formatting. Full repository formatting reports only the pre-existing untracked `CONFIG.md` failure.
Full repository lint exhausted its 4 GB heap. This record does not claim a clean full-repository lint result.

The checksum-verified macOS arm64 standalone development archive passes nested help, embedding/privacy status, runtime/component status, and protected-input rejection.
The same self-contained control plane passes those CLI checks on Linux x64 Node 24.14.0.
Runtime status correctly reports unavailable packaged dependencies with exit code 1.
Archive assembly also passes its native terminal-runtime smoke check.

A disposable installed Desktop layout uses Electron 39.8.10 and embedded Node 22.22.1 with a real ASAR and installation verification.
Nested help and embedding/privacy status pass without provisioned services.
Component management remains denied. Tampered bundle contents prevent help from running.
The Server suite also covers Desktop capability forwarding, trusted supervisor invocation, missing-service imports, and no-action help.

All mutating checks use disposable state. These fixtures do not establish signed production release acceptance or Linux native dependency qualification.
No credentials, active installation, or publication state changed.
The standalone candidate uses catalog-less development mode. Existing native release qualification remains separate from this parser migration.
The existing Desktop revocation wrapper's missing signed input remains an implementation follow-up in the project backlog.

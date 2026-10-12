export const personalSyncUsageText = `Personal Sync

  koed pair                   Connect this device using a request link
  koed pair status            Show pending pairing progress
  koed pair cancel            Cancel a waiting request
  koed personal-sync status --json
                                     Show this installation’s group and members

Create your first group and manage devices in Electron → Devices.
Status uses the local Personal installation automatically; no browser session is needed.

  koed personal-sync --help --advanced
                                     Show retained low-level recovery commands
`;

export const personalSyncAdvancedUsageText = `${personalSyncUsageText}
Advanced compatibility and recovery commands:
  group bootstrap [--recovery-kit <path>] [--password-fd <fd>]
  invite create --group-id <id>
  join redeem --link-stdin [--device-label <name>]
  join request | complete | bind-local-user | challenge
  active-device approve | refresh
  device list --group-id <id>
  device revoke
  policy enable | pause | resume --group-id <id>
  replica status --group-id <id>
  retry --group-id <id>
  recovery approve | guidance
  recovery-kit create | verify

These are protocol/recovery operations, not the normal pairing flow. They need
operation-specific signed artifacts, protected file descriptors, and/or browser
session context. Use the recovery and protocol documentation before running them.
Only status configures local authentication automatically. Existing scripts remain
supported; use pair and Electron for ordinary enrollment and device management.
`;

export const usageText = `Usage: koed <command> [options]

Commands:
  start                  Start and supervise local Koed services
  start --daemon --json  Start koed-server supervisor detached
  stop --json            Stop supervised local Koed services
  restart --json         Restart supervised local Koed services
  status --json          Print machine-readable local service state
  status --startup --json Print lightweight supervisor startup state
  doctor --json          Print actionable setup/dependency diagnostics
  identity status --json Print clone-safe deployment/device identity state
  identity rotate --json Create fresh device identity and invalidate local enrollment references
  pair [status|cancel]   Connect this device using a link pasted into Koed Desktop
  personal-sync status --json             Print redacted Personal Sync status
  personal-sync --help   Show Personal Sync usage and advanced recovery help
  setup core --json      Prepare Koed core services and local credential
  setup codex [--deferred-recall | --blocking-recall] --json     Configure the supported Codex integration (deferred recall by default; blocking on Windows)
    --without-memory-guidance  Do not install the recommended global guidance
    --with-memory-guidance     Install the recommended global guidance (default)
  setup claude --json    Configure the supported Claude Code integration
  setup claude --background-recall --json    Opt in to 500 ms backgrounding for all main-Conversation MCP calls
  setup pi --json        Configure the supported Pi integration
  check <client> --json  Check one AI Client integration without mutation
  repair codex --json    Rewrite Codex integration for the active local API
  repair <client> --json Repair one AI Client integration
  remove <client> --json Remove only Koed-owned client integration state
  models status --json   Print bundled local model install state
  models install --json  Download bundled local model with SHA-256 verification
  runtime status --json  Print native bundled-local runtime install state
  runtime install --json Install native bundled-local runtime assets explicitly
  package status --json  Print standalone koed-server package install state
  package install --json Verify and install standalone koed-server package
  package activate --json Activate an installed koed-server package version
  package cleanup --json Remove inactive versions and stale cached archives
  upstream list --json   List registered upstream backend status
  upstream register --json Register or update an upstream backend
  upstream refresh --json Refresh cached upstream capabilities
  upstream policy --json  Update explicit upstream route-policy families
  upstream activate --json Select the registered upstream used for remote work
  upstream remove --json Remove an upstream backend
  upstream enroll start --json Start enrollment with --source-owner-principal-id
  upstream enroll status --json Print local upstream enrollment state
  upstream enroll cancel --json Cancel local upstream enrollment orchestration
  upstream disconnect --json Disable local upstream routes and enrollment state
  project discover --json Discover and store local Project metadata
  project list --json     List discovered local Project metadata
  project show --json     Show discovered Project metadata for a cwd
  project forget --json   Forget discovered Project metadata by local Project id
  team workspace link --json Link a local Project root to a Team Workspace id
  team workspace list --json List local Project to Team Workspace links
  team workspace show --json Show the Team Workspace link for a Project root
  team workspace remove --json Remove the Team Workspace link for a Project root

Runtime providers:
  --provider homebrew       Use Homebrew-backed runtime assets (default)
  --provider packaged       Use packaged runtime resources from the app bundle

Options:
  --json                 Emit JSON output for commands that support it
  --help, -h             Show this help

Environment:
  KOED_HOME              Directory for local Koed config, logs, and runtime state
  KOED_REPO_ROOT         Koed checkout path used by this development build
  KOED_SERVER_PACKAGE_TRUSTED_PUBLIC_KEY_PEM
                         Ed25519 public key PEM used to verify package provenance signatures
`;

# ADR 0066: Phone Gateway In The Desktop Main Process

- Status: Proposed
- Date: 2026-10-27

Related decisions: [0040 Portable Client State And Credential Custody](./0040-portable-client-state-and-credential-custody.md)
and [0045 Incremental Personal Session Checkpoints](./0045-incremental-personal-session-checkpoints.md).

## Context

The Koed phone app lets the User steer Koed on their Mac: talk to their Chief
of Staff (which runs on Claude Code, Codex or Pi on the Mac), answer AI Client
approvals and questions, run or pause Scheduled Jobs, and ask memory. The phone
must reach the Mac's Koed without any hosted relay or paid service, and Koed's
local API stays a loopback service authenticated by Desktop and device
credentials. Personal device pairing already pairs Koed installations over a
private LAN or Tailscale, but enrolls full replicas; a phone is not a replica.

## Decision

The Desktop main process hosts a **phone gateway**:

- **Off by default.** The User turns it on in Settings › Phone. It then binds
  concrete private IPv4 addresses (LAN and Tailscale, the same rule as Personal
  device pairing), never a wildcard or public address, on a fixed port
  (47917 by default).
- **Pairing by QR code.** Settings › Phone shows a ten-minute, single-use offer:
  a QR code carrying a 256-bit secret and every listening address, plus a
  6-digit code for typing by hand (five wrong attempts withdraw the offer).
  Redeeming it returns a 256-bit bearer token for that phone. Only a SHA-256
  hash of each token is kept, in the Desktop's encrypted secret store, with up
  to eight phones. Removing a phone in Settings revokes it at once.
- **A narrow phone API, not the local API.** The gateway serves its own
  versioned routes (`/koed-phone/v1`, see `apps/desktop/src/phone-gateway/contract.ts`)
  and fulfils them by calling the same owner-bound Desktop handlers the
  renderer uses (Agents, Managed Conversations, Personal Memory, Scheduled
  Jobs, Local AI Clients). The phone never holds the Desktop credential, an
  API Token, or a path into the local API, and cannot reach Team operations,
  sharing, deletion, source control merges, or settings.
- **One Chat with the Chief of Staff.** The phone's conversation with the
  Chief is an Independent Managed Conversation started on the Chief's bound AI
  Client instance, model and permission defaults, remembered in the gateway
  store. It is an ordinary Chat on the Mac too. The phone can also continue any
  other writable captured Chat.
- **Approvals stay the AI Client's.** The gateway relays a decision through
  `runtime_respond`, exactly as the Desktop does. The phone asks for Face ID
  before risky ones (permission changes; commands that push, merge, delete or
  deploy, classified by the gateway) and never allows those in bulk.
- **Live updates and push.** A Server-Sent Events stream tells an open phone
  what changed. Phones that aren't open get a push through Expo's free push
  service: a title, one line and a route in the app, never commands, file
  contents or memory.

- **Jobs proposed in a Chat are approved where the person is.** Pending
  `koed_job_create` and `koed_job_pause` Koed actions appear on the phone's
  bell; approving runs the same review, claim, apply, complete sequence as the
  HQ card, fenced by the claim. Changing a job's time uses the Scheduled Jobs
  `edit` (PATCH) the API already had.
- **Gamification is computed, not stored upstream.** Ranks, milestones and
  limited editions come from Agents, finished Scheduled Job runs and what the
  phone itself did, evaluated in the gateway and kept in the Desktop secret
  store. Nothing is added to the Koed API or database for it.

## Consequences

- No hosted relay, account, or paid service. The phone works when it can reach
  the Mac: same Wi-Fi, or Tailscale from anywhere. The Mac must be awake with
  Koed running.
- **No TLS on the LAN listener.** On Wi-Fi, other devices on the same network
  can read phone traffic, including the bearer token. Tailscale encrypts it.
  Settings › Phone says so. A follow-up could pin a self-signed certificate in
  the QR code once the phone app ships a native TLS-pinning module.
- Push notifications need the phone app built with an Expo project ID; the
  Mac sends them only to phones without a live stream.
- The gateway polls the bounded Managed Conversation list and runtime items
  while a phone is connected (every 3 s; every 15 s when only push is
  registered), the same inventory the HQ Now view reads.
- Ranks count Scheduled Job runs fully, but the Chief's conversational work
  only while the gateway watches (a phone connected or push registered).
  Counting every finished turn needs Agent attribution on Managed
  Conversations, which Koed doesn't record yet.
- Limited editions recolour Agents on the phone only.

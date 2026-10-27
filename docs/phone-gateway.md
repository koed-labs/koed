# The phone gateway (Koed phone app)

The Koed phone app talks to Koed on a Mac through the Desktop's phone gateway.
Design: [ADR 0066](adr/0066-phone-gateway-in-desktop.md). Code:
`apps/desktop/src/phone-gateway/`.

## Turning it on and pairing

1. On the Mac: **Settings › Phone › Phone access**. Koed starts listening on
   this Mac's private network addresses (Wi-Fi/LAN and Tailscale), port 47917.
2. Choose **Show pairing code**. A QR code and a 6-digit code appear, valid
   once for ten minutes.
3. In the phone app: **Pair with your Mac**, then scan the code (or type the
   address and the 6-digit code).

The phone and the Mac must reach each other: same Wi-Fi, or both on the same
Tailscale network (which also works away from home). **On Wi-Fi the traffic
isn't encrypted**; prefer Tailscale on networks you don't trust.

Paired phones are listed in Settings › Phone with when they were last seen;
**Remove** revokes one at once. Turning phone access off stops the listener;
paired phones stay paired for when it's turned back on.

## What the phone can do

| Phone                                                            | Through                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Talk to the Chief of Staff (one Chat, on the Chief's AI Client)  | Managed Conversation `start`, `inspect`, `send`; Personal Memory `personal.events.load_page` |
| See and continue other Chats                                     | `personal.projects.list`, `resume`, `send`                                                   |
| Answer approvals and questions                                   | Managed Conversation `runtime`, `runtime_respond`                                            |
| Interrupt or stop a turn                                         | `interrupt`, `stop`                                                                          |
| Scheduled Jobs: list, run now, pause, skip or retry a missed run | Scheduled Jobs handler                                                                       |
| Ask memory                                                       | `personal.ask.submit`, `personal.ask.thread.load`                                            |
| AI Clients and plan usage                                        | Local AI Clients `list`, `usage`                                                             |

It cannot share, delete, move Chats, merge, change settings, or touch Team
data.

## API

All routes are under `/koed-phone/v1` on the gateway; JSON in and out; every
route except `GET /hello` and `POST /pair` needs `Authorization: Bearer <token>`.
Types: `apps/desktop/src/phone-gateway/contract.ts`.

```
GET  /hello                                  { app, api, name, pairing }
POST /pair                                   { secret | code, deviceName, platform } -> { token, phoneId, macName }
GET  /home                                   Chief, agents, needs, working, upcoming
GET  /chief/timeline                         the Chief Chat's transcript and live text
POST /chief/messages                         { text, clientMessageId } (202; delivered in the background)
POST /chief/new                              start a fresh Chief Chat with the next message
GET  /conversations                          recent Chats
GET  /conversations/:projectId/:threadId     a Chat's transcript
POST /conversations/:projectId/:threadId/messages
GET  /executions/:executionId                a run: steps and what it waits for
POST /executions/:executionId/control        { action: interrupt | stop }
POST /needs/respond                          { executionId, itemId, executionGeneration, itemKind, decision | answers }
GET  /jobs, /jobs/:id                        Scheduled Jobs and runs
POST /jobs/:id/pause, /jobs/:id/run-now, /jobs/:id/runs/:runId/(skip|retry)
POST /ask, GET /ask/:askThreadId             Ask memory
GET  /computer                               AI Clients and plan usage
PUT  /push                                   { expoPushToken | null }
DELETE /session                              unpair this phone
GET  /events                                 Server-Sent Events: changed, notification
```

Limits: 300 KB request bodies, 240 requests a minute per phone, 10 pairing
attempts a minute per address.

## Push notifications

When a phone registers an Expo push token, the gateway sends pushes for new
approvals, questions and missed job runs, and when the Chief of Staff finishes
replying, to phones that don't have the app open. Pushes go through Expo's
push service (free); they carry a title, one line and a route in the app.

## Checks

`pnpm --filter @koed/desktop exec vitest run src/phone-gateway src/renderer/hq/settings/HqSettingsPhone.test.tsx`

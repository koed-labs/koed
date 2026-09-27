# Studio prototype port ledger

Source: `/Users/jacobo/Coding/koed-studio-prototype` (read-only).
Target: `/Users/jacobo/Coding/koed-studio-integration/apps/studio` on
`codex/studio-personal-home`.
Initial `src` file-set/content fingerprint (sorted path and SHA-256 chain):
`88c9f6e9c8f70aa0a69cca9bbb140dfc721dfa97c97969b4ef3d7c5057fbf254`.
Against the 21 September `apps/studio/prototype-baseline.json`, the source has
**43 runtime deltas**: 12 added `src`/`public` files and 31 changed files. All 43
are represented in the inventories below. Generated `out/`, `.next/`, and
design/export artifacts are not runtime source and are excluded.

The prototype is a UX source, not a backend contract. Its workspace data and
several actions are browser-local simulations. The visual and interaction
design is reused where its behavior can be represented honestly; the target's
verified API, authorization, agent, and GitHub paths remain authoritative.
All 43 runtime deltas were reviewed. "Ported in part" and "Deferred" name the
specific behaviors that still need a backend contract rather than silently
dismissing them.

## Route inventory

| Prototype source | Disposition | Status |
| --- | --- | --- |
| `app/page.tsx` | Home attention ranking, clear/restore, More from Koed, and workflow destinations use available target data; Personal and Team UX have explicitly local `/personal-preview` and `/collaboration` routes | Ported in part |
| `app/agents/page.tsx` | Managed Agents view reuses selected/detail, avatar, responsive, role-template and model UX; project assignment, private notes, and full job-event detail require managed API contracts | Ported in part |
| `app/plugins/page.tsx` | Searchable Personal, System, and Koed Skills catalogs and local preview add/remove are ported; live GitHub connection remains unchanged. A private skill catalogue entry is deliberately excluded. Skill installation and folder import require service contracts | Ported as preview |
| `app/pull-requests/page.tsx` | Source has changed since the 21 Sep import baseline (agent mentions, reviewer claim/feedback/status), despite not being part of the user's latest PR work. Target already has live agent mentions and GitHub-backed review data; keep its wired PR page. Prototype-only local review claim is not a real GitHub action | Audited/preserved |
| `app/memory-inbox/page.tsx` | Memory Inbox navigation is disabled on the live and personal preview sides. Prepared components retain the prototype's “Add to Memory Inbox” label; a direct preview route remains browser-local and unconnected | Ported as disabled preview |
| `app/settings/page.tsx` | Theme and build-detail controls use the target shell; current prototype navigation places Plugins under the Settings sidebar | Ported |
| `app/layout.tsx` | Added shared BuildViewProvider; target route shell and API wiring remain intact | Ported |
| `app/globals.css` | Theme tokens and responsive layout reconciled; light/dark/System settings verified in browser | Ported |
| `app/favicon.ico` | Same asset; no port needed | Preserved |

## Component inventory

| Prototype sources | Disposition | Status |
| --- | --- | --- |
| `ActionCard.tsx`, `useActionItems.ts`, `KoedHome.tsx` | Target Home reuses invitation styling, ranking, More from Koed, clear/restore, and verified execution/recent destinations. Team counts, invites, PR claim, Memory Inbox retry, and generated catch-up need Home API contracts | Ported in part |
| `ChannelView.tsx`, `TeamShell.tsx`, `TeamSidebar.tsx`, `CollabWorkspace.tsx`, `CollabSessionContext.tsx` | Collaborative workflows are available at `/collaboration` with browser-local state and explicit preview labeling. The channel header stays on one line; Team navigation has New channel without New project, Pull Requests or Plugins. Team For You omits Pull Requests | Ported as preview |
| `CreateChannelModal.tsx`, `NewDirectMessageModal.tsx` | Channel creation and new-DM selection use equivalent inline Team sidebar controls backed by the local workspace actions; source modals are not copied wholesale | Adapted as preview |
| `AddAgentModal.tsx`, `CreateAgentModal.tsx`, `AgentAvatarView.tsx`, `PixelkinLab.tsx` | Searchable local agent picker and managed-agent creation/details are reconciled; existing avatar engine, persistence, concurrency, templates, and model validation stay intact | Ported in part |
| `AddMemoryItemModal.tsx`, `MemoryItemIcon.tsx`, `MemoryCitationNote.tsx` | Metadata-only preview add and icon are reused. Citation display is deferred until live evidence sources exist | Ported in part |
| `ChatComposer.tsx` | AI access/model/effort controls appear in New Chat and Agent conversations. Human DMs and ordinary Channels use formatting controls; typing an `@` Agent mention in a Channel switches to AI controls and clearing it restores formatting. Existing managed wiring and text sizing remain | Ported |
| `CreateProjectModal.tsx`, `ProjectSidebar.tsx` | Home New project and Projects plus open the same modal in the personal preview. Local/collaborative selection, optional browser-local repo label, project/thread sharing, avatars, and move confirmation remain preview-only; the repo label is not a GitHub connection | Ported as preview |
| `ContextSidebar.tsx`, `GlobalNav.tsx`, `SidebarContext.tsx`, `SettingsSidebar.tsx` | Personal/Team preview routes use the rail and sidebar providers. Target StudioSidebar mirrors the latest Settings navigation: General and Plugins appear on `/settings` and `/plugins`, with Settings in the bottom rail; Plugins is absent from the primary list. The prototype `SettingsSidebar` component itself is not imported | Adapted |
| `SidePanel.tsx`, `SidePanelContext.tsx`, `BuildViewProvider.tsx` | Story/Advanced, reasons, and resizable desktop panel are retained; mobile uses a compact entry and full-height panel. Simulated preview build details are labeled, while existing live build activity remains separate | Ported |
| `SearchPalette.tsx`, `Tooltip.tsx`, `Collapsible.tsx`, `useResizableAside.ts` | SearchPalette and Tooltip are equivalent; resizable aside is used by Inbox; Home uses its own expand controls. Search selection resets with input without a render-time effect | Preserved/adapted |
| `ThemeProvider.tsx` | System preference and OS-change handling adapted to target | Ported |
| `WorkspaceProvider.tsx` | Browser-local collaboration/project state supports the preview, including the optional repo label; client privacy markers never authorize server data | Ported as preview |

## Library inventory

| Prototype sources | Disposition | Status |
| --- | --- | --- |
| `attention.ts`, `home.ts` | Verified Home snapshot now supports urgency tiers and scope-keyed clear/restore with new-activity reappearance. Prototype Team action derivation cannot be represented by current Home snapshot | Ported in part |
| `collab.ts`, `channelCollab.ts`, `workspace.ts` | Local Team model/actions are used only in the labeled preview; real Team state and memory access require server contracts | Ported as preview |
| `agentRelationship.ts`, `identity.ts` | Relationship helper is bit-identical; fallback avatar spec is retained | Ported/preserved |
| `memoryInbox.ts`, `markdown.tsx` | Inbox model is bit-identical and used only as a labeled local simulation; markdown renderer ported with safe URL handling | Ported as preview |
| `buildProgress.ts`, `buildView.ts` | Story/Advanced model is retained. The source's fabricated repo slug is excluded because it would imply a connected repository; the shared status-dot mapping remains local to its sole target consumer | Adapted |
| `theme.ts` | System theme and bootstrap adapted to target | Ported |
| `id.ts`, `pixelkin/engine.js`, `pixelkin/engine.d.ts` | Bit-identical target implementations | Preserved |

## Other source files and assets

| Prototype source | Disposition | Status |
| --- | --- | --- |
| `public/chat-wallpaper-dark.png`, `public/chat-wallpaper-light.png` | Copied bit-identically for channel background | Ported |
| `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg` | Existing scaffold assets in target; not used by Studio screens | Preserved |
| `main/main.js`, `main/preload.js` | Prototype uses Node integration, DevTools, and port 3000; retain target isolated Electron window, controlled external links, local gateway, and no preload | Preserved |
| `next.config.ts`, `package.json`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` | Prototype still has scaffold identity/scripts; retain target integration/runtime contract | Preserved |
| `README.md` | Prototype still has stock create-next-app instructions; target docs remain authoritative | Excluded |
| `Claude outputs/*`, `tokscale-export-20260923-111049.json` | Non-runtime design artifacts/export; do not import into app | Excluded |

## Preservation and validation gates

- The target's GitHub PR data, review submission, comments, diff, search/filter,
  chat checkout permissions, and repository selection remain authoritative.
- The target's managed-agent endpoints, role-template publication, model/effort
  validation, job history, and agent mention execution remain authoritative.
- Prototype fixture content must remain an explicitly marked demo. Browser-local
  "private" flags do not provide access control; live collaboration requires
  server-side audience and memory authorization.
- The Agents view does not invent per-project assignments or private notes from
  local fixture data. These need managed-agent assignment and job-note APIs,
  per-project runtime configuration, and author-attributed conversation data.
- Skills additions in the current UI are preview metadata, not AI Client
  installation. Live skill discovery, secure folder import, activation, refresh,
  and a published catalog need dedicated service contracts.
- Browser-local project, channel, direct-message, preview agent, and Inbox
  actions are not synced to Team services. The optional repository label is
  saved in the browser but does not connect to GitHub.
- Check every source row against the target, run focused tests, typecheck, lint,
  and build. Exercise desktop and narrow layouts and route navigation. Recheck
  the source tree for edits made during the port before declaring completion.

## Verification on 24 September 2026

- The source `src` fingerprint was unchanged after the port. No source files
  were edited in the prototype folder.
- Studio build and TypeScript validation passed. Studio lint passed with four
  existing warnings and no errors. The 79 gateway/unit tests and 55 focused
  component/library tests passed.
- Browser checks covered Home and its workflow destinations, Personal New Chat
  suggestions, Team channel navigation and project creation, Settings, Inbox,
  and Skills on desktop. At 390px, Personal New Chat and Team navigation had no
  horizontal overflow; the Team sheet closes on selection and Build opens in a
  full-height panel without obscuring the chat header.

# Studio responsive layouts

Studio keeps the existing desktop layout and adapts the same components to smaller viewports. These rules apply to both web and Electron content.

- Below 768px, workspace navigation opens as a drawer instead of consuming the content width. It closes after selecting a destination, with its close control, or with Escape. Resizing back to desktop restores the desktop navigation preference.
- Below 1280px, a selected Agent profile uses the content area, and Team reply threads overlay the channel. Closing them returns to the collection or channel without clearing its draft.
- Build activity uses an icon when there is insufficient room for its compact card. Expanded activity remains available on demand.
- Chat controls wrap. Agent menus are bounded by the composer width. Human chats retain formatting controls; invoking an Agent exposes execution controls.
- Forms and dialogs fit the viewport and scroll vertically. Public Square preserves the room map's readable scale with a contained horizontal scroll area; the surrounding page remains within the viewport.
- The app uses the dynamic viewport height so browser chrome changes do not leave controls below the visible page.

## Verification

Run `pnpm --filter @koed/studio test:ui` from the repository root. The responsive browser cases cover 320, 360, 390, 768, 1024 and 1440px widths, with an additional short viewport check on phones. They check Agent creation, Agent menus, Team navigation, draft preservation, reply panels and Public Square. Screenshots are stored under `apps/studio/output/playwright/`.

The synthetic browser suite verifies layout and interaction against controlled API responses. It does not simulate a native phone keyboard or certify every browser/device combination. Recheck new pages and controls at these widths when implementing the remaining tickets.

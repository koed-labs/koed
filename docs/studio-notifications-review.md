# Studio notifications review

## Approved behavior

Studio alerts its User when an Agent requires input or approval, an Agent Job fails, a human sends a direct message, or a human explicitly mentions them. Ordinary channel messages, replies without a mention, and successful Job completion do not trigger alerts.

Notifications show the event and available names. They exclude message text, Job briefs, file paths and commands. Opening an alert must recheck access to its destination. Notifications do not mark messages read, clear reminders, or grant access.

An open, foreground Studio uses the existing in-app Toast UI. Foreground web alerts are enabled by default, with a browser-local opt-out in Settings; macOS system alerts require a separate opt-in. Desktop can use macOS system notifications while Studio is in the background, after the User enables them in Settings. Closing the Studio window keeps notifications running while Koed remains in the menu bar. Quitting Koed stops them. Web notices require a running browser; delivery to a closed browser is deferred.

Preferences belong to the verified account and backend on the current device or browser. They are not synced. Studio suppresses alerts for the Conversation currently viewed. Startup and reconnect establish a silent baseline; existing unread activity is not replayed.

## Implementation and validation

The Desktop bridge accepts strict, content-free references. Native delivery resolves every reference against the current authenticated Home or Team overview; Team messages are also reread through the collaboration broker and checked for a current human sender, mention recipient, or direct-message thread. Home reads search at most two pages per source and Team overview reads at most two pages. Delivery is bounded to these recent windows; older items entering a window later remain quiet through the server-time baseline. No item is trusted solely because it appeared in renderer state.

Native opt-in is stored per hashed source/account/backend scope on this device and defaults off. On macOS, closing Studio hides its window and keeps its gateway and renderer running; a background login starts Studio hidden, with background tab throttling disabled. Native notices are shown only while Studio is hidden or unfocused. Clicking a notice revalidates its source before navigation. This does not claim packaged OS notification display has passed.

Use existing authenticated Personal Home and Team overview reads, and existing message-page reads for explicit human mentions. Use strict event references across the Desktop bridge and re-resolve them under current authority. Do not send arbitrary notification text or URLs from the renderer to Electron.

### Required review flow

1. Start signed-in Studio with existing unread activity. Verify no alert appears merely from starting or reconnecting.
2. Create fresh required Agent input, a failed Job, a direct message and an explicit human mention. Verify each supported event creates one content-free alert. Ordinary channel messages and unmentioned replies remain quiet.
3. View the destination Conversation while receiving an event. Verify its alert is suppressed.
4. Enable system notifications in Desktop Settings. Background or close the Studio window while Koed remains in the menu bar, then generate a fresh event. Verify macOS delivery; foreground Studio uses an in-app notice instead.
5. Click an alert. Verify current authorization before opening the existing destination, without sending a message or clearing its reminder.
6. Change account/backend or revoke Team access between collection, delivery and click. Verify stale events and navigation are rejected.
7. Disable system notifications, restart, and verify the device preference is retained for the verified account. Another account must not inherit it.
8. Quit Koed and verify its notification polling stops. Web Studio must not claim closed-browser delivery.

Focused automated tests cover strict privacy references, source classification, paginated source reads, revocation during message lookup, mention/direct-message classification, preference privacy, deduplication, click revalidation, window hide, and cleanup. Native OS display and click still require a final packaged Desktop check. Provider execution evidence from the combined delivery may be reused for unchanged behavior; it does not prove native notification display.

### Browser integration evidence

The maintained `apps/studio/tests/ui/notifications.e2e.ts` suite verifies silent startup, fresh approval and failed-Job alerts during a Team outage, content exclusion, rejected navigation after access changes, silent account changes and suspension recovery. It also uses the actual hosted message response shape and accepted query fields to verify a fresh human mention, quiet unmentioned replies, no old-message replay and rejected navigation after Team access is removed. All six maintained browser checks passed in the final integrated rerun (10.2 seconds), including foreground web delivery without system opt-in, opt-out persistence after reopening Studio, and rejection when Team access is revoked during the exact message read. These are deterministic browser fixtures, not native OS display evidence.

Desktop notification navigation reuses the existing Team selection and thread-opening flow. If the reply root is outside the current message page, it searches existing older-page cursors, bounded to 20 pages of 50 messages. This does not guarantee a root lookup beyond that window. The focused frontend checks cover deduplication, older-root search and structured mention preservation; Desktop typechecks and focused native authority/window checks also pass. Final packaged OS display remains an open acceptance check.

### Final internal package checkpoint

The source-aligned macOS 0.9.0 DMG/ZIP rebuilt successfully, and deep app signature/package integrity checks passed. The updated smoke harness disables all provider capture/import. Its packaged window check stopped before a renderer became available; the Mac reported a locked console session. Native startup, close-to-menu-bar notification delivery and OS click acceptance therefore remain pending an unlocked session. This result does not replace or invalidate the recorded source/unit/browser checks.

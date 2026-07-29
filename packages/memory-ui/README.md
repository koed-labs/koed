# Koed Memory UI

`@koed/memory-ui` contains runtime-neutral React presentation foundations
shared by Koed Desktop and Koed Explorer:

- stable Project/thread and Captured Session selection IDs;
- `VirtualizedTimeline` for existing Captured Session event lists;
- `ChatTimeline` and row-building helpers for grouped Team Chat Message
  timelines;
- `SecureMarkdown`, with injected external-link and clipboard adapters; and
- small semantic frames for Memory Events and Evidence Bundles that accept
  app-owned styling and content.

The package does not own fetching, authentication, cache policy, read
acknowledgement, or platform APIs. Consumers keep those responsibilities and
provide domain data, presentation callbacks, and trusted adapters.

## Chat timelines

`ChatTimeline` is built on LegendList. Every Team Chat Message and synthetic
group, day-divider, and first-unread row receives a deterministic key. The list
preserves the visible prepend anchor, serializes page loading within a thread,
and ignores stale completions after a thread reset.

Consumers own row presentation and can use the timeline ref to jump to the
first unread divider or the end. Visible message ranges and end-pinning changes
are reported so the app can implement read acknowledgement without coupling
that policy to this package.

## Markdown

`SecureMarkdown` accepts GFM but only absolute `http`, `https`, and `mailto`
links. It suppresses raw HTML and remote images and rejects input above a
configurable UTF-8 byte limit. External links render as keyboard-accessible
link controls with no browser navigation target, and code-copy actions never
read `window`, Electron, or `navigator`; apps must route `openExternal` and
`writeClipboard` adapters through their trusted platform boundary.

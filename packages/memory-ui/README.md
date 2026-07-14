# Koed Memory UI

`@koed/memory-ui` contains the small client contract shared by Koed Desktop and
Koed Explorer:

- stable Project/thread selection keys;
- stable Captured Session selection IDs; and
- the virtualized, paginated timeline container used for long Conversations.

It deliberately does not own graph fetching, authentication, Project or Team
Workspace scope, cache policy, Memory Event normalization, or row presentation.
Those remain responsibilities of the consuming client and API. Keeping this
boundary narrow lets Desktop render local Personal Memory in-process today and
add explicit Team Workspace or remote-device scope later without embedding one
client inside another or passing credentials through navigation state.

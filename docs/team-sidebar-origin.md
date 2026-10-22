# Team sidebar origin

The Team navigation snapshot carries an immutable `origin` for presentation.
`named` Teams appear as named sidebar groups. A `project_share` Team is the
small Team created by sharing a single Project outside a named group; its
linked Project appears under Shared. Project membership and visibility still
come from the authoritative Team, Workspace, and Project links. The origin
does not grant access or change any role.

The Project share flow binds `project_share` and the owning Personal Project ID
into the exact create-Team action grant. Immediately before dispatch, the local
edge resolves that Project for the authenticated User and requires it to be
active and unlinked. The Team backend stores the origin with the new Team;
renaming the Team or Project does not change sidebar placement.

Migration 0085 defaults existing Teams to `named`. Existing small Teams cannot
be classified safely from their names or number of Projects, so they remain
named until an authoritative migration can identify their creation path.

Accepting an initial invitation may establish the recipient's Team principal.
The subsequent Personal Project join may continue only under the same local
owner, backend, connection profile and remote URL. An established principal
cannot change during that operation. The resulting HQ Conversation remains
private; Team messages are not used to generate its welcome.

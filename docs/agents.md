# Agents in the local HQ

An Agent is a User-owned persona bound to one registered AI Client instance.
The Chief of Staff is the User's default Agent. Koed stores the persona and its
defaults separately from the AI Client installation and capability snapshot.
An existing Agent remains visible if its instance later becomes unavailable.
Starting a Managed Conversation still checks the current instance, model,
permission mode, authentication and capability readiness.

On first HQ use, Desktop lists the User's Agents. If no Chief exists, Desktop
resolves the effective `conversations` AI Client assignment in its main process:
the saved User setting, then `KOED_CONVERSATIONS_*` environment defaults, then
the documented code default. It reads the saved setting and enabled instance
registry through an owner-bound bootstrap endpoint using the same Desktop
credential and API origin as the Chief creation request. A cached Personal
Memory API Token cannot supply another profile's saved setting. Desktop sends
the exact resolved instance ID to an
explicit idempotent Chief creation operation. The renderer does not choose this
binding. The instance must already be registered and enabled for the same User;
an absent or disabled instance produces an unavailable state, without creating
a registry entry or selecting some other instance. A Chief already created is
returned unchanged, including its name, look and instance binding.

Agent reads and writes use the existing Personal collaboration operation families.
The API accepts an authenticated local User session or device credential. On a
local deployment, Desktop may use its existing local credential over loopback;
reads require `personal_collaboration_read`, and mutations require
`personal_collaboration_write`. API Tokens cannot authorize Agent operations.
Agent routes are unavailable outside `developer` and `local_personal` profiles.
Every database operation is scoped to the authenticated User. Agent data is not
Team Memory and Team messages never become Agent input.

The schema and HQ store prepare Agent selection for later Managed Conversation
flows. Sending a Work Item to an Agent and Pixelkin avatars are separate work.

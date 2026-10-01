# Studio recall feedback

Studio feedback is separate quality-assurance data. It does not change Personal Memory, Team-shared Memory, curated assertions, source text, retrieval or ranking.

## User flow

A reply that used Memory offers one thumbs-up or thumbs-down action for the entire answer. Koed associates its known source references automatically. The User does not rate each cited source separately. Replies marked From Memory can receive feedback even when citations are not displayed.

A thumb submits immediately. Selecting the other thumb changes the User's rating; selecting the active thumb withdraws it. Optional comments use an explicit Save action. Confirmation appears only after the backend accepts the change. Failed changes leave the previous saved state intact.

While disconnected, rating submission is disabled. Unsaved comments stay encrypted on the device where typed and restore only after the same account is verified. They do not sync as drafts to another device.

## Access and source protection

The current implementation covers Personal recalled answers. Feedback is private to its author, including when an answer uses authorized Team evidence.

The approved Team policy permits current administrators to review feedback on Team-visible answers under current answer and source access. That integration remains unresolved because Team channels have no verified recalled-answer association. Feedback never publishes a private Agent conversation because its Project is shared.

Ratings and comments can remain when sources become inaccessible or are removed. Restricted source details must not be exposed through a saved feedback copy. Existing authorized source presentation remains authoritative. Comments are encrypted at rest with Koed's existing protection.

## Delivery boundary

A dedicated quality-review dashboard and any workflow that applies corrections to Memory are deferred. The implementation notes and Ticket15 review script record the concrete contracts, migration, tests and follow-ups.

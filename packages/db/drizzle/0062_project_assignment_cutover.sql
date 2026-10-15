-- The migration journal makes this release transition run once. Block Session
-- writes until every existing Personal Session has crossed the same boundary.
LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SELECT set_config('koed.repository_assignment_cutover', '1', true);
--> statement-breakpoint
UPDATE sessions
SET repository_assignment_state = 'historical_unresolved',
    repository_automatic_identity = NULL,
    repository_override_identity = NULL,
    repository_assignment_version = repository_assignment_version + 1
WHERE visibility = 'personal';
--> statement-breakpoint
SELECT set_config('koed.repository_assignment_cutover', '', true);

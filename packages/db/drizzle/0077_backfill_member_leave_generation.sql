-- Custom SQL migration file, put your code below! --
-- A retained member_left row proves at least one completed voluntary leave.
-- Other historical rows remain unknown and fail closed for generation-bound invitations.
UPDATE "team_memberships"
SET "leave_generation" = 1
WHERE "status" = 'disabled'
  AND "disabled_reason" = 'member_left'
  AND "leave_generation" IS NULL;

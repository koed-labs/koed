CREATE TYPE "public"."action_approval_tier" AS ENUM('direct', 'native_review', 'step_up');--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" DROP CONSTRAINT "high_risk_confirmations_time_check";--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" DROP CONSTRAINT "high_risk_confirmations_lifecycle_check";--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD COLUMN "approval_tier" "action_approval_tier" DEFAULT 'step_up' NOT NULL;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD COLUMN "review_summary" jsonb;--> statement-breakpoint
UPDATE "high_risk_browser_confirmations"
   SET "state" = 'revoked',
       "revoked_at" = now(),
       "revocation_reason_code" = 'approval_tier_migration'
 WHERE "state" = 'pending';--> statement-breakpoint
UPDATE "high_risk_browser_confirmations"
   SET "review_summary" = jsonb_build_object(
     'version', 1,
     'title', 'Confirmation ended during upgrade',
     'description', 'This confirmation started before Koed adopted backend-authored approval reviews.',
     'consequence', 'No new decision can be submitted. Return to Koed and start the action again if it is still needed.',
     'confirmLabel', 'Unavailable',
     'details', jsonb_build_array()
   )
 WHERE "review_summary" is null;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_confirmations_approval_review_check" CHECK ((("high_risk_browser_confirmations"."approval_tier" = 'direct' and "high_risk_browser_confirmations"."review_summary" is null)
        or ("high_risk_browser_confirmations"."approval_tier" in ('native_review', 'step_up') and "high_risk_browser_confirmations"."review_summary" is not null)));--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_confirmations_time_check" CHECK ("high_risk_browser_confirmations"."expires_at" > "high_risk_browser_confirmations"."created_at"
        and ("high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null
          or "high_risk_browser_confirmations"."decision_freshly_authenticated_at" <= "high_risk_browser_confirmations"."decided_at"));--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_confirmations_lifecycle_check" CHECK ((
        "high_risk_browser_confirmations"."state" = 'pending'
        and "high_risk_browser_confirmations"."decision_user_session_id" is null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null
        and "high_risk_browser_confirmations"."decided_at" is null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'approved'
        and (
          ("high_risk_browser_confirmations"."approval_tier" = 'step_up'
            and "high_risk_browser_confirmations"."decision_user_session_id" is not null
            and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is not null)
          or ("high_risk_browser_confirmations"."approval_tier" in ('direct', 'native_review')
            and "high_risk_browser_confirmations"."decision_user_session_id" is null
            and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null)
        )
        and "high_risk_browser_confirmations"."decided_at" is not null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'denied'
        and (
          ("high_risk_browser_confirmations"."approval_tier" = 'step_up'
            and "high_risk_browser_confirmations"."decision_user_session_id" is not null
            and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is not null)
          or ("high_risk_browser_confirmations"."approval_tier" = 'native_review'
            and "high_risk_browser_confirmations"."decision_user_session_id" is null
            and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null)
        )
        and "high_risk_browser_confirmations"."decided_at" is not null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'expired'
        and "high_risk_browser_confirmations"."decision_user_session_id" is null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null
        and "high_risk_browser_confirmations"."decided_at" is null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'revoked'
        and "high_risk_browser_confirmations"."revoked_at" is not null
      ));

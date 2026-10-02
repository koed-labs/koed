CREATE TABLE "pull_request_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "personal_agent_identities"("id") ON DELETE RESTRICT,
  "agent_version" integer NOT NULL,
  "execution_id" uuid REFERENCES "managed_conversation_executions"("id") ON DELETE SET NULL,
  "project_id" text,
  "target_device_id" uuid NOT NULL,
  "target_deployment_id" uuid NOT NULL,
  "account_id" text NOT NULL,
  "repository_id" text NOT NULL,
  "pull_request_number" integer NOT NULL,
  "expected_base_sha" text NOT NULL,
  "expected_head_sha" text NOT NULL,
  "connection_generation" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'starting',
  "revision" integer NOT NULL DEFAULT 1,
  "draft_revision" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "encrypted_selection" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_reviews_owner_id_unique" UNIQUE ("id", "owner_user_id"),
  CONSTRAINT "pull_request_reviews_owner_idempotency_unique" UNIQUE ("owner_user_id", "idempotency_key"),
  CONSTRAINT "pull_request_reviews_agent_pr_unique" UNIQUE ("owner_user_id", "agent_id", "account_id", "repository_id", "pull_request_number"),
  CONSTRAINT "pull_request_reviews_agent_version_check" CHECK ("agent_version" > 0),
  CONSTRAINT "pull_request_reviews_sha_check" CHECK ("expected_base_sha" ~ '^[0-9a-fA-F]{40,64}$' AND "expected_head_sha" ~ '^[0-9a-fA-F]{40,64}$'),
  CONSTRAINT "pull_request_reviews_generation_check" CHECK ("connection_generation" > 0),
  CONSTRAINT "pull_request_reviews_number_check" CHECK ("pull_request_number" > 0),
  CONSTRAINT "pull_request_reviews_status_check" CHECK ("status" IN ('starting','active','stale','draft','frozen','published','uncertain','failed','cancelled')),
  CONSTRAINT "pull_request_reviews_revision_check" CHECK ("revision" > 0 AND "draft_revision" >= 0),
  CONSTRAINT "pull_request_reviews_idempotency_check" CHECK (length(trim("idempotency_key")) BETWEEN 1 AND 240 AND "request_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "pull_request_reviews_owner_updated_idx" ON "pull_request_reviews" ("owner_user_id", "updated_at" DESC, "id" DESC);
CREATE INDEX "pull_request_reviews_execution_idx" ON "pull_request_reviews" ("owner_user_id", "execution_id") WHERE "execution_id" IS NOT NULL;
CREATE INDEX "pull_request_reviews_pr_lookup_idx" ON "pull_request_reviews" ("owner_user_id", "account_id", "repository_id", "pull_request_number");
ALTER TABLE "pull_request_reviews"
  ADD COLUMN "work_mode" text NOT NULL DEFAULT 'review',
  ADD COLUMN "reviewed_base_sha" text,
  ADD COLUMN "reviewed_head_sha" text,
  ADD COLUMN "reviewed_execution_generation" integer;
ALTER TABLE "pull_request_reviews"
  ADD CONSTRAINT "pull_request_reviews_work_mode_check" CHECK ("work_mode" IN ('review','fix')),
  ADD CONSTRAINT "pull_request_reviews_reviewed_proof_check" CHECK (
    ("reviewed_base_sha" IS NULL AND "reviewed_head_sha" IS NULL AND "reviewed_execution_generation" IS NULL)
    OR ("reviewed_base_sha" ~ '^[0-9a-fA-F]{40,64}$' AND "reviewed_head_sha" ~ '^[0-9a-fA-F]{40,64}$' AND "reviewed_execution_generation" > 0)
  );

CREATE TABLE "pull_request_review_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "origin" text NOT NULL DEFAULT 'owner',
  "agent_job_id" uuid REFERENCES "personal_agent_execution_jobs"("id") ON DELETE SET NULL,
  "execution_generation" integer,
  "account_id" text NOT NULL,
  "base_sha" text NOT NULL,
  "head_sha" text NOT NULL,
  "encrypted_payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_review_drafts_review_fk" FOREIGN KEY ("review_id", "owner_user_id") REFERENCES "pull_request_reviews"("id", "owner_user_id") ON DELETE CASCADE,
  CONSTRAINT "pull_request_review_drafts_revision_unique" UNIQUE ("review_id", "revision"),
  CONSTRAINT "pull_request_review_drafts_job_unique" UNIQUE ("review_id", "agent_job_id"),
  CONSTRAINT "pull_request_review_drafts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "pull_request_review_drafts_origin_check" CHECK ("origin" IN ('agent','owner')),
  CONSTRAINT "pull_request_review_drafts_sha_check" CHECK ("base_sha" ~ '^[0-9a-fA-F]{40,64}$' AND "head_sha" ~ '^[0-9a-fA-F]{40,64}$')
);

CREATE TABLE "pull_request_review_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "draft_revision" integer NOT NULL,
  "account_id" text NOT NULL,
  "connection_generation" integer NOT NULL,
  "base_sha" text NOT NULL,
  "head_sha" text NOT NULL,
  "digest" text NOT NULL,
  "state" text NOT NULL DEFAULT 'frozen',
  "encrypted_payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_review_freezes_review_fk" FOREIGN KEY ("review_id", "owner_user_id") REFERENCES "pull_request_reviews"("id", "owner_user_id") ON DELETE CASCADE,
  CONSTRAINT "pull_request_review_freezes_draft_unique" UNIQUE ("review_id", "draft_revision"),
  CONSTRAINT "pull_request_review_freezes_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$' AND "draft_revision" > 0 AND "connection_generation" > 0),
  CONSTRAINT "pull_request_review_freezes_state_check" CHECK ("state" IN ('frozen','dispatching','published','uncertain')),
  CONSTRAINT "pull_request_review_freezes_sha_check" CHECK ("base_sha" ~ '^[0-9a-fA-F]{40,64}$' AND "head_sha" ~ '^[0-9a-fA-F]{40,64}$')
);

CREATE TABLE "pull_request_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "review_id" uuid,
  "target_device_id" uuid NOT NULL,
  "target_deployment_id" uuid NOT NULL,
  "request_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "encrypted_payload" jsonb NOT NULL,
  "encrypted_result" jsonb,
  "error_code" text,
  "revision" integer NOT NULL DEFAULT 1,
  "attempt" integer NOT NULL DEFAULT 0,
  "write_dispatched" boolean NOT NULL DEFAULT false,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "claimed_by_runner_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "pull_request_operations_review_fk" FOREIGN KEY ("review_id", "owner_user_id") REFERENCES "pull_request_reviews"("id", "owner_user_id") ON DELETE CASCADE,
  CONSTRAINT "pull_request_operations_owner_request_unique" UNIQUE ("owner_user_id", "request_id"),
  CONSTRAINT "pull_request_operations_request_check" CHECK (length(trim("request_id")) BETWEEN 1 AND 240 AND "request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pull_request_operations_kind_check" CHECK ("kind" IN ('connection_status','accounts','connect','browser_sign_in','disconnect','repositories','inbox','pull_request_details','prepare_checkout','publish_review','reconcile_review','prepare_push','push','reconcile_push')),
  CONSTRAINT "pull_request_operations_state_check" CHECK ("state" IN ('pending','claimed','completed','failed','uncertain','cancelled')),
  CONSTRAINT "pull_request_operations_revision_check" CHECK ("revision" > 0 AND "attempt" >= 0),
  CONSTRAINT "pull_request_operations_lease_check" CHECK (("state" = 'claimed' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "claimed_by_runner_id" IS NOT NULL) OR ("state" <> 'claimed' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "claimed_by_runner_id" IS NULL))
);
CREATE INDEX "pull_request_operations_claim_idx" ON "pull_request_operations" ("target_deployment_id", "target_device_id", "created_at") WHERE "state" = 'pending';
CREATE INDEX "pull_request_operations_owner_updated_idx" ON "pull_request_operations" ("owner_user_id", "updated_at" DESC, "id" DESC);

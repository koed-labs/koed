CREATE TABLE "local_work_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"job_name" text NOT NULL,
	"job_key" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"backoff_ms" integer,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"lock_token" text,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_work_queue_status_check" CHECK ("local_work_queue"."status" in ('pending', 'active', 'completed', 'failed')),
	CONSTRAINT "local_work_queue_max_attempts_check" CHECK ("local_work_queue"."max_attempts" >= 1),
	CONSTRAINT "local_work_queue_attempt_count_check" CHECK ("local_work_queue"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_work_queue_job_key_unique" ON "local_work_queue" USING btree ("queue_name","job_key") WHERE "local_work_queue"."job_key" is not null and "local_work_queue"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "local_work_queue_claim_idx" ON "local_work_queue" USING btree ("queue_name","available_at","id") WHERE "local_work_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "local_work_queue_active_lease_idx" ON "local_work_queue" USING btree ("locked_until") WHERE "local_work_queue"."status" = 'active';
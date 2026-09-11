ALTER TABLE "interviews" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "interviewer_name" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "interviewer_role" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "notes_markdown" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "review_markdown" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_markdown" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_source" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "ai_brief_markdown" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "ai_brief_json" jsonb;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "ai_brief_model" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "ai_briefed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "source_path" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interviews_position_idx" ON "interviews" USING btree ("position_id");

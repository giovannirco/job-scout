ALTER TABLE "llm_runs" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "response" text;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "prompt_chars" integer;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "response_chars" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_runs_position_idx" ON "llm_runs" USING btree ("position_id");

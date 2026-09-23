ALTER TABLE "positions" ADD COLUMN "workplace" text DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "application_questions" ADD COLUMN "required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "application_questions" ADD COLUMN "input_type" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_questions_pos_q_uidx" ON "application_questions" USING btree ("position_id","question");

CREATE TABLE "decision_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"recipe" text NOT NULL,
	"position_id" text,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb,
	"summary" jsonb,
	"error" text,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_runs" ADD CONSTRAINT "decision_runs_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "decision_runs_created_idx" ON "decision_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "decision_runs_input_idx" ON "decision_runs" USING btree ("input_hash","created_at");
--> statement-breakpoint
CREATE INDEX "decision_runs_position_idx" ON "decision_runs" USING btree ("position_id");

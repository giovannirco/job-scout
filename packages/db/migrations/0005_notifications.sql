CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"chat_id" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" text,
	"position_id" text,
	"company_id" text,
	"provider_ref" text,
	"error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notify_outbox_status_sched_idx" ON "notification_outbox" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_outbox_dedupe_uidx" ON "notification_outbox" USING btree ("dedupe_key");

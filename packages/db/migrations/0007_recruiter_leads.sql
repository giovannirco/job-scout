CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text,
	"recruiter_name" text,
	"recruiter_company" text,
	"recruiter_profile_url" text,
	"recruiter_email" text,
	"recruiter_phone" text,
	"pitched_role" text,
	"client_hint" text,
	"stated_pay" text,
	"stated_geo" text,
	"stated_contract" text,
	"open_unknowns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"next_action" text,
	"closed_reason" text,
	"dedupe_key" text,
	"position_id" text,
	"merged_into_id" text,
	"triage_json" jsonb,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interviews" ALTER COLUMN "position_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "lead_id" text;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD COLUMN "lead_id" text;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_dedupe_uidx" ON "leads" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "leads_status_updated_idx" ON "leads" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "leads_position_idx" ON "leads" USING btree ("position_id");--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interviews_lead_idx" ON "interviews" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "outreach_events_lead_idx" ON "outreach_events" USING btree ("lead_id","occurred_at");--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_position_or_lead_chk" CHECK ("interviews"."position_id" is not null or "interviews"."lead_id" is not null);
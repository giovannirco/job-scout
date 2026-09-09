CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '["agent"]'::jsonb,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"title" text,
	"body_markdown" text,
	"pdf_base64" text,
	"pdf_file_name" text,
	"model" text,
	"source" text DEFAULT 'llm',
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'human',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_deltas" (
	"id" text PRIMARY KEY NOT NULL,
	"board_source_id" text,
	"event" text NOT NULL,
	"external_identity" text,
	"title" text,
	"company" text,
	"url" text,
	"location_raw" text,
	"craft_family" text,
	"geo_class" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"board_source_id" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_count" integer DEFAULT 0,
	"match_count" integer DEFAULT 0,
	"identities" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"careers_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"source_kind" text DEFAULT 'ats' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"capability" text DEFAULT 'list_api',
	"last_scanned_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"careers_url" text,
	"industry_tags" jsonb DEFAULT '[]'::jsonb,
	"overview" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"external_identity" text,
	"board_source_id" text,
	"company" text,
	"title" text NOT NULL,
	"url" text,
	"location_raw" text,
	"craft_family" text,
	"geo_class" text,
	"lane" text DEFAULT 'filtered' NOT NULL,
	"gate_reason" text,
	"position_id" text,
	"provider" text,
	"posted_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text,
	"company_id" text,
	"kind" text NOT NULL,
	"model" text,
	"markdown" text,
	"json" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"stage" text DEFAULT 'screen' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jd_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"change_kind" text NOT NULL,
	"material" boolean DEFAULT true NOT NULL,
	"title" text,
	"location_raw" text,
	"description_text" text,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_period" text,
	"salary_raw" text,
	"tech_tags" jsonb DEFAULT '[]'::jsonb,
	"remote_class" text,
	"geo_class" text,
	"diff_summary" text,
	"field_diffs" jsonb DEFAULT '[]'::jsonb,
	"source" text DEFAULT 'scan',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb DEFAULT '{}'::jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"position_id" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_events" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text,
	"company_id" text,
	"channel" text DEFAULT 'email' NOT NULL,
	"who" text,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"linkedin_url" text,
	"email" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'triaged' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"applied_at" timestamp with time zone,
	"resume_surface" text,
	"primary_url" text,
	"ats_provider" text DEFAULT 'unknown',
	"ats_job_id" text,
	"ats_board_token" text,
	"external_identity" text,
	"craft_family" text DEFAULT 'unknown',
	"geo_class" text DEFAULT 'unknown',
	"remote_class" text DEFAULT 'unknown',
	"geo_notes" text,
	"triage_score" real,
	"triage_verdict" text,
	"triage_json" jsonb,
	"triaged_at" timestamp with time zone,
	"triage_model" text,
	"archive_reason" text,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_period" text,
	"salary_raw" text,
	"equity_notes" text,
	"employment_type" text,
	"source" text,
	"watch_enabled" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"listing_status" text DEFAULT 'open',
	"first_seen_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"next_action" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"location" text,
	"linkedin_url" text,
	"github_url" text,
	"last_title" text,
	"last_company" text,
	"cash_floor_usd" integer DEFAULT 0 NOT NULL,
	"north_star" text,
	"target_roles" jsonb DEFAULT '[]'::jsonb,
	"resume_surfaces" jsonb DEFAULT '{}'::jsonb,
	"identity_markdown" text,
	"master_resume_markdown" text,
	"master_cover_markdown" text,
	"scout_brief" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text,
	"kind" text DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"actor" text DEFAULT 'system',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text,
	"url" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"content_hash" text,
	"listing_status" text DEFAULT 'open',
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_deltas" ADD CONSTRAINT "board_deltas_board_source_id_board_sources_id_fk" FOREIGN KEY ("board_source_id") REFERENCES "public"."board_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_board_source_id_board_sources_id_fk" FOREIGN KEY ("board_source_id") REFERENCES "public"."board_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_feed" ADD CONSTRAINT "discovery_feed_board_source_id_board_sources_id_fk" FOREIGN KEY ("board_source_id") REFERENCES "public"."board_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_feed" ADD CONSTRAINT "discovery_feed_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jd_revisions" ADD CONSTRAINT "jd_revisions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_materials_position_idx" ON "application_materials" USING btree ("position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_materials_pos_kind_ver_uidx" ON "application_materials" USING btree ("position_id","kind","version");--> statement-breakpoint
CREATE INDEX "app_questions_position_idx" ON "application_questions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "board_deltas_observed_idx" ON "board_deltas" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "board_snapshots_board_observed_idx" ON "board_snapshots" USING btree ("board_source_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_sources_provider_token_uidx" ON "board_sources" USING btree ("provider","token");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_uidx" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "discovery_lane_idx" ON "discovery_feed" USING btree ("lane");--> statement-breakpoint
CREATE INDEX "discovery_observed_idx" ON "discovery_feed" USING btree ("observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_external_uidx" ON "discovery_feed" USING btree ("external_identity");--> statement-breakpoint
CREATE INDEX "evaluations_position_idx" ON "evaluations" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "evaluations_company_idx" ON "evaluations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "evaluations_kind_created_idx" ON "evaluations" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jd_revisions_pos_rev_uidx" ON "jd_revisions" USING btree ("position_id","revision");--> statement-breakpoint
CREATE INDEX "jd_revisions_position_idx" ON "jd_revisions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "jobs_status_run_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_runs_created_idx" ON "llm_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_runs_op_created_idx" ON "llm_runs" USING btree ("operation","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_slug_uidx" ON "positions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "positions_company_idx" ON "positions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "positions_external_idx" ON "positions" USING btree ("external_identity");--> statement-breakpoint
CREATE INDEX "positions_verdict_idx" ON "positions" USING btree ("triage_verdict");--> statement-breakpoint
CREATE INDEX "positions_updated_idx" ON "positions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "timeline_position_idx" ON "timeline_events" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "timeline_occurred_idx" ON "timeline_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "watches_enabled_idx" ON "watches" USING btree ("enabled");
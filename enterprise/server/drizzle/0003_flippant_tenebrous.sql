CREATE TABLE "device_usage_daily" (
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_usage_daily_device_id_user_id_date_provider_id_model_pk" PRIMARY KEY("device_id","user_id","date","provider_id","model")
);
--> statement-breakpoint
CREATE TABLE "fleet_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'direct' NOT NULL,
	"active_provider_id" text DEFAULT '' NOT NULL,
	"stack_member_ids" jsonb NOT NULL,
	"providers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "applied_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "secret_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "previous_user_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "user_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "force_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "device_usage_daily" ADD CONSTRAINT "device_usage_daily_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_daily" ADD CONSTRAINT "device_usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_usage_daily_date_idx" ON "device_usage_daily" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_profiles_one_default" ON "fleet_profiles" USING btree ("is_default") WHERE "fleet_profiles"."is_default" = true;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_previous_user_id_users_id_fk" FOREIGN KEY ("previous_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
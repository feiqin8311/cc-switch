CREATE TABLE "upstream_usage_records" (
  "origin" text NOT NULL,
  "upstream_id" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "payload" jsonb NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upstream_usage_records_origin_upstream_id_pk" PRIMARY KEY("origin", "upstream_id")
);
--> statement-breakpoint
CREATE INDEX "upstream_usage_created_at_idx" ON "upstream_usage_records" USING btree ("origin", "created_at");

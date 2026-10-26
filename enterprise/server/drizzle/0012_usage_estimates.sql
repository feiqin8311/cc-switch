-- Leave existing rows NULL: their cache writes and upstream model are unknown.
ALTER TABLE "usage_records" ADD COLUMN "cache_creation_tokens" integer;
--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "pricing_model" text;

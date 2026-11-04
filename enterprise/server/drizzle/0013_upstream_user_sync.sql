ALTER TABLE "users" ADD COLUMN "upstream_key_id" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "upstream_key_origin" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_upstream_key_identity_idx" ON "users" ("upstream_key_origin", "upstream_key_id");

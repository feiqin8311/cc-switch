ALTER TABLE "providers" ADD COLUMN "allowed_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "allowed_groups" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN IF EXISTS "allowed_roles";

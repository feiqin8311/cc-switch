ALTER TABLE "market_items" ADD COLUMN "visible_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "market_items" ADD COLUMN "visible_groups" text[] DEFAULT '{}'::text[] NOT NULL;

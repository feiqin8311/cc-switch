ALTER TABLE "users" ADD COLUMN "upstream_account_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;

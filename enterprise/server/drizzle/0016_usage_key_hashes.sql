CREATE TABLE "upstream_usage_keys" (
  "origin" text NOT NULL,
  "key_id" integer NOT NULL,
  "key_hash" text NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upstream_usage_keys_pk" PRIMARY KEY("origin", "key_id")
);

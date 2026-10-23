UPDATE "users"
SET "group_name" = '技术部&独立站&TK'
WHERE "group_name" = '技术部&独立站';
--> statement-breakpoint
UPDATE "providers"
SET "allowed_groups" = array_replace("allowed_groups", '技术部&独立站', '技术部&独立站&TK')
WHERE '技术部&独立站' = ANY("allowed_groups");
--> statement-breakpoint
UPDATE "market_items"
SET "visible_groups" = array_replace("visible_groups", '技术部&独立站', '技术部&独立站&TK')
WHERE '技术部&独立站' = ANY("visible_groups");
--> statement-breakpoint
UPDATE "settings"
SET "value" = jsonb_set("value", '{items}', (
  SELECT jsonb_agg(
    CASE WHEN item->>'department' = '技术部&独立站'
      THEN jsonb_set(item, '{department}', '"技术部&独立站&TK"'::jsonb)
      ELSE item
    END ORDER BY position
  )
  FROM jsonb_array_elements("value"->'items') WITH ORDINALITY AS entries(item, position)
))
WHERE ("key" LIKE 'usage-account-month:%' OR "key" LIKE 'demo-account-month:%')
  AND "value"->'items' @> '[{"department":"技术部&独立站"}]'::jsonb;

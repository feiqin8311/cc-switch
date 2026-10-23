UPDATE "users"
SET "group_name" = '运营部-LIBRATON'
WHERE "group_name" = 'Libraton组';
--> statement-breakpoint
UPDATE "providers"
SET "allowed_groups" = array_replace("allowed_groups", 'Libraton组', '运营部-LIBRATON')
WHERE 'Libraton组' = ANY("allowed_groups");
--> statement-breakpoint
UPDATE "market_items"
SET "visible_groups" = array_replace("visible_groups", 'Libraton组', '运营部-LIBRATON')
WHERE 'Libraton组' = ANY("visible_groups");
--> statement-breakpoint
UPDATE "settings"
SET "value" = jsonb_set("value", '{items}', (
  SELECT jsonb_agg(
    CASE WHEN item->>'department' = 'Libraton组'
      THEN jsonb_set(item, '{department}', '"运营部-LIBRATON"'::jsonb)
      ELSE item
    END ORDER BY position
  )
  FROM jsonb_array_elements("value"->'items') WITH ORDINALITY AS entries(item, position)
))
WHERE ("key" LIKE 'usage-account-month:%' OR "key" LIKE 'demo-account-month:%')
  AND "value"->'items' @> '[{"department":"Libraton组"}]'::jsonb;

import { readFileSync, writeFileSync } from "node:fs";

// Keep the enterprise estimate catalogue aligned with the desktop defaults.
// Run from the repository: node enterprise/scripts/sync-model-pricing.mjs
const source = readFileSync(
  new URL("../../src-tauri/src/database/schema.rs", import.meta.url),
  "utf8",
);
const seed = source
  .split("fn seed_model_pricing(conn: &Connection)")[1]
  ?.split("let pricing_data = [")[1]
  ?.split("];")[0];
if (!seed) throw new Error("Cannot locate desktop model pricing defaults");

const tuple =
  /\(\s*"([^"]+)"\s*,\s*"[^"]+"\s*,\s*"([\d.]+)"\s*,\s*"([\d.]+)"\s*,\s*"([\d.]+)"\s*,\s*"([\d.]+)"\s*,?\s*\)/g;
const models = Object.fromEntries(
  [...seed.matchAll(tuple)].map((match) => [
    match[1],
    match.slice(2).map(Number),
  ]),
);
if (Object.keys(models).length < 100) {
  throw new Error("Unexpectedly small model pricing catalogue");
}
const rows = Object.entries(models)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([model, rates]) =>
      `    ${JSON.stringify(model)}: ${JSON.stringify(rates)}`,
  );
writeFileSync(
  new URL("../server/src/gateway/model-pricing.json", import.meta.url),
  `${JSON.stringify(
    {
      source: "src-tauri/src/database/schema.rs::seed_model_pricing",
      unit: "USD per million tokens: input, output, cache read, cache write",
    },
    null,
    2,
  ).slice(0, -2)},\n  "models": {\n${rows.join(",\n")}\n  }\n}\n`,
);
console.log(`Synced ${rows.length} model prices from desktop defaults`);

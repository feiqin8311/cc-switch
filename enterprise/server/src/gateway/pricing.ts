import catalogue from "./model-pricing.json" with { type: "json" };

/** USD per million tokens: fresh input, output, cache read, cache write. */
type Rates = readonly [number, number, number, number];
const prices = new Map<string, Rates>(
  Object.entries(catalogue.models).map(([model, values]) => {
    const [input, output, cacheRead, cacheWrite] = values;
    if (
      values.length !== 4 ||
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      values.some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error(`Invalid model pricing: ${model}`);
    return [model, [input, output, cacheRead, cacheWrite]];
  }),
);
// The desktop defaults describe V4.1 Flash under its recommended API name.
const aliases: Record<string, string> = {
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4-1-flash": "deepseek-flash",
};

export function findModelPrice(model: string): Rates | null {
  const normalized = model.trim().toLowerCase().replaceAll("@", "-");
  const bare = normalized.split("/").at(-1)?.split(":")[0] ?? "";
  const queue = [bare];
  const seen = new Set<string>();
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const price = prices.get(candidate) ?? prices.get(aliases[candidate] ?? "");
    if (price) return price;
    // Only strip known suffixes; never price an unknown pro/max variant as base.
    queue.push(
      candidate.replace(/-(?:minimal|low|medium|high|xhigh)$/, ""),
      candidate.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, ""),
    );
    if (candidate.startsWith("claude-")) {
      queue.push(candidate.replaceAll(".", "-"));
    }
  }
  return null;
}

/** Counts are already normalized to non-overlapping categories by the query. */
export function estimateCostUsd(
  model: string,
  freshInput: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number | null {
  const rates = findModelPrice(model);
  if (!rates) return null;
  return (
    (freshInput * rates[0] +
      output * rates[1] +
      cacheRead * rates[2] +
      cacheWrite * rates[3]) /
    1_000_000
  );
}

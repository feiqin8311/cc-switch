/** A comparison candidate, after resolving the provider to an upstream key. */
export interface UsageMatchCandidate {
  id: string;
  keyId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestampMs: number;
  requestId?: string | null;
}

export interface UsageMatch {
  gatewayId: string;
  upstreamId: string;
  confidence: "request-id" | "probable";
}

/**
 * Match only mutually unique candidates. A token/time match is evidence, not
 * proof: callers must not silently discard ambiguous or unmatched requests.
 * Zero-token requests cannot be matched by tokens (e.g. client disconnects).
 */
export function matchUpstreamUsage(
  gateway: readonly UsageMatchCandidate[],
  upstream: readonly UsageMatchCandidate[],
  windowMs = 120_000,
): UsageMatch[] {
  const matchedGateway = new Set<string>();
  const matchedUpstream = new Set<string>();
  const result: UsageMatch[] = [];

  const pass = (
    confidence: UsageMatch["confidence"],
    key: (r: UsageMatchCandidate) => string | null,
    predicate: (a: UsageMatchCandidate, b: UsageMatchCandidate) => boolean,
  ) => {
    const left = gateway.filter((r) => !matchedGateway.has(r.id));
    const right = upstream.filter((r) => !matchedUpstream.has(r.id));
    const index = new Map<string, UsageMatchCandidate[]>();
    for (const r of right) {
      const value = key(r);
      if (value === null) continue;
      const bucket = index.get(value) ?? [];
      bucket.push(r);
      index.set(value, bucket);
    }
    const candidates = left.map((a) => {
      const value = key(a);
      return value === null
        ? []
        : (index.get(value) ?? []).filter((b) => predicate(a, b));
    });
    const counts = new Map<string, number>();
    for (const options of candidates)
      for (const option of options)
        counts.set(option.id, (counts.get(option.id) ?? 0) + 1);
    for (let i = 0; i < left.length; i++) {
      const a = left[i];
      const options = candidates[i];
      if (!a || !options || options.length !== 1) continue;
      const b = options[0];
      if (!b) continue;
      if (counts.get(b.id) !== 1) continue;
      matchedGateway.add(a.id);
      matchedUpstream.add(b.id);
      result.push({ gatewayId: a.id, upstreamId: b.id, confidence });
    }
  };

  pass(
    "request-id",
    (r) => r.requestId ?? null,
    (a, b) => !!a.requestId && a.requestId === b.requestId,
  );
  pass(
    "probable",
    (r) =>
      r.keyId > 0 && r.inputTokens + r.outputTokens > 0
        ? JSON.stringify([r.keyId, r.model, r.inputTokens, r.outputTokens])
        : null,
    (a, b) =>
      a.keyId > 0 &&
      a.keyId === b.keyId &&
      !(a.requestId && b.requestId && a.requestId !== b.requestId) &&
      a.model === b.model &&
      a.inputTokens + a.outputTokens > 0 &&
      a.inputTokens === b.inputTokens &&
      a.outputTokens === b.outputTokens &&
      Math.abs(a.timestampMs - b.timestampMs) <= windowMs,
  );
  return result;
}

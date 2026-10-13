import { createHash, randomBytes } from "node:crypto";

export const GATEWAY_KEY_PREFIX = "gk_";

/** "gk_" + 32 random bytes (base64url). Only the SHA-256 hash is stored. */
export function generateGatewayKey(): string {
  return `${GATEWAY_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashGatewayKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

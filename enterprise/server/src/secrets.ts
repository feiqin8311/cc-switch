import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext)

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

export function decryptSecret(key: Buffer, value: string): string {
  if (!value.startsWith("v1:")) throw new Error("unknown secret format");
  const raw = Buffer.from(value.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

/** "sk-proj-abc…wxyz" → "sk-…wxyz" */
export function secretHint(secret: string): string {
  const tail = secret.slice(-4);
  const head = secret.match(/^[a-z]{2,4}-/i)?.[0] ?? "";
  return `${head}…${tail}`;
}

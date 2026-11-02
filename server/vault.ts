import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
export function encryptionKey() {
  const text = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw Error("VAULT_UNAVAILABLE");
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw Error("VAULT_UNAVAILABLE");
  return key;
}
const envelopeSchema = z
  .object({
    v: z.literal(1),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();
export function encrypt(
  secret: unknown,
  owner: string,
  id: string,
  key = encryptionKey(),
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`nexus-v3:${owner}:${id}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secret), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function decrypt(
  envelope: unknown,
  owner: string,
  id: string,
  key = encryptionKey(),
): unknown {
  const e = envelopeSchema.parse(envelope);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(e.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`nexus-v3:${owner}:${id}`));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(e.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

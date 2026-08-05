/**
 * AES-256-GCM encryption for Plaid access_tokens at rest.
 *
 * A Plaid access_token is a bearer credential with read access to someone's
 * bank transactions and it never expires, so it does not belong in the database
 * in plaintext. GCM is used (rather than CBC) because it is authenticated: a
 * tampered-with ciphertext fails to decrypt rather than silently producing
 * garbage.
 *
 * Storage format:  "<iv>.<tag>.<ciphertext>"  — each part base64.
 * Base64's alphabet (A–Z a–z 0–9 + / =) contains no ".", so splitting on "."
 * is unambiguous.
 *
 * The key comes from ENCRYPTION_KEY: 32 raw bytes, base64-encoded.
 * Generate one with `costingly keygen`.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16; // 128-bit auth tag

function getKey(): Buffer {
  const key = Buffer.from(config.encryptionKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate a valid key with: costingly keygen`,
    );
  }
  return key;
}

/** Generate a fresh base64-encoded 32-byte key. Used by `costingly keygen`. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Encrypt a UTF-8 string. Returns "iv.tag.ciphertext" (base64 parts). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a value produced by `encrypt`.
 *
 * Throws if the payload is malformed, or if the ciphertext/tag do not
 * authenticate — which is what you want: a wrong ENCRYPTION_KEY is a loud
 * failure rather than a subtly corrupt access_token.
 */
export function decrypt(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error(
      `Malformed encrypted value: expected 3 dot-separated parts, got ${parts.length}.`,
    );
  }

  const [ivB64, tagB64, ciphertextB64] = parts;
  if (ivB64 === undefined || tagB64 === undefined || ciphertextB64 === undefined) {
    throw new Error("Malformed encrypted value: missing part.");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed encrypted value: IV must be ${IV_BYTES} bytes, got ${iv.length}.`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(
      `Malformed encrypted value: auth tag must be ${TAG_BYTES} bytes, got ${tag.length}.`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately not re-throwing the original: it adds nothing and the
    // failure mode is almost always "wrong ENCRYPTION_KEY".
    throw new Error(
      "Failed to decrypt access token: authentication failed. " +
        "This usually means ENCRYPTION_KEY does not match the key used to store it.",
    );
  }
}

/**
 * Constant-time string comparison, for checking shared secrets such as
 * CRON_SECRET without leaking their length or content through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Print a fresh ENCRYPTION_KEY.  Usage:  npm run keygen
 *
 * The key is written to stdout and the guidance to stderr, so you can pipe it:
 *   npm run keygen --silent >> .env   # (then add the ENCRYPTION_KEY= prefix)
 */

import { generateEncryptionKey } from "../src/crypto.js";

const key = generateEncryptionKey();

console.error("Add this to your .env file:\n");
console.log(`ENCRYPTION_KEY=${key}`);
console.error(
  "\nThis key encrypts your Plaid access tokens at rest (AES-256-GCM).\n" +
    "Back it up somewhere safe. If you lose it, the stored tokens cannot be\n" +
    "decrypted and you will have to re-link every bank.\n",
);

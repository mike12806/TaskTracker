import type { Env } from "./types/env.js";

/**
 * Web Push, built directly on `crypto.subtle` — no `web-push` npm dependency,
 * because that package assumes Node's `crypto` module and doesn't run on the
 * Workers runtime. Same reasoning `email.ts` applies to AWS
 * SigV4: hand-rolled Web Crypto over a Node-oriented dependency.
 *
 * Two independent pieces of crypto are involved:
 *  - VAPID (RFC 8292): an ES256 JWT that identifies this server to the push
 *    service, signed with a long-lived server keypair.
 *  - Payload encryption (RFC 8291, `aes128gcm`): a fresh ECDH exchange with
 *    the *subscriber's* keys for every message, so the push service itself
 *    never sees the notification text.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /**
   * Notification `tag`, so the app can take a reminder back off the screen
   * once its task is dealt with — see `reminderNotificationTag`. Left out of
   * the JSON entirely when absent.
   */
  tag?: string;
  /**
   * The task a reminder is about, so the service worker's Done and Snooze
   * actions know what to act on without parsing the URL.
   */
  taskId?: number;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return new Uint8Array(sig);
}

/** A single-block HKDF-Expand — every length this file needs is <= 32 bytes (one SHA-256 block). */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const block = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return block.slice(0, length);
}

/**
 * Encrypts a JSON payload per RFC 8291 (`aes128gcm`), against the subscriber's
 * `p256dh` (their ECDH public key) and `auth` secret. Returns the complete
 * request body: the aes128gcm header (salt, record size, our ephemeral
 * public key) followed by the ciphertext.
 */
async function encryptPayload(payload: PushPayload, p256dh: string, auth: string): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const uaPublicBytes = base64UrlToBytes(p256dh);
  const authSecret = base64UrlToBytes(auth);

  const asKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;
  const asPublicBytes = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer
  );

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  // workers-types mistypes the ECDH `public` field as `$public`; the runtime
  // (per the Web Crypto spec, and what workerd actually reads) wants `public`.
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asKeyPair.privateKey,
      256
    )
  );

  // First HKDF: combine the ECDH shared secret with the subscriber's auth
  // secret and both public keys into 32 bytes of key material (RFC 8291 §3.3).
  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    uaPublicBytes,
    asPublicBytes
  );
  const authPrk = await hmacSha256(authSecret, sharedSecret);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);

  // Second HKDF: a random salt plus that key material derives the actual
  // content-encryption key and nonce for this one message (RFC 8188 §2.1).
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentPrk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(contentPrk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(contentPrk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  // Single-record body: plaintext, a 0x02 delimiter (last record), no padding.
  const recordPlaintext = concatBytes(plaintext, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, recordPlaintext)
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicBytes.length]), asPublicBytes);

  return concatBytes(header, ciphertext);
}

/** Builds and ES256-signs the short-lived VAPID JWT a push service requires (RFC 8292). */
async function signVapidJwt(audience: string, subject: string, publicKey: string, privateKey: string): Promise<string> {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const claims = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: subject }))
  );
  const signingInput = `${header}.${claims}`;

  const publicBytes = base64UrlToBytes(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    // `privateKey` is already base64url — the JWK `d` field's own encoding —
    // straight from `generateVapidKeys`, so it needs no conversion here.
    d: privateKey,
    x: bytesToBase64Url(publicBytes.slice(1, 33)),
    y: bytesToBase64Url(publicBytes.slice(33, 65)),
    ext: true,
  };
  const signingKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  // ECDSA via Web Crypto already yields the raw r||s signature JWS expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(signingInput))
  );

  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

/**
 * Generates a new VAPID keypair, for one-time setup — see
 * `server/scripts/generate-vapid-keys.mjs`, which calls this from Node.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicKey = bytesToBase64Url(
    new Uint8Array((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer)
  );
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
  const privateKey = (jwk.d ?? "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { publicKey, privateKey };
}

/**
 * Sends one push message to one subscription.
 *
 * A `404`/`410` response is the push service telling us the subscription is
 * gone for good — the standard signal to stop sending to it — so that case
 * deletes the row and returns rather than throwing. Any other failure throws,
 * for the queue consumer to retry.
 */
export async function sendPushMessage(env: Env, subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.error("Push notification skipped: VAPID keys are not configured.");
    return;
  }

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;

  const [body, jwt] = await Promise.all([
    encryptPayload(payload, subscription.p256dh, subscription.auth),
    signVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY),
  ]);

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "TTL": "3600",
    },
    body,
  });

  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).run();
    return;
  }

  if (!response.ok) {
    throw new Error(`Push send failed: ${response.status} ${await response.text()}`);
  }
}

// Exposed for the encrypt/decrypt round-trip test.
export const __internal = { encryptPayload, hkdfExpand, hmacSha256, signVapidJwt, base64UrlToBytes, bytesToBase64Url };

import { describe, it, expect } from "vitest";
import { generateVapidKeys, __internal } from "../src/pushSend.js";

const { encryptPayload, hkdfExpand, hmacSha256, signVapidJwt, base64UrlToBytes, bytesToBase64Url } = __internal;

/**
 * The receiver side of RFC 8291 `aes128gcm`, reimplemented independently from
 * `encryptPayload` (rather than reusing its internals) so this test actually
 * catches a mistake in the sender's math instead of agreeing with itself.
 */
async function decryptWithKeys(
  sharedSecret: Uint8Array,
  salt: Uint8Array,
  asPublicBytes: Uint8Array,
  ciphertext: Uint8Array,
  authSecret: Uint8Array,
  uaPublicBytes: Uint8Array
): Promise<string> {
  const keyInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...uaPublicBytes,
    ...asPublicBytes,
  ]);
  const authPrk = await hmacSha256(authSecret, sharedSecret);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);
  const contentPrk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(contentPrk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(contentPrk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext));

  // Strip the single-record 0x02 delimiter appended by encryptPayload.
  expect(plaintext[plaintext.length - 1]).toBe(2);
  return new TextDecoder().decode(plaintext.slice(0, -1));
}

describe("push payload encryption (aes128gcm)", () => {
  it("round-trips a payload back to the original plaintext", async () => {
    const uaKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const uaPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeyPair.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));

    const payload = { title: "Baby Tracker", body: "No diaper change logged in over 3 hours.", url: "/" };
    const body = await encryptPayload(
      payload,
      bytesToBase64Url(uaPublicBytes),
      bytesToBase64Url(authSecret)
    );

    const salt = body.slice(0, 16);
    const keyIdLength = body[20];
    const asPublicBytes = body.slice(21, 21 + keyIdLength);
    const ciphertext = body.slice(21 + keyIdLength);

    const asPublicKey = await crypto.subtle.importKey(
      "raw",
      asPublicBytes,
      { name: "ECDH", namedCurve: "P-256" },
      [],
      []
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: asPublicKey }, uaKeyPair.privateKey, 256)
    );

    const plaintextJson = await decryptWithKeys(sharedSecret, salt, asPublicBytes, ciphertext, authSecret, uaPublicBytes);
    expect(JSON.parse(plaintextJson)).toEqual(payload);
  });

  it("uses a fresh salt and ephemeral key for every message", async () => {
    const uaKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const uaPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeyPair.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const payload = { title: "t", body: "b", url: "/" };

    const first = await encryptPayload(payload, bytesToBase64Url(uaPublicBytes), bytesToBase64Url(authSecret));
    const second = await encryptPayload(payload, bytesToBase64Url(uaPublicBytes), bytesToBase64Url(authSecret));

    expect(first).not.toEqual(second);
  });
});

describe("VAPID JWT", () => {
  it("produces a three-segment JWT with the right claims", async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    const jwt = await signVapidJwt("https://push.example.com", "mailto:test@example.com", publicKey, privateKey);

    const [headerB64, claimsB64, signatureB64] = jwt.split(".");
    expect(headerB64 && claimsB64 && signatureB64).toBeTruthy();

    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(claimsB64)));
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe("mailto:test@example.com");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The signature must actually verify against the public key it was
    // generated from — the part a structural check alone wouldn't catch.
    const publicBytes = base64UrlToBytes(publicKey);
    const verifyKey = await crypto.subtle.importKey(
      "raw",
      publicBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${claimsB64}`)
    );
    expect(valid).toBe(true);
  });
});

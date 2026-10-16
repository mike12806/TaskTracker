#!/usr/bin/env node
// Prints a fresh VAPID keypair for Web Push (both halves — see pushSend.ts).
//
//   node scripts/generate-vapid-keys.mjs
//
// Normally you don't need to run this yourself: the deploy workflow
// (.github/workflows/deploy-server.yml) calls it automatically the first
// time it deploys and sets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY as Worker
// secrets, then never runs it again — see the "Set up VAPID keys" step for
// why. This script is here for that step, and as a manual escape hatch.

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const privateKey = jwk.d.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateKey);

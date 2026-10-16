import type { Env } from "./types/env.js";

/**
 * AWS SES v2 over hand-rolled SigV4 — no AWS SDK, which assumes Node and
 * would be most of the bundle. Lifted from BabyTracker's daily summary.
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Whether every SES secret the sender needs is present. */
export function emailConfigured(env: Env): boolean {
  return Boolean(env.AWS_SES_REGION && env.AWS_SES_ACCESS_KEY && env.AWS_SES_SECRET_KEY && env.REPORT_FROM_EMAIL);
}

async function hmacSha256(key: CryptoKey, data: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

async function importKey(raw: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function signingKey(secretKey: string, date: string, region: string, service: string): Promise<CryptoKey> {
  const kDate = await hmacSha256(await importKey(new TextEncoder().encode(`AWS4${secretKey}`)), date);
  const kRegion = await hmacSha256(await importKey(new Uint8Array(kDate)), region);
  const kService = await hmacSha256(await importKey(new Uint8Array(kRegion)), service);
  const kSigning = await hmacSha256(await importKey(new Uint8Array(kService)), "aws4_request");
  return importKey(new Uint8Array(kSigning));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return toHex(buf);
}

export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const region = env.AWS_SES_REGION ?? (() => { throw new Error("AWS_SES_REGION is not set") })();
  const accessKey = env.AWS_SES_ACCESS_KEY ?? (() => { throw new Error("AWS_SES_ACCESS_KEY is not set") })();
  const secretKey = env.AWS_SES_SECRET_KEY ?? (() => { throw new Error("AWS_SES_SECRET_KEY is not set") })();
  const fromEmail = env.REPORT_FROM_EMAIL ?? (() => { throw new Error("REPORT_FROM_EMAIL is not set") })();

  const service = "ses";
  const host = `email.${region}.amazonaws.com`;
  const url = `https://${host}/v2/email/outbound-emails`;

  const payload = JSON.stringify({
    FromEmailAddress: fromEmail,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: html, Charset: "UTF-8" } },
      },
    },
  });

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders =
    `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [
    "POST",
    "/v2/email/outbound-emails",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const key = await signingKey(secretKey, dateStamp, region, service);
  const signature = toHex(await hmacSha256(key, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      Authorization: authHeader,
    },
    body: payload,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SES error ${response.status}: ${body}`);
  }
}


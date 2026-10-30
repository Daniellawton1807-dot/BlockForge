const COOKIE_NAME = "homebase_media";
const COOKIE_PATH = "/api";
const SESSION_SECONDS = 12 * 60 * 60;
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

export function loginConfigured(env) {
  return Boolean(
    String(env.HOMEBASE_DOWNLOADS_USERNAME || "") &&
    String(env.HOMEBASE_DOWNLOADS_PASSWORD || "") &&
    new TextEncoder().encode(String(env.HOMEBASE_DOWNLOADS_SESSION_SECRET || "")).length >= 32
  );
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token encoding.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function secretMatches(input, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(input)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = encoder.encode(input).length ^ encoder.encode(expected).length;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export function validRequestOrigin(request) {
  try {
    return request.headers.get("origin") === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function signedPayload(payload, secret) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = encodeBase64Url(bytes);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return body + "." + encodeBase64Url(new Uint8Array(signature));
}

export async function sessionCookie(env, remember) {
  const maxAge = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  const token = await signedPayload({ exp: Math.floor(Date.now() / 1000) + maxAge }, String(env.HOMEBASE_DOWNLOADS_SESSION_SECRET));
  const persistence = remember ? "; Max-Age=" + maxAge : "";
  return COOKIE_NAME + "=" + token + "; Path=" + COOKIE_PATH + persistence + "; HttpOnly; Secure; SameSite=Strict";
}

export function clearSessionCookie() {
  return COOKIE_NAME + "=; Path=" + COOKIE_PATH + "; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function sessionToken(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const entry = part.trim();
    if (entry.startsWith(COOKIE_NAME + "=")) return entry.slice(COOKIE_NAME.length + 1);
  }
  return "";
}

export async function validSession(request, env) {
  if (!loginConfigured(env)) return false;
  const token = sessionToken(request);
  if (!token || token.length > 1024) return false;

  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return false;
    const secret = String(env.HOMEBASE_DOWNLOADS_SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signature),
      new TextEncoder().encode(body)
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
    const now = Math.floor(Date.now() / 1000);
    return !payload.scope && Number.isSafeInteger(payload.exp) && payload.exp > now && payload.exp <= now + REMEMBER_SECONDS + 60;
  } catch {
    return false;
  }
}

// The request page for Mum (/mum/): its own cookie, scoped to /api/mum and good for nothing else.
// Daniel signs in once on her phone; it lasts about a year and renews itself while she uses it.
const MUM_COOKIE = "homebase_mum";
const MUM_SECONDS = 395 * 24 * 60 * 60;   // browsers cap cookies at 400 days
export async function mumCookie(env) {
  const token = await signedPayload({ exp: Math.floor(Date.now() / 1000) + MUM_SECONDS, scope: "mum" }, String(env.HOMEBASE_DOWNLOADS_SESSION_SECRET));
  return MUM_COOKIE + "=" + token + "; Path=/api/mum; Max-Age=" + MUM_SECONDS + "; HttpOnly; Secure; SameSite=Strict";
}
// returns null (not signed in) or { renew } when the cookie is past its first month and should be re-issued
export async function mumSession(request, env) {
  if (!loginConfigured(env)) return null;
  const entry = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(MUM_COOKIE + "="));
  const token = entry ? entry.slice(MUM_COOKIE.length + 1) : "";
  if (!token || token.length > 1024) return null;
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(String(env.HOMEBASE_DOWNLOADS_SESSION_SECRET)), decodeBase64Url(signature), new TextEncoder().encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.scope !== "mum" || !Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp > now + MUM_SECONDS + 60) return null;
    return { renew: payload.exp - now < MUM_SECONDS - 30 * 24 * 60 * 60 };
  } catch {
    return null;
  }
}

export async function readJsonBody(request, limit = 4096) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}


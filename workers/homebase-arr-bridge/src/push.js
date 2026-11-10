// Web Push for Homebase (RFC 8030/8291/8292), with nothing but WebCrypto.
// Subscriptions and their per-type preferences live in the Autopilot KV. Only reachable through the
// private ARR_BRIDGE binding (x-homebase-service: push). Secret: VAPID_PRIVATE_JWK (EC P-256 JWK).
const SUBS_KEY = "push:subs";
const MAX_SUBS = 20;
const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function subs(env) { try { return JSON.parse(await env.AUTOPILOT.get(SUBS_KEY) || "[]"); } catch { return []; } }
async function saveSubs(env, list) { await env.AUTOPILOT.put(SUBS_KEY, JSON.stringify(list.slice(-MAX_SUBS))); }
function publicKey(env) { const jwk = JSON.parse(env.VAPID_PRIVATE_JWK); return b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))); }

async function vapidHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "https://dashboard.danielvault.uk" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey(env)}`;
}

// aes128gcm content encoding (RFC 8291)
async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const hkdf = async (ikm, salt, info, bits) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info },
    await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bits));
  const ikm = await hkdf(ecdh, auth, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function sendOne(env, sub, message) {
  const body = await encrypt(sub, JSON.stringify(message));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: message.urgent ? "high" : "normal",
    ...(message.tag ? { topic: String(message.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
    authorization: await vapidHeader(env, sub.endpoint)
  } });
  return r.status;
}

export async function push(request, env, path) {
  if (!env.AUTOPILOT) return json({ error: "Storage is not bound." }, 503);
  if (!env.VAPID_PRIVATE_JWK) return json({ code: "push_setup_required", error: "Notifications aren't set up on the bridge yet." }, 503);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const list = await subs(env);

  if (path === "push/info") return json({ publicKey: publicKey(env), devices: list.map(s => ({ id: s.id, name: s.name, prefs: s.prefs, added: s.added })) });

  if (path === "push/subscribe") {
    const s = body.subscription;
    if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json({ error: "That subscription looks wrong." }, 400);
    const id = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s.endpoint)))).slice(0, 16);
    const kept = list.filter(x => x.id !== id);
    kept.push({ id, endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, name: String(body.name || "This device").slice(0, 60), prefs: body.prefs || {}, added: new Date().toISOString() });
    await saveSubs(env, kept);
    return json({ ok: true, id });
  }
  if (path === "push/prefs") {
    const s = list.find(x => x.id === body.id); if (!s) return json({ error: "That device isn't signed up for notifications." }, 404);
    s.prefs = { ...(s.prefs || {}), ...(body.prefs || {}) }; await saveSubs(env, list);
    return json({ ok: true, prefs: s.prefs });
  }
  if (path === "push/unsubscribe") { await saveSubs(env, list.filter(x => x.id !== body.id)); return json({ ok: true }); }

  if (path === "push/send") {
    // {type, title, body, url, tag, only?: deviceId}
    const message = { title: String(body.title || "Homebase").slice(0, 120), body: String(body.body || "").slice(0, 400), url: String(body.url || "/").slice(0, 300), tag: body.tag ? String(body.tag).slice(0, 64) : undefined, type: String(body.type || ""), urgent: !!body.urgent };
    const targets = list.filter(s => (body.only ? s.id === body.only : true) && (body.only || s.prefs?.[message.type] !== false));
    let sent = 0; const gone = new Set();
    await Promise.all(targets.map(async s => {
      try { const status = await sendOne(env, s, message); if (status === 404 || status === 410) gone.add(s.id); else if (status < 300) sent++; else console.log("push", status, s.name); }
      catch (error) { console.log("push failed", s.name, error.message); }
    }));
    if (gone.size) await saveSubs(env, list.filter(s => !gone.has(s.id)));
    return json({ ok: true, sent, removed: gone.size });
  }
  return json({ error: "Unknown push operation." }, 400);
}

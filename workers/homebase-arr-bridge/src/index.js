import { push } from "./push.js";
const SERVICES = Object.freeze({
  "sonarr-daniel": { binding: "VPC_SONARR_DANIEL", port: 8989, kind: "arr" },
  "sonarr-mum": { binding: "VPC_SONARR_MUM", port: 8990, kind: "arr" },
  "sonarr-extra": { binding: "VPC_SONARR_EXTRA", port: 8991, kind: "arr" },
  "radarr": { binding: "VPC_RADARR", port: 7878, kind: "arr" },
  // tvbot: the TV remote (Fire TVs over adb, the Apple TV over AirPlay) on the server
  "tvbot": { binding: "VPC_TVBOT", port: 8765, kind: "tvbot" }
});

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_PATHS = Object.freeze({
  arr: new RegExp("^api/v3/[A-Za-z0-9_./?=&%:+-]+$"),
  // tvbot's remote endpoints, the plain-English command endpoint and its poster proxy
  tvbot: new RegExp("^(api/(status|foryou|locate|playhere|key|type|seek|watchdata|sessions|feedback|discover|mumfilms|sharefilm|minecraft)|cmd|img/[A-Za-z0-9]{1,64})(\\?[A-Za-z0-9_.=&%:+-]*)?$")
});
const AUTH_HEADERS = Object.freeze({ arr: "x-api-key", tvbot: "x-tv-token" });
const MAX_BODY_BYTES = 1024 * 1024;

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}

// Autopilot: the Worker keeps its settings and log in KV and wakes Homebase on a schedule.
// This Worker has no public route (workers_dev = false), so only the Pages service binding reaches fetch().
const AUTOPILOT_STATE_KEY = "state";
async function autopilot(request, env, path) {
  if (!env.AUTOPILOT) return json({ error: "Autopilot storage is not bound." }, 503);
  if (path === "state" && request.method === "GET") {
    return new Response(await env.AUTOPILOT.get(AUTOPILOT_STATE_KEY) || "{}", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  if (path === "state" && request.method === "PUT") {
    const text = await request.text();
    if (text.length > 512 * 1024) return json({ error: "Autopilot state is too large." }, 413);
    try { JSON.parse(text); } catch { return json({ error: "Autopilot state must be JSON." }, 400); }
    await env.AUTOPILOT.put(AUTOPILOT_STATE_KEY, text);
    return json({ ok: true }, 200);
  }
  if (path === "verify" && request.method === "POST") {
    // Homebase asks whether a scheduled run's token is the one this Worker sent
    const given = new TextEncoder().encode(request.headers.get("x-autopilot-token") || "");
    const want = new TextEncoder().encode(String(env.AUTOPILOT_TOKEN || ""));
    let same = want.length > 0 && given.length === want.length;
    for (let i = 0; i < want.length; i++) same = same && given[i] === want[i];
    return json({ ok: same }, same ? 200 : 403);
  }
  return json({ error: "That autopilot operation is not supported." }, 400);
}

// Jarvis: the Pages Function has already checked the Homebase sign-in. Only this Worker holds JARVIS_TOKEN.
const JARVIS_PATHS = new RegExp("^(state|events|today|brain|settings|control|pin|chat|confirm|stt|vision|tts|tts/[a-f0-9]{40}|img/[A-Za-z0-9]{1,64})$");
async function jarvis(request, env, path) {
  const method = request.method.toUpperCase();
  if (!["GET", "POST"].includes(method)) return json({ error: "Method not allowed." }, 405);
  if (!JARVIS_PATHS.test(path)) return json({ error: "Not available." }, 404);
  if (!env.JARVIS_TOKEN || !env.VPC_JARVIS) return json({ error: "Jarvis is not set up on the bridge." }, 503);
  const body = method === "POST" ? await request.arrayBuffer() : undefined;
  const bodyLimit = path === "stt" ? 1048576 : path === "vision" ? 786432 : 16384;
  if (body && body.byteLength > bodyLimit) return json({ error: "Request body is too large." }, 413);
  const headers = new Headers({
    "x-jarvis-token": env.JARVIS_TOKEN,
    "x-jarvis-session": request.headers.get("x-jarvis-session") || "",
    "accept": request.headers.get("accept") || "application/json"
  });
  if (body) headers.set("content-type", path === "vision" ? "image/jpeg" : request.headers.get("content-type") || "application/json");
  if (path === "vision") {
    const question = request.headers.get("x-jarvis-question");
    const model = request.headers.get("x-jarvis-model");
    if (question) headers.set("x-jarvis-question", question.slice(0, 1000));
    if (model && /^(haiku|sonnet|opus)$/.test(model)) headers.set("x-jarvis-model", model);
  }
  if (request.headers.get("range")) headers.set("range", request.headers.get("range"));  // Safari's audio player
  let upstream;
  try {
    upstream = await env.VPC_JARVIS.fetch(new Request("http://192.168.8.150:8770/api/" + path, { method, headers, body }));
  } catch {
    return json({ error: "Jarvis is unavailable." }, 503);
  }
  const out = new Headers({ "cache-control": upstream.headers.get("cache-control") || "no-store" });
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Pitwall Web (F1 multi-viewer, ~/f1/web on the server). The Pages Function has already checked the Homebase sign-in.
// Only this Worker holds PITWALL_TOKEN. Streams the live-timing feed and the device bus (server-sent events).
const PITWALL_PATH = /^[A-Za-z0-9._~\/-]{0,300}$/;
async function pitwall(request, env, url) {
  const method = request.method.toUpperCase(), path = url.pathname.replace(/^\/+/, "");
  if (!["GET", "POST"].includes(method)) return json({ error: "Method not allowed." }, 405);
  if (!PITWALL_PATH.test(path) || path.includes("..")) return json({ error: "Not available." }, 404);
  if (!env.PITWALL_TOKEN || !env.VPC_PITWALL) return json({ error: "Pitwall is not set up on the bridge." }, 503);
  const body = method === "POST" ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > 600000) return json({ error: "Request body is too large." }, 413);
  const headers = new Headers({ "x-pitwall-token": env.PITWALL_TOKEN, "accept": request.headers.get("accept") || "*/*" });
  for (const name of ["content-type", "x-poll"]) { const v = request.headers.get(name); if (v) headers.set(name, v); }
  let upstream;
  try {
    upstream = await env.VPC_PITWALL.fetch(new Request("http://192.168.8.150:8774/" + path + url.search, { method, headers, body }));
  } catch {
    return json({ error: "Pitwall is unavailable." }, 503);
  }
  const out = new Headers({ "cache-control": upstream.headers.get("cache-control") || "no-store" });
  for (const name of ["content-type", "content-length", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Pitwall "session starting" notifications: ask the Pitwall server what is due (it marks them sent), push them to Homebase's phones.
async function pitwallNotify(env) {
  if (!env.PITWALL_TOKEN || !env.VPC_PITWALL) return;
  try {
    const r = await env.VPC_PITWALL.fetch(new Request("http://192.168.8.150:8774/notify/due", { headers: { "x-pitwall-token": env.PITWALL_TOKEN } }));
    if (!r.ok) { console.log("pitwall notify: HTTP " + r.status); return; }
    for (const m of ((await r.json()).due || []).slice(0, 3))
      await push(new Request("https://bridge/push/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }), env, "push/send");
  } catch (error) { console.log("pitwall notify failed: " + error.message); }
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") { ctx.waitUntil(pitwallNotify(env)); return; }
    if (!env.AUTOPILOT_TOKEN) return;
    const base = String(env.HOMEBASE_URL || "https://dashboard.danielvault.uk").replace(/\/+$/, "");
    ctx.waitUntil(fetch(base + "/api/autopilot/run", {
      method: "POST",
      headers: { "x-autopilot-token": env.AUTOPILOT_TOKEN, "content-type": "application/json" },
      body: "{}"
    }).then(async r => { if (!r.ok) console.log("autopilot run: HTTP " + r.status + " " + (await r.text()).slice(0, 300)); })
      .catch(error => console.log("autopilot run failed: " + error.message)));
  },

  async fetch(request, env) {
    const method = request.method.toUpperCase();
    if (request.headers.get("x-homebase-service") === "push") {
      return push(request, env, new URL(request.url).pathname.replace(/^\/+/, ""));
    }
    if (request.headers.get("x-homebase-service") === "jarvis") {
      return jarvis(request, env, new URL(request.url).pathname.replace(/^\/+/, ""));
    }
    if (request.headers.get("x-homebase-service") === "pitwall") {
      return pitwall(request, env, new URL(request.url));
    }
    if (request.headers.get("x-homebase-service") === "autopilot") {
      return autopilot(request, env, new URL(request.url).pathname.replace(/^\/+/, ""));
    }
    if (!ALLOWED_METHODS.has(method)) return json({ error: "Method not allowed." }, 405, { allow: [...ALLOWED_METHODS].join(", ") });

    const serviceKey = request.headers.get("x-homebase-service") || "";
    const service = SERVICES[serviceKey];
    if (!service) return json({ error: "Unknown media service." }, 404);
    if (service.kind === "tvbot" && !["GET", "POST"].includes(method)) return json({ error: "Method not allowed." }, 405);

    const url = new URL(request.url);
    let path = url.pathname;
    while (path.startsWith("/")) path = path.slice(1);
    const pathAndQuery = path + url.search;
    if (!SAFE_PATHS[service.kind].test(pathAndQuery) || pathAndQuery.includes("..") || /%2e/i.test(pathAndQuery)) {
      return json({ error: "That media operation is not supported." }, 400);
    }

    const authHeader = AUTH_HEADERS[service.kind];
    const secret = request.headers.get(authHeader) || "";
    if (!secret || secret.length > 512) return json({ error: "API key is missing." }, 401);

    const binding = env[service.binding];
    if (!binding || typeof binding.fetch !== "function") return json({ error: "Private service binding is unavailable." }, 503);

    let body;
    if (method !== "GET") {
      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
      try {
        body = await request.arrayBuffer();
      } catch {
        return json({ error: "Request body could not be read." }, 400);
      }
      if (body.byteLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
    }

    const headers = new Headers({ [authHeader]: secret, "accept": request.headers.get("accept") || "application/json" });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    let upstream;
    try {
      const upstreamRequest = new Request("http://192.168.8.150:" + service.port + "/" + pathAndQuery, {
        method,
        headers,
        body
      });
      upstream = await binding.fetch(upstreamRequest);
    } catch {
      return json({ error: "Private media service is unavailable." }, 503);
    }

    const responseHeaders = new Headers({ "cache-control": "no-store" });
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);
    if (service.kind === "tvbot" && path.startsWith("img/")) responseHeaders.set("cache-control", "private, max-age=86400");
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  }
};

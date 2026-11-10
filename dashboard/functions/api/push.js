import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../_utils/downloads-auth.js";

// Notifications: sign a device up, choose which kinds it gets, send it a test. The bridge Worker keeps
// the subscriptions and does the sending (see workers/homebase-arr-bridge/src/push.js).
export const PUSH_TYPES = {
  ready: "Something you requested is ready to watch",
  requests: "Mum requested a show or film",
  attention: "A download needs you",
  disk: "The media drive is nearly full",
  minecraft: "The Minecraft server stopped",
  f1: "An F1 session starts in 10 minutes (Pitwall)"
};

export async function bridgePush(env, path, body) {
  const bridge = env.ARR_BRIDGE;
  if (!bridge || typeof bridge.fetch !== "function") throw new Error("Private bridge binding ARR_BRIDGE is not configured.");
  const r = await bridge.fetch(new Request("https://homebase-arr-bridge/" + path, {
    method: body ? "POST" : "GET", headers: { "x-homebase-service": "push", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined
  }));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "The bridge returned HTTP " + r.status + "."), { status: r.status, code: data.code });
  return data;
}

export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (request.method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to manage notifications." }, 401);
  try {
    if (request.method === "GET") return json({ ...(await bridgePush(env, "push/info")), types: PUSH_TYPES });
    let body;
    try { body = await readJsonBody(request, 8192); } catch { return json({ code: "invalid_request", error: "Could not read the request." }, 400); }
    const prefs = {};
    for (const key of Object.keys(PUSH_TYPES)) if (typeof body?.prefs?.[key] === "boolean") prefs[key] = body.prefs[key];
    if (body?.action === "subscribe") return json(await bridgePush(env, "push/subscribe", { subscription: body.subscription, name: String(body.name || "").slice(0, 60), prefs }));
    if (body?.action === "prefs") return json(await bridgePush(env, "push/prefs", { id: String(body.id || ""), prefs }));
    if (body?.action === "unsubscribe") return json(await bridgePush(env, "push/unsubscribe", { id: String(body.id || "") }));
    if (body?.action === "test") return json(await bridgePush(env, "push/send", { only: String(body.id || ""), type: "test", title: "Homebase", body: "Notifications are working on this device.", url: "/", tag: "test" }));
    return json({ code: "invalid_request", error: "Unknown action." }, 400);
  } catch (error) {
    return json({ code: error.code || "push_failed", error: error.message }, error.status === 503 ? 503 : 502);
  }
}

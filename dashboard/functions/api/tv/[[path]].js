import { json, loginConfigured, mcSession, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

// The TV remote, through the private bridge to tvbot on the server. The bot token stays in
// the protected TVBOT_TOKEN Pages secret; the browser only ever sees this same-origin route.
const ARR_BRIDGE_BINDING = "ARR_BRIDGE";
const ROUTES = {
  GET: new Set(["api/status", "api/foryou", "api/locate", "api/minecraft", "api/minecraft/mods", "api/minecraft/mod", "api/minecraft/modzip", "api/sessions", "api/feedback", "api/librarycheck", "api/library", "api/discover", "img"]),
  POST: new Set(["api/key", "api/type", "api/seek", "api/playhere", "api/minecraft", "api/feedback", "cmd"])
};

const MINECRAFT_ONLY = {
  GET: new Set(["api/minecraft", "api/minecraft/mods", "api/minecraft/mod", "api/minecraft/modzip"]),
  POST: new Set(["api/minecraft"])
};

export async function onRequest({ request, env, params }) {
  const method = request.method.toUpperCase();
  if (!ROUTES[method]) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  const segments = Array.isArray(params.path) ? params.path : [String(params.path || "")];
  const path = segments.join("/");
  const route = path.startsWith("img/") ? "img" : path;
  // Daniel's full session opens everything here; a Minecraft-only sign-in (a friend) opens just the Minecraft page's routes
  if (!await validSession(request, env) && !(MINECRAFT_ONLY[method]?.has(route) && await mcSession(request, env))) {
    return json({ code: "login_required", error: "Sign in to use the remote." }, 401);
  }
  if (!ROUTES[method].has(route) || (route === "img" && !/^img\/[A-Za-z0-9]{1,64}$/.test(path))) {
    return json({ code: "not_found", error: "That remote action is not available." }, 404);
  }

  const token = String(env.TVBOT_TOKEN || "").trim();
  const bridge = env[ARR_BRIDGE_BINDING];
  if (!token) return json({ code: "tv_setup_required", error: "The TVBOT_TOKEN secret is not configured in Cloudflare Pages." }, 503);
  if (!bridge || typeof bridge.fetch !== "function") return json({ code: "binding_missing", error: "Private bridge binding " + ARR_BRIDGE_BINDING + " is not configured." }, 503);

  let body;
  if (method === "POST") {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
    try { body = JSON.stringify(await readJsonBody(request, 4096)); }
    catch { return json({ code: "invalid_request", error: "Could not read the remote action." }, 400); }
  }

  const query = new URL(request.url).search;
  // Minecraft mod files (jar or zip, up to a few hundred MB) are streamed straight through, never read here
  const fileRoute = route === "api/minecraft/mod" || route === "api/minecraft/modzip";
  if (fileRoute && !/^\?(id=[a-f0-9]{12}|ids=[a-f0-9]{12}(\.[a-f0-9]{12}){0,499}|all=1)$/.test(query)) return json({ code: "invalid_request", error: "Pick a mod to download." }, 400);
  let response;
  try {
    response = await bridge.fetch(new Request("https://homebase-arr-bridge/" + path + query, {
      method,
      headers: {
        "x-homebase-service": "tvbot",
        "x-tv-token": token,
        "accept": route === "img" ? "image/*" : fileRoute ? "*/*" : "application/json",
        ...(body ? { "content-type": "application/json" } : {})
      },
      body
    }));
  } catch {
    return json({ code: "tv_unavailable", error: "The TV remote is not reachable from Homebase right now." }, 502);
  }
  if (response.status === 401) return json({ code: "tv_auth_failed", error: "tvbot rejected Homebase's token. Check the TVBOT_TOKEN secret." }, 502);

  const headers = new Headers({ "cache-control": route === "img" ? "private, max-age=86400" : "no-store", "x-content-type-options": "nosniff" });
  if (fileRoute && response.ok && /^application\/(java-archive|zip)$/i.test(response.headers.get("content-type") || "")) {
    headers.set("content-type", response.headers.get("content-type"));
    for (const h of ["content-disposition", "content-length"]) { const v = response.headers.get(h); if (v) headers.set(h, v); }
    return new Response(response.body, { status: 200, headers });
  }
  const type = response.headers.get("content-type") || "";
  const bodyPreview = route === "img" ? "" : await response.clone().text().catch(() => "");
  const htmlResponse = route !== "img" && (/text\/html/i.test(type) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(bodyPreview));
  if (htmlResponse) {
    const status = response.status >= 500 ? response.status : 502;
    return json({ code: "tv_upstream_error", error: "The TV service returned an HTML error page (HTTP " + status + "). Try again shortly." }, status);
  }
  if (route === "img" ? /^image\//i.test(type) : /^(application\/json|text\/plain)/i.test(type)) headers.set("content-type", type);
  else if (response.ok) return json({ code: "invalid_upstream_response", error: "The TV remote returned an unexpected response." }, 502);
  else if (route !== "img") return json({ code: "tv_upstream_error", error: "The TV service is temporarily unavailable (HTTP " + response.status + "). Try again shortly." }, response.status);
  return new Response(response.body, { status: response.status, headers });
}

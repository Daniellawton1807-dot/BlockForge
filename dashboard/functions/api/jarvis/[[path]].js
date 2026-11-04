import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

// Jarvis (~/vault-claude/jarvis on the server), through the private bridge. Needs the Homebase sign-in;
// Jarvis then asks for its own PIN. The bridge Worker holds the token, so it never reaches this code or the browser.
const ROUTES = { GET: /^(state|events|tts\/[a-f0-9]{40}|img\/[A-Za-z0-9]{1,64})$/, POST: /^(pin|chat|confirm|stt|tts)$/ };

export async function onRequest({ request, env, params }) {
  const method = request.method.toUpperCase();
  if (!ROUTES[method]) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin was rejected." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to use Jarvis." }, 401);

  const path = (Array.isArray(params.path) ? params.path : [String(params.path || "")]).join("/");
  if (!ROUTES[method].test(path)) return json({ code: "not_found", error: "Not available." }, 404);
  if (!env.ARR_BRIDGE) return json({ code: "binding_missing", error: "Private bridge is not bound." }, 503);

  let body;
  if (method === "POST" && path === "stt") {
    body = await request.arrayBuffer();
    if (body.byteLength > 1048576) return json({ code: "too_large", error: "That recording is too long." }, 413);
  } else if (method === "POST") {
    try { body = JSON.stringify(await readJsonBody(request, 4096)); }
    catch { return json({ code: "invalid_request", error: "Could not read that." }, 400); }
  }
  let response;
  try {
    response = await env.ARR_BRIDGE.fetch(new Request("https://homebase-arr-bridge/" + path, {
      method,
      headers: {
        "x-homebase-service": "jarvis",
        "x-jarvis-session": request.headers.get("x-jarvis-session") || "",
        "accept": request.headers.get("accept") || "application/json",
        ...(request.headers.get("range") ? { range: request.headers.get("range") } : {}),
        ...(body ? { "content-type": path === "stt" ? "audio/wav" : "application/json" } : {})
      },
      body
    }));
  } catch {
    return json({ code: "jarvis_unavailable", error: "Jarvis isn't reachable right now." }, 503);
  }
  const headers = new Headers({ "cache-control": response.headers.get("cache-control") || "no-store", "x-content-type-options": "nosniff" });
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

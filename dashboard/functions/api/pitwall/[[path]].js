import { json, loginConfigured, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

// Pitwall Web (F1 multi-viewer, ~/f1/web on the server), through the private bridge. The whole app lives here, under /api,
// because the Homebase cookie is scoped to /api. Signed-out page loads go to /pitwall/ to sign in.
// The bridge Worker holds the server's token, so it never reaches this code or the browser.
const PATH = /^[A-Za-z0-9._~\/-]{0,300}$/;

export async function onRequest({ request, env, params }) {
  const method = request.method.toUpperCase();
  if (!["GET", "POST"].includes(method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin was rejected." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  const url = new URL(request.url);
  const path = (Array.isArray(params.path) ? params.path : [String(params.path || "")]).join("/");
  if (!await validSession(request, env)) {
    const page = method === "GET" && (path === "" || /\.html$/.test(path));
    return page ? Response.redirect(url.origin + "/pitwall/" + (url.search || ""), 302) : json({ code: "login_required", error: "Sign in to use Pitwall." }, 401);
  }
  if (path === "" && !url.pathname.endsWith("/")) return Response.redirect(url.origin + "/api/pitwall/" + url.search, 302); // relative links need the slash
  if (/^(notify|setup)\b/.test(path)) return json({ code: "not_found", error: "Not available." }, 404); // server-to-server only
  if (!PATH.test(path) || path.includes("..")) return json({ code: "not_found", error: "Not available." }, 404);
  if (!env.ARR_BRIDGE) return json({ code: "binding_missing", error: "Private bridge is not bound." }, 503);

  let body;
  if (method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > 600000) return json({ code: "too_large", error: "Too large." }, 413);
  }
  let response;
  try {
    response = await env.ARR_BRIDGE.fetch(new Request("https://homebase-arr-bridge/" + path + url.search, {
      method,
      headers: {
        "x-homebase-service": "pitwall",
        "accept": request.headers.get("accept") || "*/*",
        ...(request.headers.get("x-poll") ? { "x-poll": "1" } : {}),
        ...(body ? { "content-type": request.headers.get("content-type") || "application/json" } : {})
      },
      body
    }));
  } catch {
    return json({ code: "pitwall_unavailable", error: "Pitwall isn't reachable right now." }, 503);
  }
  const headers = new Headers({ "cache-control": response.headers.get("cache-control") || "no-store", "x-content-type-options": "nosniff" });
  for (const name of ["content-type", "content-length", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

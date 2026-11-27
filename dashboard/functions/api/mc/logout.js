import { clearMcCookie, clearSessionCookie, json, validRequestOrigin } from "../../_utils/downloads-auth.js";

export async function onRequest({ request }) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", clearMcCookie()); headers.append("set-cookie", clearSessionCookie());
  return new Response(JSON.stringify({ authenticated: false }), { status: 200, headers });
}

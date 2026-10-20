import { clearSessionCookie, json, validRequestOrigin } from "../../_utils/downloads-auth.js";

export async function onRequest({ request }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
}

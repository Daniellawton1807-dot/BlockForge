import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

// Cheap "am I signed in?" check, so pages can show the sign-in form without calling a service first.
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", authenticated: false, error: "Dashboard login has not been configured." }, 503);
  return json({ authenticated: await validSession(request, env) });
}

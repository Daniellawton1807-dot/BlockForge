import { json, loginConfigured, mcSession, validSession } from "../../_utils/downloads-auth.js";

// Who is signed in on the Minecraft page: Daniel (full Homebase session) or a Minecraft-only friend.
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", authenticated: false }, 503);
  if (await validSession(request, env)) return json({ authenticated: true, role: "owner" });
  const mc = await mcSession(request, env);
  return json(mc ? { authenticated: true, role: "minecraft", user: mc.user } : { authenticated: false });
}

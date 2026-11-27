import { clearSessionCookie, json, loginConfigured, mcCookie, readJsonBody, secretMatches, sessionCookie, validRequestOrigin } from "../../_utils/downloads-auth.js";

// The Minecraft page's sign-in. Daniel's Homebase login gets the normal full session; a Minecraft-only login (checked by the private
// bridge, which holds those names and passwords) gets a cookie that opens the Minecraft page and nothing else.
export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Homebase sign-in isn't set up." }, 503);
  let body;
  try { body = await readJsonBody(request); } catch { return json({ error: "Could not read the sign-in." }, 400); }
  const username = typeof body?.username === "string" ? body.username.slice(0, 512) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 512) : "";
  const [u, p] = await Promise.all([secretMatches(username, String(env.HOMEBASE_DOWNLOADS_USERNAME)), secretMatches(password, String(env.HOMEBASE_DOWNLOADS_PASSWORD))]);
  if (u && p) return json({ authenticated: true, role: "owner" }, 200, { "set-cookie": await sessionCookie(env, body?.remember === true) });
  const bridge = env.ARR_BRIDGE;
  if (!bridge) return json({ error: "Username or password is incorrect." }, 401);
  let r;
  try {
    r = await bridge.fetch(new Request("https://homebase-arr-bridge/mclogin", { method: "POST", headers: { "x-homebase-service": "mclogin", "content-type": "application/json" },
      body: JSON.stringify({ username, password, ip: request.headers.get("cf-connecting-ip") || "" }) }));
  } catch {
    return json({ error: "Couldn't check that sign-in right now." }, 502);
  }
  if (r.status === 429) return json({ error: "Too many wrong tries. Wait 15 minutes and try again." }, 429);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) return json({ error: "Username or password is incorrect." }, 401);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", await mcCookie(env, d.user));
  headers.append("set-cookie", clearSessionCookie());   // a shared PC: never leave Daniel's full session behind a friend's sign-in
  return new Response(JSON.stringify({ authenticated: true, role: "minecraft", user: d.user }), { status: 200, headers });
}

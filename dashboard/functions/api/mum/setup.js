import { json, loginConfigured, mumCookie, mumSession, readJsonBody, secretMatches, validRequestOrigin } from "../../_utils/downloads-auth.js";

// GET: is this phone set up? POST {username, password}: Daniel's Homebase sign-in, once, on Mum's phone.
// It sets only the request-page cookie, never the full Homebase session.
export async function onRequest({ request, env }) {
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Homebase sign-in isn't set up." }, 503);
  if (request.method === "GET") return json({ ready: Boolean(await mumSession(request, env)) });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (!validRequestOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await readJsonBody(request); } catch { return json({ error: "Could not read the sign-in." }, 400); }
  const username = typeof body?.username === "string" ? body.username.slice(0, 512) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 512) : "";
  const [u, p] = await Promise.all([secretMatches(username, String(env.HOMEBASE_DOWNLOADS_USERNAME)), secretMatches(password, String(env.HOMEBASE_DOWNLOADS_PASSWORD))]);
  if (!u || !p) return json({ error: "That username or password isn't right." }, 401);
  return json({ ready: true }, 200, { "set-cookie": await mumCookie(env) });
}

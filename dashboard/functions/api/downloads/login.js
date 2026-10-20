import { json, loginConfigured, readJsonBody, secretMatches, sessionCookie, validRequestOrigin } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  }
  if (!loginConfigured(env)) {
    return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return json({ code: "invalid_request", error: "Could not read the sign-in request." }, 400);
  }

  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (username.length > 512 || password.length > 512) {
    return json({ code: "invalid_credentials", error: "Username or password is incorrect." }, 401);
  }

  const [usernameValid, passwordValid] = await Promise.all([
    secretMatches(username, String(env.HOMEBASE_DOWNLOADS_USERNAME)),
    secretMatches(password, String(env.HOMEBASE_DOWNLOADS_PASSWORD))
  ]);
  if (!usernameValid || !passwordValid) {
    return json({ code: "invalid_credentials", error: "Username or password is incorrect." }, 401);
  }

  const remember = body?.remember === true;
  return json(
    { authenticated: true, remember },
    200,
    { "set-cookie": await sessionCookie(env, remember) }
  );
}

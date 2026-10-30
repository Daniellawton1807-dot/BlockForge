import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../_utils/downloads-auth.js";
import { RULES, loadState, publicState, runAutopilot, saveState } from "../_utils/autopilot.js";

// GET: Autopilot's switches, last check and log. POST {action: "run"} checks now;
// POST {action: "settings", rules: {stalled, importBlocked, research}} turns rules on or off.
export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (request.method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to see Autopilot." }, 401);
  try {
    if (request.method === "GET") return json(publicState(await loadState(env)));
    let body;
    try { body = await readJsonBody(request, 2048); } catch { return json({ code: "invalid_request", error: "Could not read the Autopilot action." }, 400); }
    if (body?.action === "run") return json(publicState(await runAutopilot(env, "manual")));
    if (body?.action === "settings" && body.rules && typeof body.rules === "object") {
      const state = await loadState(env);
      for (const key of Object.keys(RULES)) if (typeof body.rules[key] === "boolean") state.settings.rules[key] = body.rules[key];
      await saveState(env, state);
      return json(publicState(state));
    }
    return json({ code: "invalid_request", error: "Unknown Autopilot action." }, 400);
  } catch (error) {
    return json({ code: "autopilot_failed", error: error?.message || "Autopilot couldn't finish." }, 502);
  }
}

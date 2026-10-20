import { json, loginConfigured, validSession } from "../../../_utils/downloads-auth.js";
import { SeerrError, seerrConfigured, seerrTargets } from "../../../_utils/seerr.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) {
    return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  }
  if (!await validSession(request, env)) {
    return json({ code: "login_required", error: "Sign in to use media requests." }, 401);
  }
  if (!seerrConfigured(env)) {
    return json({ code: "seerr_setup_required", error: "Set SEERR_API_KEY as a Secret in Cloudflare Pages Production." }, 503);
  }

  try {
    const [sonarr, radarr] = await Promise.all([
      seerrTargets(env, "sonarr"),
      seerrTargets(env, "radarr")
    ]);
    return json({ sonarr, radarr });
  } catch (error) {
    return json({
      code: error instanceof SeerrError ? error.code : "seerr_unavailable",
      error: error instanceof SeerrError ? error.message : "Could not load Seerr destinations."
    }, error instanceof SeerrError ? error.status : 502);
  }
}

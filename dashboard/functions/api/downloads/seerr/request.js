import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../../_utils/downloads-auth.js";
import { SeerrError, seerrCall, seerrConfigured, seerrTargets } from "../../../_utils/seerr.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  }
  if (!loginConfigured(env)) {
    return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  }
  if (!await validSession(request, env)) {
    return json({ code: "login_required", error: "Sign in before submitting a request." }, 401);
  }
  if (!seerrConfigured(env)) {
    return json({ code: "seerr_setup_required", error: "Set SEERR_API_KEY as a Secret in the Cloudflare Pages Production environment." }, 503);
  }

  let body;
  try {
    body = await readJsonBody(request, 8192);
  } catch {
    return json({ code: "invalid_request", error: "Could not read the media request." }, 400);
  }

  const mediaType = String(body?.mediaType || "");
  const mediaId = Number(body?.mediaId);
  const targetId = Number(body?.targetId);
  if (!["movie", "tv"].includes(mediaType)
      || !Number.isSafeInteger(mediaId) || mediaId <= 0
      || !Number.isSafeInteger(targetId) || targetId < 0) {
    return json({ code: "invalid_request", error: "Select a title and a valid media destination." }, 400);
  }

  try {
    const serviceType = mediaType === "tv" ? "sonarr" : "radarr";
    const targets = await seerrTargets(env, serviceType);
    const target = targets.find(server => server.id === targetId);
    if (!target) {
      return json({ code: "invalid_destination", error: "That media destination is no longer configured in Seerr. Refresh and choose again." }, 400);
    }

    let rootFolder = "";
    if (mediaType === "movie") {
      rootFolder = typeof body.rootFolder === "string" ? body.rootFolder : "";
      if (!target.rootFolders.some(folder => folder.path === rootFolder)) {
        return json({ code: "invalid_destination", error: "Choose one of the root folders configured for that Radarr instance." }, 400);
      }
    } else {
      rootFolder = target.activeDirectory || target.rootFolders[0]?.path || "";
    }

    const payload = {
      mediaType,
      mediaId,
      serverId: target.id,
      is4k: target.is4k
    };
    if (target.profileId) payload.profileId = target.profileId;
    if (rootFolder) payload.rootFolder = rootFolder;

    if (mediaType === "tv") {
      payload.seasons = "all";
      const tvdbId = Number(body.tvdbId);
      if (Number.isSafeInteger(tvdbId) && tvdbId > 0) payload.tvdbId = tvdbId;
    }

    const created = await seerrCall(env, "request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    return json({
      accepted: true,
      requestId: Number.isSafeInteger(Number(created?.id)) ? Number(created.id) : null,
      mediaType,
      status: Number.isSafeInteger(Number(created?.status)) ? Number(created.status) : null
    }, 201);
  } catch (error) {
    return json({
      code: error instanceof SeerrError ? error.code : "seerr_unavailable",
      error: error instanceof SeerrError ? error.message : "Seerr could not submit that request."
    }, error instanceof SeerrError ? error.status : 502);
  }
}

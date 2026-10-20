import { arrCall, arrService, arrServiceStatus } from "../../_utils/arr.js";
import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

function safeId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in before adding media." }, 401);

  let body;
  try { body = await readJsonBody(request, 4096); }
  catch { return json({ code: "invalid_request", error: "Could not read the media settings." }, 400); }

  const service = arrService(body?.serviceKey);
  const mediaType = String(body?.mediaType || "");
  const tmdbId = safeId(body?.tmdbId);
  const tvdbId = safeId(body?.tvdbId);
  const rootFolderPath = typeof body?.rootFolderPath === "string" ? body.rootFolderPath : "";
  const qualityProfileId = safeId(body?.qualityProfileId);
  if (!service || service.type !== mediaType || (mediaType === "tv" ? (!tvdbId && !tmdbId) : !tmdbId) || !qualityProfileId || rootFolderPath.length < 1 || rootFolderPath.length > 512) {
    return json({ code: "invalid_request", error: "Choose a valid Sonarr or Radarr instance, root folder, and quality profile." }, 400);
  }
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    const [rootFolders, profiles, library, lookup] = await Promise.all([
      arrCall(env, service, "api/v3/rootfolder"),
      arrCall(env, service, "api/v3/qualityprofile"),
      arrCall(env, service, service.type === "tv" ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true"),
      arrCall(env, service, "api/v3/" + (service.type === "tv" ? "series" : "movie") + "/lookup?term=" + encodeURIComponent(service.type === "tv" && tvdbId ? "tvdb:" + tvdbId : "tmdb:" + tmdbId))
    ]);
    const selectedFolder = Array.isArray(rootFolders) && rootFolders.find(folder => folder.path === rootFolderPath);
    const selectedProfile = Array.isArray(profiles) && profiles.find(profile => Number(profile.id) === qualityProfileId);
    if (!selectedFolder || !selectedProfile) return json({ code: "invalid_destination", error: "That folder or quality profile is no longer configured on the selected instance. Refresh and choose again." }, 400);

    const duplicate = (Array.isArray(library) ? library : []).find(item => service.type === "tv"
      ? (tvdbId && Number(item.tvdbId) === tvdbId) || (!tvdbId && tmdbId && Number(item.tmdbId) === tmdbId)
      : Number(item.tmdbId) === tmdbId);
    if (duplicate) return json({ code: "already_in_library", error: "This title is already in " + service.name + ".", itemId: Number(duplicate.id) || null }, 409);

    const items = Array.isArray(lookup) ? lookup : [];
    const metadata = items.find(item => service.type === "tv"
      ? (tvdbId ? Number(item.tvdbId) === tvdbId : Number(item.tmdbId) === tmdbId)
      : Number(item.tmdbId) === tmdbId);
    if (!metadata) return json({ code: "title_not_found", error: "The selected title is no longer available from " + service.name + ". Search again and choose a result." }, 404);

    const payload = {
      ...metadata,
      id: 0,
      rootFolderPath,
      qualityProfileId,
      monitored: body.monitored !== false
    };
    if (service.type === "tv") {
      payload.seasonFolder = body.seasonFolder !== false;
      payload.seriesType = ["standard", "daily", "anime"].includes(body.seriesType) ? body.seriesType : "standard";
      payload.addOptions = {
        ...(metadata.addOptions || {}),
        searchForMissingEpisodes: body.searchOnAdd !== false,
        monitor: ["all", "future", "missing", "existing", "latestSeason", "firstSeason", "none"].includes(body.monitorType) ? body.monitorType : "all"
      };
    } else {
      payload.addOptions = { ...(metadata.addOptions || {}), searchForMovie: body.searchOnAdd !== false };
    }

    const created = await arrCall(env, service, "api/v3/" + (service.type === "tv" ? "series" : "movie"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    return json({ accepted: true, item: {
      id: Number(created?.id) || null,
      title: String(created?.title || metadata.title || "Added media"),
      serviceName: service.name,
      mediaType: service.type
    } }, 201);
  } catch (error) {
    return json({ code: error?.code || "arr_unavailable", error: error?.message || service.name + " could not add that media." }, error?.status || 502);
  }
}

import { arrCall, arrService, arrServiceStatus } from "../../_utils/arr.js";
import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in before managing media." }, 401);
  let body;
  try { body = await readJsonBody(request, 2048); }
  catch { return json({ code: "invalid_request", error: "Could not read the media action." }, 400); }

  const service = arrService(body?.serviceKey);
  const id = Number(body?.id);
  const action = String(body?.action || "");
  if (!service || !Number.isSafeInteger(id) || id <= 0 || !["monitor", "refresh", "search", "requestSeason", "requestEpisode", "searchEpisode"].includes(action)) {
    return json({ code: "invalid_request", error: "Select a valid library item and action." }, 400);
  }
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    if (action === "requestSeason" || action === "requestEpisode" || action === "searchEpisode") {
      if (service.type !== "tv") return json({ code: "invalid_request", error: "Episode requests are available for Sonarr series only." }, 400);
      const seasonNumber = Number(body?.seasonNumber);
      const episodeId = Number(body?.episodeId);
      if (action === "requestSeason" && (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 99)) return json({ code: "invalid_request", error: "Select a valid season." }, 400);
      if ((action === "requestEpisode" || action === "searchEpisode") && (!Number.isSafeInteger(episodeId) || episodeId <= 0)) return json({ code: "invalid_request", error: "Select a valid episode." }, 400);

      const series = await arrCall(env, service, "api/v3/series/" + id);
      if (!series || Number(series.id) !== id) return json({ code: "not_found", error: "That series is no longer in the selected library." }, 404);
      const allEpisodes = await arrCall(env, service, "api/v3/episode?seriesId=" + id);
      if (!Array.isArray(allEpisodes)) return json({ code: "invalid_upstream_response", error: "Sonarr did not return the series episodes." }, 502);
      const selected = action === "requestSeason"
        ? allEpisodes.filter(episode => Number(episode.seasonNumber) === seasonNumber)
        : allEpisodes.filter(episode => Number(episode.id) === episodeId);
      if (!selected.length) return json({ code: "not_found", error: "No matching episodes were found." }, 404);
      if (selected.some(episode => Number(episode.seriesId) !== id)) return json({ code: "invalid_request", error: "One or more episodes do not belong to this series." }, 400);
      const validEpisodes = selected.filter(episode => Number.isSafeInteger(Number(episode.id)) && Number(episode.id) > 0);
      if (action === "searchEpisode") {
        const episode = validEpisodes[0];
        if (!episode) return json({ code: "not_found", error: "That episode is no longer in the selected series." }, 404);
        if (!episode.monitored) {
          await arrCall(env, service, "api/v3/episode/monitor", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ episodeIds: [Number(episode.id)], monitored: true })
          });
        }
        const queued = await arrCall(env, service, "api/v3/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "EpisodeSearch", episodeIds: [Number(episode.id)] })
        });
        return json({ accepted: true, commandId: Number(queued?.id) || null, action, monitoredEpisodeCount: 1 });
      }
      const missing = validEpisodes.filter(episode => !episode.hasFile);
      if (!missing.length) return json({ code: "already_available", error: action === "requestEpisode" ? "That episode is already available in the library." : "All episodes in this season are already available." }, 409);
      if (missing.length > 500) return json({ code: "too_many_episodes", error: "This season has too many missing episodes to request at once." }, 400);

      await arrCall(env, service, "api/v3/episode/monitor", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episodeIds: missing.map(episode => Number(episode.id)), monitored: true })
      });
      const command = { name: "EpisodeSearch", episodeIds: missing.map(episode => Number(episode.id)) };
      const queued = await arrCall(env, service, "api/v3/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command)
      });
      return json({ accepted: true, commandId: Number(queued?.id) || null, action, monitoredEpisodeCount: missing.length });
    }

    const resource = service.type === "tv" ? "series" : "movie";
    if (action === "monitor") {
      const current = await arrCall(env, service, "api/v3/" + resource + "/" + id);
      if (!current || Number(current.id) !== id) return json({ code: "not_found", error: "That title is no longer in the selected library." }, 404);
      current.monitored = body.value === true;
      const updated = await arrCall(env, service, "api/v3/" + resource + "/" + id, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current)
      });
      return json({ accepted: true, monitored: Boolean(updated?.monitored) });
    }

    const commandName = action === "refresh"
      ? (service.type === "tv" ? "RefreshSeries" : "RefreshMovie")
      : (service.type === "tv" ? "SeriesSearch" : "MoviesSearch");
    const command = service.type === "tv"
      ? { name: commandName, seriesId: id }
      : action === "refresh" ? { name: commandName, movieId: id } : { name: commandName, movieIds: [id] };
    const queued = await arrCall(env, service, "api/v3/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    });
    return json({ accepted: true, commandId: Number(queued?.id) || null, action });
  } catch (error) {
    return json({ code: error?.code || "arr_unavailable", error: error?.message || service.name + " could not complete that action." }, error?.status || 502);
  }
}

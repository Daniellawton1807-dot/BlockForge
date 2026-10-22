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
  if (!service || !Number.isSafeInteger(id) || id <= 0 || !["monitor", "refresh", "search", "requestSeason", "requestEpisode", "searchEpisode", "removeEpisode", "removeMovie", "removeSeries"].includes(action)) {
    return json({ code: "invalid_request", error: "Select a valid library item and action." }, 400);
  }
  if (action === "removeEpisode" && service.type !== "tv") return json({ code: "invalid_request", error: "Episode files can only be removed from a Sonarr series." }, 400);
  if (action === "removeMovie" && service.type !== "movie") return json({ code: "invalid_request", error: "Movie files can only be removed from Radarr." }, 400);
  if (action === "removeSeries" && service.type !== "tv") return json({ code: "invalid_request", error: "Whole shows can only be removed from Sonarr." }, 400);
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    if (action === "removeEpisode") {
      const episodeId = Number(body?.episodeId);
      const confirmedIds = Array.isArray(body?.episodeFileEpisodeIds)
        ? [...new Set(body.episodeFileEpisodeIds.map(Number))].filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b)
        : [];
      if (!Number.isSafeInteger(episodeId) || episodeId <= 0 || !confirmedIds.length || confirmedIds.length > 100) {
        return json({ code: "invalid_request", error: "Select a valid downloaded episode file." }, 400);
      }
      const [series, episodes] = await Promise.all([
        arrCall(env, service, "api/v3/series/" + id),
        arrCall(env, service, "api/v3/episode?seriesId=" + id)
      ]);
      if (!series || Number(series.id) !== id) return json({ code: "not_found", error: "That series is no longer in the selected library." }, 404);
      if (!Array.isArray(episodes)) return json({ code: "invalid_upstream_response", error: "Sonarr did not return the series episodes." }, 502);
      const episode = episodes.find(entry => Number(entry.id) === episodeId);
      if (!episode || Number(episode.seriesId) !== id) return json({ code: "not_found", error: "That episode is no longer in the selected series." }, 404);
      if (!episode.hasFile) return json({ code: "file_not_found", error: "That episode no longer has a file on disk." }, 409);
      const episodeFileId = Number(episode.episodeFileId || episode.episodeFile?.id);
      if (!Number.isSafeInteger(episodeFileId) || episodeFileId <= 0) return json({ code: "file_not_found", error: "Sonarr could not identify the episode file to remove." }, 409);
      const file = await arrCall(env, service, "api/v3/episodefile/" + episodeFileId);
      if (!file || Number(file.id) !== episodeFileId || Number(file.seriesId) !== id) return json({ code: "file_changed", error: "The episode file changed. Refresh the details and try again." }, 409);
      const fileIds = Array.isArray(file.episodeIds) && file.episodeIds.length
        ? file.episodeIds.map(Number)
        : episodes.filter(entry => Number(entry.episodeFileId || entry.episodeFile?.id) === episodeFileId).map(entry => Number(entry.id));
      const actualIds = [...new Set(fileIds)].filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
      const actualEpisodes = episodes.filter(entry => actualIds.includes(Number(entry.id)));
      if (!actualIds.includes(episodeId) || actualEpisodes.length !== actualIds.length || actualEpisodes.some(entry => Number(entry.seriesId) !== id || Number(entry.episodeFileId || entry.episodeFile?.id) !== episodeFileId)) {
        return json({ code: "file_changed", error: "Sonarr could not verify which episodes use this file. Refresh the details and try again." }, 409);
      }
      if (confirmedIds.length !== actualIds.length || confirmedIds.some((value, index) => value !== actualIds[index])) {
        return json({ code: "file_changed", error: "The episodes stored in this file changed. Refresh the details and confirm again." }, 409);
      }
      await arrCall(env, service, "api/v3/episodefile/" + episodeFileId, { method: "DELETE" });
      return json({ accepted: true, action, removedEpisodeIds: actualIds });
    }

    if (action === "removeSeries") {
      const series = await arrCall(env, service, "api/v3/series/" + id);
      if (!series || Number(series.id) !== id) return json({ code: "not_found", error: "That show is no longer in the selected library." }, 404);
      const files = await arrCall(env, service, "api/v3/episodefile?seriesId=" + id);
      if (!Array.isArray(files)) return json({ code: "invalid_upstream_response", error: "Sonarr did not return the show's episode files, so deletion was stopped." }, 502);
      const removedFileCount = files.filter(file => Number(file.seriesId) === id && Number.isSafeInteger(Number(file.id)) && Number(file.id) > 0).length;
      // Sonarr's series delete with deleteFiles=true removes the library entry
      // and all files/folders under its managed series path.
      await arrCall(env, service, "api/v3/series/" + id + "?deleteFiles=true&addImportListExclusion=false", { method: "DELETE" });
      return json({ accepted: true, action, removedFileCount });
    }

    if (action === "removeMovie") {
      const movie = await arrCall(env, service, "api/v3/movie/" + id);
      if (!movie || Number(movie.id) !== id) return json({ code: "not_found", error: "That movie is no longer in the selected library." }, 404);
      const movieFiles = await arrCall(env, service, "api/v3/moviefile?movieId=" + id);
      const files = Array.isArray(movieFiles) ? movieFiles : [];
      // Removing the Radarr library entry must work even if no movie file has
      // been downloaded yet. deleteFiles=true removes any file if present.
      await arrCall(env, service, "api/v3/movie/" + id + "?deleteFiles=true&addImportExclusion=false", { method: "DELETE" });
      return json({ accepted: true, action, removedFileCount: files.filter(file => Number(file.movieId) === id).length });
    }

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

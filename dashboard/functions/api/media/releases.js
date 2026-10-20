import { arrCall, arrService, arrServiceStatus } from "../../_utils/arr.js";
import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

function text(value, limit = 500) {
  return String(value || "").slice(0, limit);
}
function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function normalizeRelease(release, episodeId) {
  const episodeIds = Array.isArray(release.episodeIds) ? release.episodeIds.map(Number) : [];
  const singleEpisodeId = Number(release.episodeId);
  if (episodeIds.length && !episodeIds.includes(episodeId)) return null;
  if (!episodeIds.length && Number.isSafeInteger(singleEpisodeId) && singleEpisodeId > 0 && singleEpisodeId !== episodeId) return null;
  const quality = release.quality?.quality?.name || release.quality?.name || "";
  const protocol = release.protocol?.name || release.protocol || "";
  const type = release.fullSeason ? "Season pack" : episodeIds.length > 1 ? "Multi-episode" : "Single episode";
  return {
    guid: text(release.guid, 700),
    indexerId: Number(release.indexerId) || 0,
    title: text(release.title, 700),
    quality: text(quality, 100),
    size: Math.max(0, numeric(release.size)),
    score: release.customFormatScore == null ? null : numeric(release.customFormatScore),
    protocol: text(protocol, 40).toLowerCase(),
    indexer: text(release.indexer, 180),
    releaseType: type,
    approved: Boolean(release.approved),
    rejected: Boolean(release.rejected || release.temporarilyRejected),
    rejections: Array.isArray(release.rejections) ? release.rejections.map(reason => text(reason, 220)).filter(Boolean).slice(0, 12) : [],
    publishDate: text(release.publishDate, 50),
    languages: Array.isArray(release.languages) ? release.languages.map(language => text(language?.name || language, 60)).filter(Boolean).slice(0, 8) : [],
    seeders: release.seeders == null ? null : numeric(release.seeders),
    leechers: release.leechers == null ? null : numeric(release.leechers)
  };
}
async function getSeriesAndEpisode(env, service, seriesId, episodeId) {
  const [series, episodes] = await Promise.all([
    arrCall(env, service, "api/v3/series/" + seriesId),
    arrCall(env, service, "api/v3/episode?seriesId=" + seriesId)
  ]);
  if (!series || Number(series.id) !== seriesId || !Array.isArray(episodes)) return null;
  const episode = episodes.find(candidate => Number(candidate.id) === episodeId && Number(candidate.seriesId) === seriesId);
  return episode ? { series, episode } : null;
}
function episodeSummary(series, episode) {
  const season = Number(episode.seasonNumber) || 0;
  const number = Number(episode.episodeNumber) || 0;
  return {
    code: "S" + String(season).padStart(2, "0") + "E" + String(number).padStart(2, "0"),
    title: text(episode.title || "Episode " + number, 180),
    seriesTitle: text(series.title || "Series", 180)
  };
}
function parseIds(params) {
  const service = arrService(String(params.get("serviceKey") || ""));
  const seriesId = Number(params.get("seriesId"));
  const episodeId = Number(params.get("episodeId"));
  if (!service || service.type !== "tv" || !Number.isSafeInteger(seriesId) || seriesId <= 0 || !Number.isSafeInteger(episodeId) || episodeId <= 0) {
    return { error: json({ code: "invalid_request", error: "Select a valid Sonarr series and episode." }, 400) };
  }
  return { service, seriesId, episodeId };
}
export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (request.method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (request.method === "POST" && !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in before searching releases." }, 401);

  let params;
  let selection = null;
  if (request.method === "GET") {
    params = new URL(request.url).searchParams;
  } else {
    try { selection = await readJsonBody(request, 4096); }
    catch { return json({ code: "invalid_request", error: "Could not read the selected release." }, 400); }
    params = new URLSearchParams({
      serviceKey: String(selection?.serviceKey || ""),
      seriesId: String(selection?.seriesId || ""),
      episodeId: String(selection?.episodeId || "")
    });
  }
  const parsed = parseIds(params);
  if (parsed.error) return parsed.error;
  const { service, seriesId, episodeId } = parsed;
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    const found = await getSeriesAndEpisode(env, service, seriesId, episodeId);
    if (!found) return json({ code: "not_found", error: "That episode is no longer in the selected Sonarr series." }, 404);
    const episode = episodeSummary(found.series, found.episode);
    const upstream = await arrCall(env, service, "api/v3/release?episodeId=" + episodeId);
    const source = Array.isArray(upstream) ? upstream : [];
    if (request.method === "GET") {
      const releases = source.slice(0, 300).map(release => normalizeRelease(release, episodeId)).filter(Boolean);
      return json({ episode, releases });
    }

    const guid = String(selection?.guid || "");
    const title = String(selection?.title || "");
    const indexerId = Number(selection?.indexerId);
    if (!guid || guid.length > 700 || !title || title.length > 700 || !Number.isSafeInteger(indexerId) || indexerId <= 0) {
      return json({ code: "invalid_request", error: "Select a valid release from the current search results." }, 400);
    }
    const matched = source.find(release => String(release.guid || "") === guid && Number(release.indexerId) === indexerId && String(release.title || "") === title);
    if (!matched) return json({ code: "release_expired", error: "That result has expired. Search again and select the release again." }, 409);
    await arrCall(env, service, "api/v3/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(matched)
    });
    return json({ accepted: true, message: "Selected release queued in " + service.name + "." });
  } catch (error) {
    return json({ code: error?.code || "arr_unavailable", error: error?.message || service.name + " could not search or grab that release." }, error?.status || 502);
  }
}

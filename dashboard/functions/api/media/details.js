import { arrCall, arrService, arrServiceStatus, normalizeLibraryItem } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

function text(value, limit = 1000) {
  return String(value || "").slice(0, limit);
}
function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function queueEpisodeIds(item) {
  const ids = [item?.episodeId, item?.episode?.id, ...(Array.isArray(item?.episodes) ? item.episodes.map(episode => episode?.id ?? episode) : [])]
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0);
  return new Set(ids);
}
function queueInfo(item) {
  const rawState = text(item?.trackedDownloadState || item?.status || item?.trackedDownloadStatus || "", 50).toLowerCase();
  const state = rawState.includes("download") ? "Downloading"
    : rawState.includes("import") ? "Importing"
    : rawState.includes("pause") ? "Paused"
    : rawState.includes("queue") || rawState.includes("delay") || rawState.includes("pending") ? "Queued"
    : rawState.includes("fail") || rawState.includes("warn") || rawState.includes("error") ? "Needs attention"
    : "Grabbed";
  const total = numeric(item?.size), remaining = numeric(item?.sizeleft);
  const progressValue = Number(item?.percentage);
  const progress = Number.isFinite(progressValue) && progressValue >= 0
    ? Math.max(0, Math.min(100, progressValue))
    : total > 0 ? Math.max(0, Math.min(100, (total - remaining) / total * 100)) : null;
  const timeleft = text(item?.timeleft, 40);
  const eta = /^\d+(?::\d+){1,2}$/.test(timeleft) ? timeleft : "";
  return { state, progress, eta };
}
function fileDetails(file) {
  if (!file) return null;
  const mediaInfo = file.mediaInfo && typeof file.mediaInfo === "object" ? file.mediaInfo : {};
  return {
    path: text(file.path || "", 700),
    relativePath: text(file.relativePath || "", 700),
    size: numeric(file.size),
    quality: text(file.quality?.quality?.name || file.quality?.name || "", 80),
    mediaInfo: {
      resolution: text(mediaInfo.resolution || "", 40),
      videoCodec: text(mediaInfo.videoCodec || "", 60),
      audioCodec: text(mediaInfo.audioCodec || "", 60)
    },
    episodeIds: Array.isArray(file.episodeIds) ? file.episodeIds.map(Number).filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 100) : []
  };
}
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to view media details." }, 401);

  const params = new URL(request.url).searchParams;
  const service = arrService(params.get("serviceKey"));
  const id = Number(params.get("id"));
  if (!service || !Number.isSafeInteger(id) || id <= 0) return json({ code: "invalid_request", error: "Select a valid library item." }, 400);
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    const resource = service.type === "tv" ? "series" : "movie";
    const raw = await arrCall(env, service, "api/v3/" + resource + "/" + id);
    if (!raw || Number(raw.id) !== id) return json({ code: "not_found", error: "That title is no longer in the selected library." }, 404);
    const base = normalizeLibraryItem(service, raw);
    if (!base) return json({ code: "invalid_upstream_response", error: "The selected title details were incomplete." }, 502);

    const item = {
      ...base,
      overview: text(raw.overview, 1600),
      rootFolderPath: text(raw.rootFolderPath || raw.path, 700),
      network: text(raw.network, 100),
      path: text(raw.path, 700),
      hasFile: Boolean(raw.hasFile || numeric(raw.sizeOnDisk) > 0)
    };
    if (service.type === "tv") {
      const [episodeResult, fileResult, queueResult] = await Promise.all([
        arrCall(env, service, "api/v3/episode?seriesId=" + id),
        arrCall(env, service, "api/v3/episodefile?seriesId=" + id),
        arrCall(env, service, "api/v3/queue?page=1&pageSize=500").catch(() => [])
      ]);
      const episodes = Array.isArray(episodeResult) ? episodeResult : [];
      const files = Array.isArray(fileResult) ? fileResult : [];
      const queueRecords = Array.isArray(queueResult) ? queueResult : Array.isArray(queueResult?.records) ? queueResult.records : [];
      const fileById = new Map(files.map(file => [Number(file.id), file]));
      const seasonMap = new Map();
      for (const season of Array.isArray(raw.seasons) ? raw.seasons : []) {
        const seasonNumber = Number(season.seasonNumber);
        if (Number.isSafeInteger(seasonNumber) && seasonNumber >= 0) seasonMap.set(seasonNumber, {
          seasonNumber,
          monitored: Boolean(season.monitored),
          statistics: {
            episodeCount: numeric(season.statistics?.episodeCount),
            episodeFileCount: numeric(season.statistics?.episodeFileCount),
            totalEpisodeCount: numeric(season.statistics?.totalEpisodeCount)
          }
        });
      }
      const normalizedEpisodes = episodes.slice(0, 2000).map(episode => {
        const episodeId = Number(episode.id);
        const episodeFile = fileById.get(Number(episode.episodeFileId)) || episode.episodeFile || null;
        const seasonNumber = numeric(episode.seasonNumber);
        if (!seasonMap.has(seasonNumber)) seasonMap.set(seasonNumber, { seasonNumber, monitored: Boolean(episode.monitored), statistics: { episodeCount: 0, episodeFileCount: 0, totalEpisodeCount: 0 } });
        const hasFile = Boolean(episode.hasFile || episodeFile);
        const normalizedFile = fileDetails(episodeFile);
        const queueEntry = queueRecords.find(item => {
          const itemSeriesId = Number(item?.seriesId || item?.episode?.seriesId || item?.series?.id);
          return itemSeriesId === id && queueEpisodeIds(item).has(episodeId);
        });
        const download = queueEntry && !hasFile ? queueInfo(queueEntry) : null;
        if (normalizedFile) {
          const relatedIds = normalizedFile.episodeIds.length
            ? normalizedFile.episodeIds
            : episodes.filter(candidate => Number(candidate.episodeFileId) === Number(episodeFile.id)).map(candidate => Number(candidate.id));
          normalizedFile.episodeIds = [...new Set([...relatedIds, episodeId])].filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 100);
        }
        return {
          id: Number.isSafeInteger(episodeId) ? episodeId : 0,
          seriesId: Number(episode.seriesId) || id,
          seasonNumber,
          episodeNumber: numeric(episode.episodeNumber),
          title: text(episode.title, 180),
          overview: text(episode.overview, 480),
          airDate: text(episode.airDateUtc || episode.airDate || "", 40),
          runtime: numeric(episode.runtime),
          hasFile,
          monitored: Boolean(episode.monitored),
          download,
          file: normalizedFile
        };
      }).filter(episode => episode.id > 0).sort((a,b) => a.seasonNumber-b.seasonNumber || a.episodeNumber-b.episodeNumber);
      for (const season of seasonMap.values()) {
        const seasonEpisodes = normalizedEpisodes.filter(episode => episode.seasonNumber === season.seasonNumber);
        if (!season.statistics.episodeCount) season.statistics.episodeCount = seasonEpisodes.length;
        if (!season.statistics.episodeFileCount) season.statistics.episodeFileCount = seasonEpisodes.filter(episode => episode.hasFile).length;
      }
      item.seasons = [...seasonMap.values()].sort((a,b)=>a.seasonNumber-b.seasonNumber);
      item.episodes = normalizedEpisodes;
      item.episodeCount = numeric(raw.statistics?.episodeCount) || normalizedEpisodes.length;
      item.episodeFileCount = numeric(raw.statistics?.episodeFileCount) || normalizedEpisodes.filter(episode=>episode.hasFile).length;
      item.sizeOnDisk = numeric(raw.statistics?.sizeOnDisk);
      item.hasFile = item.episodeFileCount > 0;
      return json({ item });
    }

    const movieFiles = await arrCall(env, service, "api/v3/moviefile?movieId=" + id);
    const files = (Array.isArray(movieFiles) ? movieFiles : raw.movieFile ? [raw.movieFile] : []).map(fileDetails).filter(Boolean);
    item.files = files;
    item.hasFile = files.length > 0 || item.hasFile;
    return json({ item });
  } catch (error) {
    return json({ code: error?.code || "arr_unavailable", error: error?.message || service.name + " could not load this title." }, error?.status || 502);
  }
}

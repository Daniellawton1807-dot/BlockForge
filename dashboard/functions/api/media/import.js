import { arrCall, arrService, arrServiceStatus } from "../../_utils/arr.js";
import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

// Manual import, like Sonarr/Radarr's own Activity → Manual Import, so a blocked import can be fixed
// without leaving Homebase.
//   GET  ?serviceKey&downloadId            the download's files with what they were matched to and why they're stuck
//   POST {action: "import", serviceKey, downloadId, files: [{path, seriesId, episodeIds} | {path, movieId}]}
//   POST {action: "remove", serviceKey, queueId, blocklist}
// Only files Sonarr/Radarr list for that download can be imported (paths are re-checked against that list).

const text = (v, n = 300) => String(v ?? "").slice(0, n);
const ids = list => (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 50);

async function candidates(env, service, downloadId) {
  const list = await arrCall(env, service, "api/v3/manualimport?downloadId=" + encodeURIComponent(downloadId) + "&filterExistingFiles=false");
  return Array.isArray(list) ? list : [];
}
function normalize(c, tv) {
  return {
    path: text(c.path, 1000), name: text(c.relativePath || c.name || c.path, 300), size: Number(c.size) || 0,
    quality: text(c.quality?.quality?.name, 60), releaseGroup: text(c.releaseGroup, 80),
    rejections: (Array.isArray(c.rejections) ? c.rejections : []).map(r => text(r?.reason || r, 240)).slice(0, 6),
    ...(tv ? {
      seriesId: Number(c.series?.id) || null, seriesTitle: text(c.series?.title, 160),
      seasonNumber: Number.isFinite(Number(c.seasonNumber)) ? Number(c.seasonNumber) : null,
      episodes: (Array.isArray(c.episodes) ? c.episodes : []).map(e => ({ id: Number(e.id), season: Number(e.seasonNumber), episode: Number(e.episodeNumber), title: text(e.title, 160) }))
    } : { movieId: Number(c.movie?.id) || null, movieTitle: text(c.movie?.title, 160), year: Number(c.movie?.year) || null })
  };
}

export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (request.method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to manage imports." }, 401);

  let input = {};
  if (request.method === "GET") input = Object.fromEntries(new URL(request.url).searchParams);
  else { try { input = await readJsonBody(request, 16384); } catch { return json({ code: "invalid_request", error: "Could not read the request." }, 400); } }
  const service = arrService(String(input.serviceKey || ""));
  if (!service) return json({ code: "invalid_request", error: "Pick Sonarr or Radarr." }, 400);
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);
  const tv = service.type === "tv";

  try {
    if (request.method === "POST" && input.action === "remove") {
      const queueId = Number(input.queueId);
      if (!Number.isSafeInteger(queueId) || queueId <= 0) return json({ code: "invalid_request", error: "That download isn't in the queue any more." }, 400);
      const query = "removeFromClient=true&blocklist=" + Boolean(input.blocklist) + "&skipRedownload=" + !input.blocklist;
      try { await arrCall(env, service, "api/v3/queue/" + queueId + "?" + query, { method: "DELETE" }); }
      catch (error) { if (error?.code !== "invalid_upstream_response") throw error; }
      return json({ ok: true, message: input.blocklist ? "Removed and blocklisted. Looking for another release." : "Removed from the queue." });
    }

    const downloadId = text(input.downloadId, 120);
    if (!/^[A-Za-z0-9_.:-]{6,120}$/.test(downloadId)) return json({ code: "invalid_request", error: "That download can't be imported by hand." }, 400);
    const found = await candidates(env, service, downloadId);

    if (request.method === "GET") return json({ serviceKey: service.key, mediaType: service.type, files: found.map(c => normalize(c, tv)) });

    if (input.action !== "import") return json({ code: "invalid_request", error: "Unknown action." }, 400);
    const wanted = (Array.isArray(input.files) ? input.files : []).slice(0, 50);
    const byPath = new Map(found.map(c => [String(c.path), c]));
    const files = [];
    for (const w of wanted) {
      const c = byPath.get(String(w?.path || ""));
      if (!c) return json({ code: "invalid_request", error: "One of those files isn't part of this download any more. Refresh and try again." }, 400);
      const base = { path: c.path, quality: c.quality, languages: c.languages, releaseGroup: c.releaseGroup, downloadId, indexerFlags: c.indexerFlags || 0 };
      if (tv) {
        const seriesId = Number(w.seriesId), episodeIds = ids(w.episodeIds);
        if (!seriesId || !episodeIds.length) return json({ code: "invalid_request", error: "Pick the show and episode for every file you import." }, 400);
        files.push({ ...base, seriesId, episodeIds, releaseType: c.releaseType || "singleEpisode" });
      } else {
        const movieId = Number(w.movieId);
        if (!movieId) return json({ code: "invalid_request", error: "Pick the film for every file you import." }, 400);
        files.push({ ...base, movieId });
      }
    }
    if (!files.length) return json({ code: "invalid_request", error: "Pick at least one file to import." }, 400);
    await arrCall(env, service, "api/v3/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ManualImport", files, importMode: "auto" }) });
    return json({ ok: true, message: "Importing " + files.length + " file" + (files.length === 1 ? "" : "s") + ". It'll show in your library in a moment." });
  } catch (error) {
    return json({ code: error?.code || "import_failed", error: error?.message || "Sonarr/Radarr didn't accept that." }, error?.status || 502);
  }
}

import { arrCall, arrServiceStatus, arrServices } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to view recent downloads." }, 401);

  const results = await Promise.all(arrServices().map(async service => {
    const status = arrServiceStatus(env, service);
    if (!status.configured) return { items: [], events: [] };
    const [historyResult, libraryResult, healthResult] = await Promise.allSettled([
      arrCall(env, service, "api/v3/history?page=1&pageSize=40&sortKey=date&sortDirection=descending"),
      arrCall(env, service, service.type === "tv" ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true"),
      arrCall(env, service, "api/v3/health")
    ]);
    const history = historyResult.status === "fulfilled" ? historyResult.value : [];
    const library = libraryResult.status === "fulfilled" ? libraryResult.value : [];
    const health = healthResult.status === "fulfilled" ? healthResult.value : [];
    const records = Array.isArray(history) ? history : Array.isArray(history?.records) ? history.records : [];
    const items = Array.isArray(library) ? library : [];
    const byId = new Map(items.map(item => [Number(item.id), item]));
    const imported = records.filter(record => /downloadfolderimported|downloaded|imported/i.test(String(record.eventType || record.event || ""))).map(record => {
      const media = byId.get(Number(service.type === "tv" ? (record.seriesId || record.data?.seriesId) : (record.movieId || record.data?.movieId))) || record.series || record.movie || {};
      const episode = record.episode || {};
      const poster = Array.isArray(media.images) ? media.images.find(image => String(image.coverType).toLowerCase() === "poster") : null;
      let posterUrl = String(poster?.remoteUrl || "");
      try { const u = new URL(posterUrl); if (u.protocol !== "https:" || !["image.tmdb.org", "artworks.thetvdb.com", "www.thetvdb.com"].includes(u.hostname)) posterUrl = ""; } catch { posterUrl = ""; }
      const season = Number(episode.seasonNumber ?? record.seasonNumber);
      const episodeNumber = Number(episode.episodeNumber ?? record.episodeNumber);
      const episodeTitle = String(episode.title || record.sourceTitle || record.data?.sourceTitle || "").slice(0, 180);
      return {
        serviceKey: service.key, serviceName: service.name, mediaType: service.type,
        title: String(media.title || record.series?.title || record.movie?.title || record.sourceTitle || "Recently downloaded").slice(0, 180),
        episodeTitle: service.type === "tv" ? episodeTitle : "",
        episodeLabel: service.type === "tv" && Number.isFinite(season) && Number.isFinite(episodeNumber) && (season > 0 || episodeNumber > 0) ? "S" + String(season).padStart(2,"0") + " · E" + String(episodeNumber).padStart(2,"0") : "",
        posterUrl, date: String(record.date || record.dateAdded || ""),
        event: String(record.eventType || record.event || "Imported")
      };
    });

    const historyEvents = records.filter(record => /fail|error/i.test(String(record.eventType || record.event || ""))).map(record => ({
      id: service.key + "-history-" + String(record.id || record.date || Math.random()),
      date: String(record.date || record.dateAdded || ""),
      type: "failure",
      title: String(record.eventType || record.event || "Media operation failed").replace(/([a-z])([A-Z])/g, "$1 $2"),
      detail: [service.name, record.sourceTitle || record.data?.sourceTitle || record.message || record.data?.message].filter(Boolean).join(" · ").slice(0, 500)
    }));

    const healthEvents = (Array.isArray(health) ? health : []).filter(issue => String(issue.type || "").toLowerCase() === "error" || String(issue.type || "").toLowerCase() === "warning").map(issue => ({
      id: service.key + "-health-" + String(issue.source || issue.message || issue.wikiUrl || ""),
      date: String(issue.lastExecution || issue.date || ""),
      type: String(issue.type).toLowerCase() === "error" ? "failure" : "warning",
      title: String(issue.source || "Health check").replace(/([a-z])([A-Z])/g, "$1 $2"),
      detail: service.name + " · " + String(issue.message || "Health check warning").slice(0, 450)
    }));
    return { items: imported, events: [...historyEvents, ...healthEvents] };
  }));

  const items = results.flatMap(result => result.items).sort((a,b) => Date.parse(b.date || 0) - Date.parse(a.date || 0)).slice(0, 40);
  const events = results.flatMap(result => result.events).sort((a,b) => Date.parse(b.date || 0) - Date.parse(a.date || 0)).slice(0, 40);
  return json({ items, events });
}

import { arrCall, arrServiceStatus, arrServices, imageUrl } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

// Upcoming episodes (Sonarr) and film releases (Radarr) for the Media hub's "Coming up" view.
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to view what's coming up." }, 401);

  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 14, 1), 60);
  const now = Date.now(), start = new Date(now - 86400000), end = new Date(now + days * 86400000);
  const range = "start=" + start.toISOString().slice(0, 10) + "&end=" + end.toISOString().slice(0, 10);

  const settled = await Promise.all(arrServices().map(async service => {
    if (!arrServiceStatus(env, service).configured) return [];
    try {
      if (service.type === "tv") {
        const episodes = await arrCall(env, service, "api/v3/calendar?" + range + "&unmonitored=false&includeSeries=true");
        return (Array.isArray(episodes) ? episodes : []).map(episode => ({
          serviceKey: service.key, serviceName: service.name, mediaType: "tv", kind: "episode",
          id: Number(episode.seriesId), episodeId: Number(episode.id),
          title: String(episode.series?.title || "Unknown show").slice(0, 180),
          episodeTitle: String(episode.title || "").slice(0, 180),
          code: "S" + String(episode.seasonNumber).padStart(2, "0") + "E" + String(episode.episodeNumber).padStart(2, "0"),
          date: String(episode.airDateUtc || episode.airDate || ""),
          network: String(episode.series?.network || "").slice(0, 80),
          hasFile: Boolean(episode.hasFile),
          posterUrl: imageUrl(episode.series, "poster"), fanartUrl: imageUrl(episode.series, "fanart")
        })).filter(item => item.id > 0 && item.date);
      }
      const movies = await arrCall(env, service, "api/v3/calendar?" + range + "&unmonitored=false");
      return (Array.isArray(movies) ? movies : []).flatMap(movie => {
        // a film can have several releases; list the ones inside the window
        return [["inCinemas", "In cinemas"], ["digitalRelease", "Digital release"], ["physicalRelease", "Blu-ray release"]]
          .filter(([field]) => { const t = Date.parse(movie[field] || ""); return t >= start.getTime() && t <= end.getTime(); })
          .map(([field, label]) => ({
            serviceKey: service.key, serviceName: service.name, mediaType: "movie", kind: field,
            id: Number(movie.id), title: String(movie.title || "Unknown film").slice(0, 180), episodeTitle: label, code: "",
            date: String(movie[field]), network: String(movie.studio || "").slice(0, 80), hasFile: Boolean(movie.hasFile),
            posterUrl: imageUrl(movie, "poster"), fanartUrl: imageUrl(movie, "fanart")
          }));
      }).filter(item => item.id > 0);
    } catch {
      return [];
    }
  }));
  const items = settled.flat().sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 400);
  return json({ items, days });
}

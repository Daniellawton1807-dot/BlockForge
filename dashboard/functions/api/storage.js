import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../_utils/downloads-auth.js";
import { arrCall, arrService, arrServiceStatus, arrServices, imageUrl } from "../_utils/arr.js";
import { arrDelete } from "../_utils/autopilot.js";

// Storage planner. GET: each real drive (as Sonarr/Radarr see them), a fill-up forecast from the last
// 30 days of imports, and suggestions of what could go (finished by everyone who can see it, never
// started, duplicated across Sonarr instances, oversized). Nothing is ever deleted automatically:
// POST {action: "delete", items: [{serviceKey, id}]} removes the titles Daniel picked, with their files.
const DAY = 86400 * 1000, GB = 1024 ** 3;
const WATCHED_IDLE_DAYS = 14, UNSTARTED_DAYS = 90, BIG_MOVIE = 40 * GB, BIG_EPISODE = 8 * GB;

async function watchData(env) {
  const token = String(env.TVBOT_TOKEN || "").trim(), bridge = env.ARR_BRIDGE;
  if (!token || !bridge) return null;
  try {
    const response = await bridge.fetch(new Request("https://homebase-arr-bridge/api/watchdata", { headers: { "x-homebase-service": "tvbot", "x-tv-token": token, accept: "application/json" } }));
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function drives(lists) {
  // the same filesystem shows up under several paths (/Server, /movies, /daniel tv...): group by size
  const groups = new Map();
  for (const disk of lists.flat()) {
    const total = Number(disk?.totalSpace) || 0, free = Number(disk?.freeSpace) || 0, path = String(disk?.path || "");
    if (total < 5 * GB || /^\/(config|etc|proc|sys|dev|run|boot)/.test(path)) continue;
    const key = Math.round(total / GB);
    const group = groups.get(key) || { total, free, paths: new Set() };
    group.free = Math.min(group.free, free); group.paths.add(path);
    groups.set(key, group);
  }
  return [...groups.values()].map(g => {
    const paths = [...g.paths].sort();
    const system = paths.includes("/") || paths.includes("/downloads");
    return {
      name: system ? "System disk" : "Media drive",
      note: system ? "Downloads land here before they're imported" : "Shows and films",
      kind: system ? "system" : "media",
      total: g.total, free: g.free, used: g.total - g.free, paths: paths.filter(p => p !== "/").slice(0, 6)
    };
  }).sort((a, b) => b.total - a.total);
}

const lastPlayed = viewers => Math.max(0, ...viewers.map(v => (v.last && Date.parse(v.last)) || 0));
const viewersText = viewers => viewers.map(v => v.user).join(", ");

export async function onRequest({ request, env }) {
  if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET, POST" });
  if (request.method === "POST" && !validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to see storage." }, 401);

  if (request.method === "POST") {
    let body;
    try { body = await readJsonBody(request, 8192); } catch { return json({ code: "invalid_request", error: "Could not read the request." }, 400); }
    const items = Array.isArray(body?.items) ? body.items.slice(0, 25) : [];
    if (body?.action !== "delete" || body?.confirm !== true || !items.length) return json({ code: "invalid_request", error: "Pick what to remove and confirm." }, 400);
    const done = [], failed = [];
    for (const item of items) {
      const service = arrService(item?.serviceKey), id = Number(item?.id);
      if (!service || !Number.isSafeInteger(id) || id <= 0 || !arrServiceStatus(env, service).configured) { failed.push("an unknown title"); continue; }
      try {
        const path = service.type === "tv" ? "api/v3/series/" + id + "?deleteFiles=true&addImportListExclusion=false" : "api/v3/movie/" + id + "?deleteFiles=true&addImportExclusion=false";
        await arrDelete(env, service, path);
        done.push(String(item.title || "").slice(0, 120) || service.name + " #" + id);
      } catch (error) { failed.push((String(item.title || "").slice(0, 120) || "#" + id) + " (" + error.message + ")"); }
    }
    return json({ ok: !failed.length, removed: done, failed }, failed.length && !done.length ? 502 : 200);
  }

  return json(await storageReport(env, { summary: new URL(request.url).searchParams.get("summary") === "1" }));
}

export async function storageReport(env, { summary = false } = {}) {
  const services = arrServices().filter(service => arrServiceStatus(env, service).configured);
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const [disks, histories, libraries, watched] = await Promise.all([
    Promise.all(services.map(s => arrCall(env, s, "api/v3/diskspace").catch(() => []))),
    Promise.all(services.map(s => arrCall(env, s, "api/v3/history/since?date=" + encodeURIComponent(since) + "&eventType=3").catch(() => null))),
    summary ? [] : Promise.all(services.map(s => arrCall(env, s, s.type === "tv" ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true").then(list => ({ service: s, list: Array.isArray(list) ? list : [] })).catch(() => ({ service: s, list: [] })))),
    summary ? null : watchData(env)
  ]);

  // ---- drives and forecast ----
  const driveList = drives(disks);
  const imports = histories.flatMap(h => Array.isArray(h) ? h : []);
  // anything imported lately, or still airing, is in active use: never suggest it as unwatched
  const recentImports = new Set();
  histories.forEach((h, n) => { for (const r of Array.isArray(h) ? h : []) if (Date.now() - Date.parse(r?.date || 0) < 30 * DAY) recentImports.add(services[n].key + ":" + (r.seriesId || r.movieId)); });
  const importedBytes = imports.reduce((sum, r) => sum + (Number(r?.data?.size) || 0), 0);
  const oldest = Math.min(Date.now(), ...imports.map(r => Date.parse(r?.date || 0) || Date.now()));
  const days = Math.max(7, Math.min(30, (Date.now() - oldest) / DAY));
  const perDay = importedBytes / days;
  const media = driveList.find(d => d.kind === "media");
  const forecast = {
    windowDays: Math.round(days), importedBytes, imports: imports.length, perDay,
    daysLeft: media && perDay > 0 ? Math.round(media.free / perDay) : null,
    history: histories.every(h => h === null) ? "unavailable" : "ok"
  };

  if (summary) return { updatedAt: new Date().toISOString(), drives: driveList, forecast };

  // ---- suggestions ----
  const views = new Map();
  for (const item of watched?.items || []) {
    if (item.tvdb) views.set("tv:" + item.tvdb, item.viewers);
    if (item.tmdb) views.set((item.type === "series" ? "tvtmdb:" : "movie:") + item.tmdb, item.viewers);
  }
  const now = Date.now(), entries = [];
  for (const { service, list } of libraries) {
    for (const x of list) {
      const size = Number(x.statistics?.sizeOnDisk ?? x.sizeOnDisk) || 0;
      if (!size) continue;
      const tv = service.type === "tv";
      const viewers = (tv ? views.get("tv:" + x.tvdbId) || views.get("tvtmdb:" + x.tmdbId) : views.get("movie:" + x.tmdbId)) || null;
      entries.push({
        key: service.key + ":" + x.id, serviceKey: service.key, serviceName: service.name, id: Number(x.id),
        mediaType: tv ? "tv" : "movie", title: String(x.title || "Untitled").slice(0, 160), year: Number(x.year) || null,
        size, added: String(x.added || ""), status: String(x.status || ""),
        active: recentImports.has(service.key + ":" + x.id) || (Date.parse(x.previousAiring || 0) > now - 60 * DAY), tvdbId: Number(x.tvdbId) || null,
        files: tv ? Number(x.statistics?.episodeFileCount) || 0 : 1, posterUrl: imageUrl(x, "poster"), viewers
      });
    }
  }
  const pick = (e, reason) => ({ key: e.key, serviceKey: e.serviceKey, serviceName: e.serviceName, id: e.id, mediaType: e.mediaType, title: e.title, year: e.year, size: e.size, posterUrl: e.posterUrl, reason });
  const groups = { watched: [], unstarted: [], duplicates: [], oversized: [] };
  for (const e of entries) {
    const v = e.viewers;
    if (v?.length && v.every(x => x.played) && !(e.mediaType === "tv" && e.active)) {
      const last = lastPlayed(v);
      if (e.mediaType === "tv" || !last || now - last > WATCHED_IDLE_DAYS * DAY) {
        groups.watched.push(pick(e, "Finished by " + viewersText(v) + (last ? " · last watched " + new Date(last).toISOString().slice(0, 10) : "") + (e.mediaType === "tv" && e.status === "continuing" ? " · still airing" : "")));
      }
    } else if (v?.length && !e.active && v.every(x => !x.started) && Date.parse(e.added) && now - Date.parse(e.added) > UNSTARTED_DAYS * DAY) {
      groups.unstarted.push(pick(e, "Not started by " + viewersText(v).replace(/, (?=[^,]*$)/, " or ") + " in the " + Math.round((now - Date.parse(e.added)) / (30 * DAY)) + " months since it was added"));
    }
    if (e.mediaType === "movie" ? e.size > BIG_MOVIE : e.files && e.size / e.files > BIG_EPISODE) {
      groups.oversized.push(pick(e, e.mediaType === "movie" ? "A very large copy for one film" : "About " + Math.round(e.size / e.files / GB) + " GB per episode"));
    }
  }
  const byTvdb = new Map();
  for (const e of entries) if (e.mediaType === "tv" && e.tvdbId) byTvdb.set(e.tvdbId, [...(byTvdb.get(e.tvdbId) || []), e]);
  for (const copies of byTvdb.values()) {
    if (copies.length < 2) continue;
    for (const e of copies) groups.duplicates.push(pick(e, "Also in " + copies.filter(c => c !== e).map(c => c.serviceName).join(", ") + " (a separate copy on disk)"));
  }
  for (const key of Object.keys(groups)) groups[key] = groups[key].sort((a, b) => b.size - a.size).slice(0, 40);

  return {
    updatedAt: new Date().toISOString(), drives: driveList, forecast, groups,
    watchData: watched ? "ok" : "unavailable"
  };
}

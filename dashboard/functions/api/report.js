import { json, loginConfigured, validSession } from "../_utils/downloads-auth.js";
import { arrCall, arrServiceStatus, arrServices } from "../_utils/arr.js";
import { RULES, loadState } from "../_utils/autopilot.js";
import { storageReport, watchData } from "./storage.js";

// The weekly report: what arrived, who watched what, what Autopilot fixed and where the disk is heading.
// Read-only; everything comes from Sonarr/Radarr history, Jellyfin watch data (via tvbot), Autopilot's log
// and the storage forecast.
const DAY = 86400 * 1000;

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to see the report." }, 401);

  const to = Date.now(), from = to - 7 * DAY, since = new Date(from).toISOString();
  const services = arrServices().filter(service => arrServiceStatus(env, service).configured);
  const [histories, state, storage, watched] = await Promise.all([
    Promise.all(services.map(s => arrCall(env, s, "api/v3/history/since?date=" + encodeURIComponent(since) + "&eventType=3&" + (s.type === "tv" ? "includeSeries=true" : "includeMovie=true")).catch(() => null))),
    loadState(env).catch(() => null),
    storageReport(env).catch(() => null),
    watchData(env)
  ]);

  // an episode or film counts once, even if it was imported again (an upgrade)
  const added = { episodes: 0, films: 0, bytes: 0, titles: new Map() };
  histories.forEach((h, n) => {
    const tv = services[n].type === "tv", seen = new Set();
    for (const r of Array.isArray(h) ? h : []) {
      const key = tv ? "e" + r.episodeId : "m" + r.movieId;
      if (seen.has(key)) continue; seen.add(key);
      if (tv) added.episodes++; else added.films++;
      added.bytes += Number(r?.data?.size) || 0;
      const title = String(r.series?.title || r.movie?.title || "").slice(0, 120);
      if (!title) continue;
      const t = added.titles.get(title) || { title, tv, count: 0, bytes: 0 };
      t.count++; t.bytes += Number(r?.data?.size) || 0; added.titles.set(title, t);
    }
  });
  const newTitles = [...added.titles.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 6);

  // who watched what this week, from each Jellyfin user's last-played dates
  const people = new Map(), shows = [];
  for (const item of watched?.items || []) {
    const viewers = (item.viewers || []).filter(v => Date.parse(v.last || 0) >= from);
    if (!viewers.length) continue;
    for (const v of viewers) people.set(v.user, (people.get(v.user) || 0) + 1);
    shows.push({ name: String(item.name || "").slice(0, 120), type: item.type, viewers: viewers.map(v => v.user), last: Math.max(...viewers.map(v => Date.parse(v.last))) });
  }
  shows.sort((a, b) => b.viewers.length - a.viewers.length || b.last - a.last);

  const fixes = (state?.log || []).filter(x => Date.parse(x.at) >= from);
  const byRule = {};
  for (const f of fixes) byRule[f.rule] = (byRule[f.rule] || 0) + 1;

  const media = storage?.drives?.find(d => d.kind === "media") || null;
  const reclaim = (storage?.groups?.watched || []);
  return json({
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    added: { episodes: added.episodes, films: added.films, bytes: added.bytes, titles: newTitles },
    watched: watched ? { titles: shows.length, people: [...people].map(([user, titles]) => ({ user, titles })).sort((a, b) => b.titles - a.titles), top: shows.slice(0, 6) } : null,
    autopilot: {
      total: fixes.length,
      rules: Object.keys(byRule).map(rule => ({ rule, title: RULES[rule]?.title || rule, count: byRule[rule] })),
      recent: fixes.slice(0, 8).map(f => ({ at: f.at, rule: f.rule, title: f.title, detail: f.detail }))
    },
    disk: media ? {
      total: media.total, free: media.free, used: media.used, daysLeft: storage.forecast.daysLeft, perDay: storage.forecast.perDay,
      monthBytes: storage.forecast.importedBytes, reclaimBytes: reclaim.reduce((n, x) => n + x.size, 0), reclaimTitles: reclaim.length
    } : null
  });
}

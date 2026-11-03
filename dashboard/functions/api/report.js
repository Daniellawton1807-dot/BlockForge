import { json, loginConfigured, validSession } from "../_utils/downloads-auth.js";
import { arrCall, arrServiceStatus, arrServices } from "../_utils/arr.js";
import { RULES, loadState } from "../_utils/autopilot.js";
import { storageReport } from "./storage.js";

// The weekly report: what arrived in the library, what Autopilot fixed, and where the disk is heading.
// Read-only; everything comes from Sonarr/Radarr history, Autopilot's log and the storage forecast.
const DAY = 86400 * 1000;

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to see the report." }, 401);

  const to = Date.now(), from = to - 7 * DAY, since = new Date(from).toISOString();
  const services = arrServices().filter(service => arrServiceStatus(env, service).configured);
  const [histories, state, storage] = await Promise.all([
    Promise.all(services.map(s => arrCall(env, s, "api/v3/history/since?date=" + encodeURIComponent(since) + "&eventType=3").catch(() => null))),
    loadState(env).catch(() => null),
    storageReport(env, { summary: true }).catch(() => null)
  ]);

  // an episode or film counts once, even if it was imported again
  const added = { episodes: 0, films: 0, bytes: 0, titles: new Map() };
  histories.forEach((h, n) => {
    const tv = services[n].type === "tv", seen = new Set();
    for (const r of Array.isArray(h) ? h : []) {
      const key = tv ? "e" + r.episodeId : "m" + r.movieId;
      if (seen.has(key)) continue; seen.add(key);
      if (tv) added.episodes++; else added.films++;
      added.bytes += Number(r?.data?.size) || 0;
      const title = String(r.series?.title || r.movie?.title || r.sourceTitle || "").slice(0, 120);
      if (title) added.titles.set(title, (added.titles.get(title) || 0) + 1);
    }
  });
  const top = [...added.titles].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, count]) => ({ title, count }));

  const fixes = (state?.log || []).filter(x => Date.parse(x.at) >= from);
  const byRule = {};
  for (const f of fixes) byRule[f.rule] = (byRule[f.rule] || 0) + 1;

  const media = storage?.drives?.find(d => d.kind === "media") || null;
  return json({
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    added: { episodes: added.episodes, films: added.films, bytes: added.bytes, top },
    autopilot: {
      total: fixes.length,
      rules: Object.keys(byRule).map(rule => ({ rule, title: RULES[rule]?.title || rule, count: byRule[rule] })),
      recent: fixes.slice(0, 8).map(f => ({ at: f.at, rule: f.rule, title: f.title, detail: f.detail }))
    },
    disk: media ? { total: media.total, free: media.free, daysLeft: storage.forecast.daysLeft, perDay: storage.forecast.perDay } : null
  });
}

// What's worth a phone notification since Autopilot last looked. Called at the end of each Autopilot pass.
// The first pass only records where things stand, so turning this on never sends a flood of old news.
import { arrCall } from "./arr.js";
import { bridgePush } from "../api/push.js";

const MAX_PER_RUN = 5;
const MUM = /mum/i;
const code = (s, e) => "S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0");

async function tvbot(env, path) {
  if (!env.TVBOT_TOKEN || !env.ARR_BRIDGE) return null;
  const r = await env.ARR_BRIDGE.fetch(new Request("https://homebase-arr-bridge/" + path, { headers: { "x-homebase-service": "tvbot", "x-tv-token": env.TVBOT_TOKEN, accept: "application/json" } }));
  return r.ok ? r.json().catch(() => null) : null;
}

export async function notify(env, state, { services, queue, needsYou }) {
  const p = state.push || (state.push = {});
  const now = new Date().toISOString(), since = p.since;
  const out = [];   // {type, title, body, url, tag}

  // 1. ready to watch: your shows and films imported since last time (Mum's are left to Mum)
  // 2. Mum requested something: new series in her Sonarr, new films in her Radarr folder
  const imported = new Map(), requested = [];
  for (const service of services) {
    const tv = service.type === "tv";
    try {
      if (since) {
        if (service.key === "sonarr-daniel" || service.key === "sonarr-extra" || !tv) {
          const rows = await arrCall(env, service, "api/v3/history/since?date=" + encodeURIComponent(since) + "&eventType=3" + (tv ? "&includeSeries=true&includeEpisode=true" : "&includeMovie=true"));
          for (const h of Array.isArray(rows) ? rows : []) {
            if (!tv && MUM.test(h.movie?.path || h.movie?.rootFolderPath || "")) continue;
            const name = tv ? h.series?.title : h.movie?.title; if (!name) continue;
            const key = service.key + ":" + (tv ? "s" + h.seriesId : "m" + h.movieId);
            const g = imported.get(key) || { name, tv, eps: [], id: tv ? h.seriesId : h.movieId, service };
            if (tv && h.episode) g.eps.push(code(h.episode.seasonNumber, h.episode.episodeNumber));
            imported.set(key, g);
          }
        }
        if (service.key === "sonarr-mum" || !tv) {
          const items = await arrCall(env, service, tv ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true");
          for (const i of Array.isArray(items) ? items : []) {
            if (Date.parse(i.added || 0) <= Date.parse(since)) continue;
            if (!tv && !MUM.test(i.rootFolderPath || i.path || "")) continue;
            requested.push({ title: i.title, tv });
          }
        }
      }
    } catch { /* one service down shouldn't stop the rest */ }
  }
  for (const g of imported.values()) {
    const eps = [...new Set(g.eps)].sort();
    out.push({ type: "ready", tag: "ready-" + g.service.key + "-" + g.id, url: "/media/#library",
      title: g.tv ? (eps.length === 1 ? `${g.name} ${eps[0]} is ready` : `${eps.length || "New"} episodes of ${g.name} are ready`) : `${g.name} is ready`,
      body: g.tv && eps.length > 1 ? eps.slice(0, 6).join(", ") + (eps.length > 6 ? " and more" : "") + " · ready to watch" : "Ready to watch on Jellyfin." });
  }
  for (const r of requested) out.push({ type: "requests", tag: "mum-" + r.title, url: "/media/#downloads", title: `Mum requested ${r.title}`, body: r.tv ? "A show for Mum's TV. It's downloading now." : "A film for Mum. It's downloading now." });

  // 3. a download needs you: blocked imports, and anything Autopilot couldn't sort out
  const needs = new Map();
  for (const q of queue || []) if (q.state === "importblocked") needs.set("q:" + q.service.key + ":" + q.id, { title: q.title, reason: "Import is blocked." });
  for (const n of needsYou || []) needs.set("n:" + n.title, { title: n.title, reason: n.reason });
  const seen = new Set(p.needs || []);
  if (since) for (const [k, n] of needs) if (!seen.has(k)) out.push({ type: "attention", tag: "needs-" + k.slice(0, 40), url: "/media/#downloads", title: `${n.title} needs you`, body: String(n.reason || "Open Downloads to fix it.").slice(0, 200) });
  p.needs = [...needs.keys()].slice(0, 100);

  // 4. disk nearly full (once, until it drops back under 85%)
  try {
    const radarr = services.find(s => s.type === "movie") || services[0];
    const disks = radarr ? await arrCall(env, radarr, "api/v3/diskspace") : [];
    const media = (Array.isArray(disks) ? disks : []).filter(d => Number(d.totalSpace) > 1e12).sort((a, b) => b.totalSpace - a.totalSpace)[0];
    if (media) {
      const used = 100 * (1 - media.freeSpace / media.totalSpace);
      if (used >= 90 && !p.diskAlert && since) out.push({ type: "disk", tag: "disk", url: "/", urgent: true, title: `Media drive ${Math.round(used)}% full`, body: `${(media.freeSpace / 1e12).toFixed(1)} TB left. Open the storage planner to free space.` });
      if (used >= 90) p.diskAlert = true; else if (used < 85) p.diskAlert = false;
    }
  } catch {}

  // 5. Minecraft server stopped (it was running last time we looked)
  try {
    const mc = await tvbot(env, "api/minecraft");
    if (mc && typeof mc.running === "boolean") {
      if (p.mcRunning === true && !mc.running && since) out.push({ type: "minecraft", tag: "minecraft", url: "/minecraft/", title: "Minecraft server stopped", body: "Start it again from the Minecraft page." });
      p.mcRunning = mc.running;
    }
  } catch {}

  p.since = now;
  if (!out.length) return 0;
  const send = out.slice(0, MAX_PER_RUN);
  if (out.length > MAX_PER_RUN) send.push({ type: out[MAX_PER_RUN].type, tag: "more", url: "/", title: `${out.length - MAX_PER_RUN} more updates`, body: "Open Homebase to see everything." });
  let sent = 0;
  for (const m of send) { try { sent += (await bridgePush(env, "push/send", m)).sent || 0; } catch { break; } }
  return sent;
}

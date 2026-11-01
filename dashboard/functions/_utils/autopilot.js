// Autopilot: fixes the routine download problems by itself and says plainly what it couldn't fix.
// Runs every 15 minutes (the bridge Worker's cron calls /api/autopilot/run) or on demand from the
// Media hub. Settings, the action log and the re-search back-off live in the Worker's KV, reached
// over the private ARR_BRIDGE binding. It never deletes library files: it only removes queue items.
import { arrCall, arrServiceStatus, arrServices } from "./arr.js";

const BRIDGE = "ARR_BRIDGE";
const DEFAULT_QBITTORRENT_URL = "https://qb.danielvault.uk";
const HOUR = 3600 * 1000;
const BACKOFF = [HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR, 168 * HOUR];   // an hour after it goes missing, then 6 h, a day, 3 days, then weekly
const MAX_LOG = 150, MAX_FIXES_PER_RUN = 6, MAX_SEARCHES_PER_SERVICE = 10;

export const RULES = {
  stalled: { title: "Replace stalled downloads", detail: "A torrent with no progress for a while, or a failed Usenet job, is blocklisted and Sonarr/Radarr look for another release." },
  importBlocked: { title: "Clear stuck imports", detail: "\"Not an upgrade\" is removed from the queue; samples, missing video and suspicious files are blocklisted and replaced. Anything else is listed under Needs you." },
  research: { title: "Search again for missing episodes", detail: "Monitored episodes and films that aired but never downloaded are searched again after 1 hour, 6 hours and a day, then less often (3 days, then weekly)." },
  upgrade: { title: "Upgrade the library overnight", detail: "Each night (3–5 am) up to 10 episodes and 2 films below your quality target are searched for a better copy, a few at a time so downloads never pile up. Anything tried waits three weeks before its next turn." }
};
export const DEFAULT_SETTINGS = { rules: { stalled: true, importBlocked: true, research: true, upgrade: true }, stallMinutes: 30 };
const UPGRADE_EPISODES = 10, UPGRADE_FILMS = 2, UPGRADE_RETRY = 21 * 24 * HOUR, UPGRADE_HOURS = [3, 4, 5], UPGRADE_BUSY_QUEUE = 5;
export const STALL_CHOICES = [15, 30, 60, 120, 240];

// ---------- state in the Worker's KV ----------
async function bridge(env, path, init = {}) {
  const binding = env[BRIDGE];
  if (!binding || typeof binding.fetch !== "function") throw new Error("Private bridge binding " + BRIDGE + " is not configured.");
  return binding.fetch(new Request("https://homebase-arr-bridge/" + path, {
    ...init, headers: { "x-homebase-service": "autopilot", ...(init.headers || {}) }
  }));
}
export async function loadState(env) {
  const response = await bridge(env, "state");
  if (!response.ok) throw new Error("Autopilot storage returned HTTP " + response.status + ".");
  const state = await response.json().catch(() => ({}));
  const saved = state.settings || {};
  return {
    // a stall time only counts once someone has chosen it in the Autopilot tab (older saves carried the old 60 by default)
    settings: { ...DEFAULT_SETTINGS, ...saved, rules: { ...DEFAULT_SETTINGS.rules, ...(saved.rules || {}) },
      stallMinutes: saved.stallChosen && STALL_CHOICES.includes(Number(saved.stallMinutes)) ? Number(saved.stallMinutes) : DEFAULT_SETTINGS.stallMinutes },
    log: Array.isArray(state.log) ? state.log : [],
    backoff: state.backoff && typeof state.backoff === "object" ? state.backoff : {},
    upgradeDay: state.upgradeDay || "",
    upgradeTried: state.upgradeTried && typeof state.upgradeTried === "object" ? state.upgradeTried : {},
    lastRun: state.lastRun || null
  };
}
export async function saveState(env, state) {
  state.log = state.log.slice(0, MAX_LOG);
  const response = await bridge(env, "state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state) });
  if (!response.ok) throw new Error("Autopilot storage returned HTTP " + response.status + ".");
}
export async function verifyRunToken(env, token) {
  if (!token || token.length > 256) return false;
  const response = await bridge(env, "verify", { method: "POST", headers: { "x-autopilot-token": token } }).catch(() => null);
  return Boolean(response?.ok);
}

// ---------- Sonarr/Radarr messages in plain English ----------
const REASONS = [
  [/not an upgrade|not a (quality |custom format )?upgrade|same or better|existing file .* (meets|better)/i, "You already have this in the same or better quality."],
  [/sample/i, "Only a sample clip was found, not the real thing."],
  [/no files found are eligible|no video files?|contains no video/i, "There was no video file in the download."],
  [/dangerous|executable|\.(exe|lnk|scr|bat|cmd)\b/i, "The download had a suspicious program file instead of video."],
  [/matched to (series|movie) by id|unknown (series|movie)|title mismatch|unable to (identify|parse)|couldn'?t (parse|match)|was not found in the grabbed release|not.*expected episode/i, "Sonarr/Radarr couldn't tell which episode or film this is. Use Manual Import in their Activity page."],
  [/(free|disk) space|not enough space/i, "Not enough disk space to import it."],
  [/permission|access .*denied|read-?only/i, "Couldn't write to the media folder (a permissions problem)."],
  [/locked|in use by another/i, "The file is locked by another program; it will retry."],
  [/stalled|no connections/i, "Stalled: nobody is sharing this release right now."],
  [/unpack|extract|password|encrypted/i, "The download couldn't be unpacked (a password or a broken archive)."],
  [/missing articles|incomplete|aborted|failed/i, "The download failed or came through incomplete."],
  [/not wanted in profile|quality .* not (wanted|allowed)/i, "This quality isn't allowed by the title's quality profile."]
];
export function plainReason(messages) {
  const text = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).join(" · ");
  if (!text) return "";
  for (const [pattern, reason] of REASONS) if (pattern.test(text)) return reason;
  return text.slice(0, 200);
}
const NOT_UPGRADE = /not an upgrade|not a (quality |custom format )?upgrade|same or better|existing file .* (meets|better)/i;
const JUNK = /sample|no files found are eligible|no video files?|contains no video|dangerous|executable|\.(exe|lnk|scr|bat|cmd)\b/i;

// ---------- reading the queues ----------
async function qbit(env) {
  const username = String(env.QBITTORRENT_USERNAME || ""), password = String(env.QBITTORRENT_PASSWORD || "");
  if (!username || !password) throw new Error("qBittorrent credentials are not configured.");
  const root = new URL(String(env.QBITTORRENT_BASE_URL || DEFAULT_QBITTORRENT_URL).replace(/\/+$/, "") + "/");
  const headers = { origin: root.origin, referer: root.href };
  const login = await fetch(new URL("api/v2/auth/login", root), {
    method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(), signal: AbortSignal.timeout(7000), redirect: "manual"
  });
  const sid = (login.headers.get("set-cookie") || "").match(/(?:^|[,;\s])SID=([^;,\s]+)/)?.[1];
  if (!login.ok || !sid) throw new Error("qBittorrent login failed.");
  const get = async path => {
    const r = await fetch(new URL(path, root), { headers: { ...headers, cookie: "SID=" + sid }, signal: AbortSignal.timeout(7000), redirect: "manual" });
    if (!r.ok) throw new Error("qBittorrent returned HTTP " + r.status + ".");
    return r.json();
  };
  const [torrents, transfer] = await Promise.all([get("api/v2/torrents/info?filter=all"), get("api/v2/transfer/info")]);
  return { torrents: Array.isArray(torrents) ? torrents : [], connection: String(transfer?.connection_status || "") };
}

async function queueOf(env, service) {
  const include = service.type === "tv" ? "&includeSeries=true&includeEpisode=true" : "&includeMovie=true";
  const response = await arrCall(env, service, "api/v3/queue?page=1&pageSize=200" + include);
  const records = Array.isArray(response?.records) ? response.records : [];
  return records.map(r => {
    const ep = r.episode, name = service.type === "tv" ? r.series?.title : r.movie?.title;
    const code = ep ? " S" + String(ep.seasonNumber).padStart(2, "0") + "E" + String(ep.episodeNumber).padStart(2, "0") : "";
    const messages = (Array.isArray(r.statusMessages) ? r.statusMessages : []).flatMap(m => [m?.title, ...(Array.isArray(m?.messages) ? m.messages : [])])
      .concat(r.errorMessage ? [r.errorMessage] : []).filter(Boolean).map(m => String(m).slice(0, 300));
    return {
      service, id: Number(r.id), downloadId: String(r.downloadId || "").toLowerCase(), protocol: String(r.protocol || ""),
      title: name ? String(name).slice(0, 160) + code : String(r.title || "Download").slice(0, 200), release: String(r.title || ""),
      state: String(r.trackedDownloadState || "").toLowerCase(), health: String(r.trackedDownloadStatus || "").toLowerCase(),
      status: String(r.status || "").toLowerCase(), episodeId: Number(r.episodeId) || 0, movieId: Number(r.movieId) || 0,
      added: String(r.added || ""), messages: [...new Set(messages)]
    };
  });
}

// a DELETE that worked but answered with an empty body still counts as done
export async function arrDelete(env, service, path) {
  try { await arrCall(env, service, path, { method: "DELETE" }); }
  catch (error) { if (error?.code !== "invalid_upstream_response") throw error; }
}
async function removeFromQueue(env, record, { blocklist, redownload }) {
  const query = "removeFromClient=true&blocklist=" + Boolean(blocklist) + "&skipRedownload=" + !redownload;
  await arrDelete(env, record.service, "api/v3/queue/" + record.id + "?" + query);
}

// ---------- one pass ----------
export async function runAutopilot(env, trigger) {
  const state = await loadState(env);
  const { rules, stallMinutes } = state.settings;
  const now = Date.now(), at = new Date(now).toISOString();
  const services = arrServices().filter(service => arrServiceStatus(env, service).configured);
  const fixed = [], needsYou = [], notes = [];
  const log = (rule, title, detail, service) => fixed.push({ at, rule, title, detail, service: service?.name || "" });

  const [queues, qb] = await Promise.all([
    Promise.all(services.map(service => queueOf(env, service).catch(error => { notes.push(service.name + ": " + error.message); return []; }))),
    qbit(env).catch(error => { notes.push("qBittorrent: " + error.message); return null; })
  ]);
  const queue = queues.flat();
  const handled = new Set();   // one action per download, even when a season pack has a queue entry per episode
  let budget = MAX_FIXES_PER_RUN;
  const act = async (record, options, rule, detail) => {
    if (!budget || handled.has(record.downloadId || record.id)) return;
    handled.add(record.downloadId || record.id); budget--;
    try { await removeFromQueue(env, record, options); log(rule, record.title, detail, record.service); }
    catch (error) { needsYou.push({ title: record.title, reason: "Autopilot couldn't remove it: " + error.message, service: record.service.name }); }
  };

  // 1. stalled torrents and failed Usenet jobs
  if (rules.stalled) {
    const torrents = new Map((qb?.torrents || []).map(t => [String(t.hash || "").toLowerCase(), t]));
    const incomplete = (qb?.torrents || []).filter(t => Number(t.progress) < 1 && !/^(paused|stopped)/i.test(t.state || ""));
    const stalledNow = incomplete.filter(t => ["stalledDL", "metaDL"].includes(t.state));
    // if qBittorrent has no connection (VPN down) every torrent looks stalled: fix the connection, not the releases
    const offline = qb && (qb.connection === "disconnected" || (incomplete.length >= 3 && stalledNow.length === incomplete.length));
    if (offline) needsYou.push({ title: "qBittorrent", reason: qb.connection === "disconnected" ? "qBittorrent has no internet connection (is the VPN, gluetun, down?). Stalled torrents were left alone." : "Every torrent is stalled at once, which usually means a connection problem rather than bad releases. Left them alone.", service: "qBittorrent" });
    for (const record of queue) {
      const failed = record.state === "failedpending" || record.state === "failed" || record.status === "failed";
      if (failed) { await act(record, { blocklist: true, redownload: true }, "stalled", (plainReason(record.messages) || "The download failed.") + " Blocklisted it and searched for another release."); continue; }
      const t = torrents.get(record.downloadId);
      if (!t || offline || !["stalledDL", "metaDL"].includes(t.state) || Number(t.progress) >= 1) continue;
      const lastSeen = Math.max(Number(t.last_activity) || 0, Number(t.added_on) || 0) * 1000;
      const minutes = Math.round((now - lastSeen) / 60000);
      if (lastSeen && minutes >= stallMinutes) {
        const pct = Math.round(Number(t.progress) * 100);
        await act(record, { blocklist: true, redownload: true }, "stalled", (t.state === "metaDL" ? "Never found anyone sharing it" : "Stuck at " + pct + "%") + " for " + (minutes >= 120 ? Math.round(minutes / 60) + " hours" : minutes + " minutes") + ". Blocklisted it and searched for another release.");
      }
    }
  }

  // 2. imports that are blocked or waiting with a warning
  for (const record of queue) {
    if (handled.has(record.downloadId || record.id)) continue;
    const stuck = record.state === "importblocked" || (record.state === "importpending" && record.health !== "ok" && record.messages.length);
    if (!stuck) continue;
    const text = record.messages.join(" · ");
    if (rules.importBlocked && NOT_UPGRADE.test(text)) await act(record, { blocklist: false, redownload: false }, "importBlocked", "You already had it in the same or better quality, so it was removed from the queue.");
    else if (rules.importBlocked && JUNK.test(text)) await act(record, { blocklist: true, redownload: true }, "importBlocked", plainReason(text).replace(/\.$/, "") + ". Blocklisted it and searched for another release.");
    else if (!needsYou.some(n => n.title === record.title)) needsYou.push({ title: record.title, reason: plainReason(text) || "Import is blocked.", detail: text.slice(0, 300), service: record.service.name });
  }

  // 3. aired but never downloaded: search again with back-off
  const stillMissing = new Set();
  if (rules.research) {
    const queued = new Set(queue.map(r => r.service.key + ":" + (r.episodeId ? "e" + r.episodeId : "m" + r.movieId)));
    for (const service of services) {
      try {
        const tv = service.type === "tv";
        const page = await arrCall(env, service, tv
          ? "api/v3/wanted/missing?page=1&pageSize=100&monitored=true&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true"
          : "api/v3/wanted/missing?page=1&pageSize=100&monitored=true");
        const records = (Array.isArray(page?.records) ? page.records : []).filter(r => tv
          ? Date.parse(r.airDateUtc || 0) && Date.parse(r.airDateUtc) < now - HOUR
          : r.isAvailable !== false);
        const due = [];
        for (const r of records) {
          const key = service.key + ":" + (tv ? "e" : "m") + r.id;
          if (queued.has(key)) continue;
          stillMissing.add(key);
          const entry = state.backoff[key] || (state.backoff[key] = { tries: 0, next: now + BACKOFF[0] });
          if (entry.next <= now && due.length < MAX_SEARCHES_PER_SERVICE) due.push({ r, key, entry });
        }
        if (!due.length) continue;
        await arrCall(env, service, "api/v3/command", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(tv ? { name: "EpisodeSearch", episodeIds: due.map(d => d.r.id) } : { name: "MoviesSearch", movieIds: due.map(d => d.r.id) })
        });
        for (const d of due) { d.entry.tries++; d.entry.next = now + BACKOFF[Math.min(d.entry.tries, BACKOFF.length - 1)]; }
        const names = due.map(d => tv ? (d.r.series?.title || "Episode") + " S" + String(d.r.seasonNumber).padStart(2, "0") + "E" + String(d.r.episodeNumber).padStart(2, "0") : d.r.title || "Film");
        log("research", due.length === 1 ? names[0] : due.length + (tv ? " missing episodes" : " missing films"),
          (due.length === 1 ? "Searched again" : "Searched again for " + names.slice(0, 6).join(", ") + (names.length > 6 ? " and " + (names.length - 6) + " more" : "")) + ".", service);
      } catch (error) { notes.push(service.name + ": " + error.message); }
    }
  }
  // forget back-off for things that turned up (or stopped being wanted); keep it when the rule is off or a lookup failed
  if (rules.research && !notes.length) for (const key of Object.keys(state.backoff)) if (!stillMissing.has(key)) delete state.backoff[key];

  // 4. overnight upgrades: a few titles below the quality target each night, worked through over the weeks
  const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const part = type => london.find(x => x.type === type)?.value || "";
  const today = part("year") + "-" + part("month") + "-" + part("day");
  if (rules.upgrade && UPGRADE_HOURS.includes(Number(part("hour"))) && state.upgradeDay !== today) {
    for (const [key, at] of Object.entries(state.upgradeTried)) if (now - at > UPGRADE_RETRY) delete state.upgradeTried[key];
    if (queue.length > UPGRADE_BUSY_QUEUE) {
      notes.push("Overnight upgrades skipped: " + queue.length + " downloads already in the queue.");
    } else {
      const queued = new Set(queue.map(r => r.service.key + ":" + (r.episodeId ? "e" + r.episodeId : "m" + r.movieId)));
      const lists = [];
      for (const service of services) {
        try {
          const tv = service.type === "tv";
          const page = await arrCall(env, service, "api/v3/wanted/cutoff?page=1&pageSize=100&monitored=true" + (tv ? "&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true" : ""));
          const picks = (Array.isArray(page?.records) ? page.records : [])
            .map(r => ({ r, key: service.key + ":" + (tv ? "e" : "m") + r.id }))
            .filter(x => !queued.has(x.key) && !state.upgradeTried[x.key]);
          lists.push({ service, tv, picks });
        } catch (error) { notes.push(service.name + ": " + error.message); }
      }
      // share the episode budget across the Sonarr instances in turn; films come from Radarr
      const chosen = new Map();
      const take = (filter, budget) => {
        let left = budget, progress = true;
        while (left > 0 && progress) {
          progress = false;
          for (const l of lists.filter(filter)) {
            const next = l.picks.shift(); if (!next || left <= 0) continue;
            if (!chosen.has(l)) chosen.set(l, []);
            chosen.get(l).push(next); left--; progress = true;
          }
        }
      };
      take(l => l.tv, UPGRADE_EPISODES); take(l => !l.tv, UPGRADE_FILMS);
      for (const [l, picked] of chosen) {
        try {
          await arrCall(env, l.service, "api/v3/command", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(l.tv ? { name: "EpisodeSearch", episodeIds: picked.map(p => p.r.id) } : { name: "MoviesSearch", movieIds: picked.map(p => p.r.id) })
          });
          for (const p of picked) state.upgradeTried[p.key] = now;
          const names = picked.map(p => l.tv ? (p.r.series?.title || "Episode") + " S" + String(p.r.seasonNumber).padStart(2, "0") + "E" + String(p.r.episodeNumber).padStart(2, "0") : p.r.title || "Film");
          log("upgrade", picked.length === 1 ? names[0] : picked.length + (l.tv ? " episodes" : " films"),
            "Looked for a better copy of " + names.slice(0, 6).join(", ") + (names.length > 6 ? " and " + (names.length - 6) + " more" : "") + ".", l.service);
        } catch (error) { notes.push(l.service.name + ": " + error.message); }
      }
      state.upgradeDay = today;
    }
  }

  state.log = [...fixed.reverse(), ...state.log];
  state.lastRun = { at, trigger, fixed: fixed.length, checked: queue.length, needsYou: needsYou.slice(0, 30), notes: notes.slice(0, 8), waiting: stillMissing.size };
  await saveState(env, state);
  return state;
}

export function publicState(state) {
  return { rules: RULES, settings: state.settings, log: state.log.slice(0, 60), lastRun: state.lastRun };
}

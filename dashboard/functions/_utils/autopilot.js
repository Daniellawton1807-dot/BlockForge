// Autopilot: fixes the routine download problems by itself and says plainly what it couldn't fix.
// Runs every 15 minutes (the bridge Worker's cron calls /api/autopilot/run) or on demand from the
// Media hub. Settings, the action log and the re-search back-off live in the Worker's KV, reached
// over the private ARR_BRIDGE binding. It never deletes library files: it only removes queue items.
import { arrCall, arrServiceStatus, arrServices } from "./arr.js";
import { notify } from "./notify.js";

const BRIDGE = "ARR_BRIDGE";
const DEFAULT_QBITTORRENT_URL = "https://qb.danielvault.uk";
const HOUR = 3600 * 1000;
const BACKOFF = [HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR, 168 * HOUR];   // an hour after it goes missing, then 6 h, a day, 3 days, then weekly
const MAX_TRIES = 3, FAIL_WINDOW = 72 * HOUR, MAX_LOG = 150, MAX_FIXES_PER_RUN = 6, MAX_SEARCHES_PER_SERVICE = 10;

export const RULES = {
  stalled: { title: "Replace stalled downloads", detail: "A torrent with no progress for a while, or a failed Usenet job, is blocklisted and Sonarr/Radarr look for another release." },
  importBlocked: { title: "Clear stuck imports", detail: "\"Not an upgrade\" and already-imported copies are removed from the queue; samples, missing video and suspicious files are blocklisted and replaced. Anything else is listed under Needs you." },
  retryFailed: { title: "Retry failed downloads with another release", detail: "When a download fails (a broken Usenet file, an archive that won't unpack, a dead torrent) Autopilot works out why, blocklists that release and tries a different one, up to 3 releases in all. If those fail too, or no other release exists, it stops and tries again later as more releases appear. A failed upgrade attempt on something you already have is just ignored." },
  autoImport: { title: "Import stuck downloads by itself", detail: "When Sonarr/Radarr can't tell which episode or film a finished download is, Autopilot does the Manual Import for you: it matches files to the episode in the queue (or by the S01E02 in the file name) and imports them. Locked or unreachable files are retried. Only what it can't match safely is listed under Needs you." },
  research: { title: "Search again for missing episodes", detail: "Monitored episodes and films that aired but never downloaded are searched again after 1 hour, 6 hours and a day, then less often (3 days, then weekly)." },
  upgrade: { title: "Upgrade the library overnight", detail: "Each night (3–5 am) up to 10 episodes and 2 films below your quality target are searched for a better copy, a few at a time so downloads never pile up. Anything tried waits three weeks before its next turn." }
};
export const DEFAULT_SETTINGS = { rules: { stalled: true, importBlocked: true, autoImport: true, retryFailed: true, research: true, upgrade: true }, stallMinutes: 30 };
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
    failSeen: Array.isArray(state.failSeen) ? state.failSeen : null,
    redownloadOff: state.redownloadOff && typeof state.redownloadOff === "object" ? state.redownloadOff : {},
    importTried: state.importTried && typeof state.importTried === "object" ? state.importTried : {},
    push: state.push && typeof state.push === "object" ? state.push : {},
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
  [/repair failed|not enough repair blocks|par2|missing articles|article.*(not found|missing)|too many .*missing/i, "The Usenet files were damaged or had missing parts, beyond repair."],
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
const ALREADY_THERE = /already (been )?imported|already exists|already has a file|episode file already|destination already exists/i;
const TBA_HOLD = /tba title|title.*\btba\b|recently aired/i;
const TRANSIENT = /locked|in use by another|being used by another|path does not exist|inaccessible|not accessible|no such file|temporar|try again|timed out/i;
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts)$/i;
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

// how good a copy is: resolution, then WEB/Blu-ray over TV captures, then custom-format score, then size
export function qualityRank(quality, score, size) {
  const q = quality?.quality || quality || {}, source = String(q.source || q.name || "").toLowerCase();
  return (Number(q.resolution) || 0) * 1e12 + (/web|blu/.test(source) ? 1 : 0) * 1e11 + (Number(score) || 0) * 1e9 + Math.min(Number(size) || 0, 9e8);
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
      quality: r.quality, rank: qualityRank(r.quality, r.customFormatScore, r.size), seriesId: Number(r.seriesId) || 0, season: ep ? Number(ep.seasonNumber) : null, episode: ep ? Number(ep.episodeNumber) : null,
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

// Manual Import done by Autopilot: only files it can match with certainty (the queue entry's own episode or film, or the S01E02 in the
// file name against that download's episodes). Returns how many files it imported; the rest is left for the person.
export async function manualImport(env, group) {
  const { service, downloadId } = group[0], tv = service.type === "tv";
  const found = await arrCall(env, service, "api/v3/manualimport?downloadId=" + encodeURIComponent(downloadId) + "&filterExistingFiles=false");
  const files = (Array.isArray(found) ? found : []).filter(c => VIDEO.test(String(c.path || "")) && !/(^|[\\/._ -])sample([\\/._ -]|$)/i.test(String(c.path || "")) && Number(c.size) > 20e6);
  if (!files.length) return 0;
  const out = [];
  if (tv) {
    const byCode = new Map(group.filter(r => r.season != null).map(r => [r.season + "x" + r.episode, r]));
    for (const c of files) {
      const m = /s(\d{1,2})[ ._-]?e(\d{1,3})/i.exec(c.path) || /\b(\d{1,2})x(\d{2,3})\b/i.exec(c.path);
      let rec = m ? byCode.get(Number(m[1]) + "x" + Number(m[2])) : null;
      if (!rec && group.length === 1 && files.length === 1) rec = group[0];   // one file for one queued episode
      if (rec) out.push({ path: c.path, quality: c.quality, languages: c.languages, releaseGroup: c.releaseGroup, downloadId, indexerFlags: c.indexerFlags || 0, seriesId: rec.seriesId, episodeIds: [rec.episodeId], releaseType: "singleEpisode" });
    }
  } else {
    const movieId = group[0].movieId, sorted = [...files].sort((a, b) => Number(b.size) - Number(a.size));
    if (movieId && (sorted.length === 1 || Number(sorted[0].size) > 3 * Number(sorted[1].size))) {   // the film itself, not a pile of similar files
      const c = sorted[0];
      out.push({ path: c.path, quality: c.quality, languages: c.languages, releaseGroup: c.releaseGroup, downloadId, indexerFlags: c.indexerFlags || 0, movieId });
    }
  }
  if (!out.length) return 0;
  await arrCall(env, service, "api/v3/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ManualImport", files: out, importMode: "auto" }) });
  return out.length;
}

// A failed download (broken Usenet file, bad archive, dead torrent): the release is already blocklisted; look for a different one,
// up to MAX_TRIES releases in all. Sonarr/Radarr's own automatic redownload is switched off (see ensureRedownloadOff) so this is the
// only thing retrying, and it can stop. When nothing else exists the item simply stays missing and the re-search rule tries again later.
async function failuresOf(env, service, item) {
  const tv = service.type === "tv";
  const events = await arrCall(env, service, tv ? "api/v3/history?page=1&pageSize=60&sortKey=date&sortDirection=descending&episodeId=" + item
    : "api/v3/history/movie?movieId=" + item);
  const since = Date.now() - FAIL_WINDOW;
  return (Array.isArray(events) ? events : events?.records || []).filter(e => /failed/i.test(String(e.eventType)) && Date.parse(e.date) >= since).length;
}
async function retryAfterFailure(env, service, item) {
  if (!item) return "";
  const tv = service.type === "tv", n = await failuresOf(env, service, item);
  if (n >= MAX_TRIES) return "That's " + n + " releases that have failed, so it's resting for now. Autopilot will search again later as more releases appear.";
  await arrCall(env, service, "api/v3/command", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(tv ? { name: "EpisodeSearch", episodeIds: [item] } : { name: "MoviesSearch", movieIds: [item] }) });
  return "Trying a different release (attempt " + (n + 1) + " of " + MAX_TRIES + ").";
}
async function ensureRedownloadOff(env, service, state, on, notes) {
  try {
    const cfg = await arrCall(env, service, "api/v3/config/downloadclient");
    const want = !on;   // rule on -> their own redownload off
    if (cfg && cfg.autoRedownloadFailed === want && cfg.autoRedownloadFailedFromInteractiveSearch === want) return;
    if (!on && !state.redownloadOff[service.key]) return;   // rule off and we never touched it: leave their setting alone
    await arrCall(env, service, "api/v3/config/downloadclient", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cfg, autoRedownloadFailed: want, autoRedownloadFailedFromInteractiveSearch: want }) });
    if (on) state.redownloadOff[service.key] = true; else delete state.redownloadOff[service.key];
  } catch (error) { notes.push(service.name + ": " + error.message); }
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
    const retry = Boolean(options.redownload && rules.retryFailed);   // failures are retried by Autopilot itself, capped
    try {
      await removeFromQueue(env, record, retry ? { ...options, redownload: false } : options);
      let more = "";
      if (retry) { try { more = " " + await retryAfterFailure(env, record.service, record.service.type === "tv" ? record.episodeId : record.movieId); } catch (error) { notes.push(record.service.name + ": " + error.message); } }
      log(rule, record.title, retry ? detail.replace(/ and searched for another release\./, ".") + more : detail, record.service);
    }
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

  // 1b. the same episode downloaded more than once (Sonarr keeps grabbing better releases while an import waits for the episode's
  // title): once every copy has finished, keep the best one and drop the extras from the queue and the download client
  if (rules.importBlocked) {
    const byEpisode = new Map();
    for (const r of queue) if (r.service.type === "tv" && r.episodeId) (byEpisode.get(r.service.key + ":" + r.episodeId) || byEpisode.set(r.service.key + ":" + r.episodeId, []).get(r.service.key + ":" + r.episodeId)).push(r);
    for (const copies of byEpisode.values()) {
      if (copies.length < 2 || copies.some(r => !["importpending", "importblocked"].includes(r.state))) continue;
      const keep = copies.reduce((a, b) => (b.rank > a.rank ? b : a));
      for (const r of copies) if (r !== keep && r.downloadId !== keep.downloadId)
        await act(r, { blocklist: false, redownload: false }, "importBlocked", "A better copy of the same episode had also finished downloading, so this extra copy was removed.");
    }
  }

  // 1c. downloads that failed on their own and left the queue (Usenet repair failed, unpack failed...): sort out what's wrong and retry
  for (const service of services) await ensureRedownloadOff(env, service, state, rules.retryFailed, notes);
  if (rules.retryFailed) {
    const firstRun = state.failSeen === null, seen = new Set(state.failSeen || []), queuedItems = new Set(queue.map(r => r.service.key + ":" + (r.episodeId || r.movieId)));
    const searched = new Set();
    for (const service of services) {
      try {
        const tv = service.type === "tv";
        const response = await arrCall(env, service, "api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending" + (tv ? "&includeEpisode=true" : "&includeMovie=true"));
        const records = Array.isArray(response) ? response : Array.isArray(response?.records) ? response.records : [];
        for (const e of records.filter(r => /failed/i.test(String(r.eventType))).reverse()) {
          const id = service.key + "#" + e.id;
          if (seen.has(id)) continue;
          seen.add(id);
          if (firstRun || Date.parse(e.date) < now - 6 * HOUR) continue;   // what happened before Autopilot looked is history
          const item = tv ? Number(e.episodeId) : Number(e.movieId), key = service.key + ":" + item;
          const label = tv ? (e.series?.title || "Download") + (e.episode ? " S" + String(e.episode.seasonNumber).padStart(2, "0") + "E" + String(e.episode.episodeNumber).padStart(2, "0") : "") : (e.movie?.title || "Download");
          const why = (plainReason(e.data?.message || e.data?.reason || "") || "The download failed.").replace(/\.$/, "");
          if (!item || searched.has(key) || queuedItems.has(key)) continue;   // a retry is already on its way
          searched.add(key);
          if ((tv ? e.episode?.hasFile : e.movie?.hasFile)) { log("retryFailed", label, "A download for this failed (" + why + "), but the copy you already have is fine, so nothing more to do.", service); continue; }
          if (!budget) continue; budget--;
          log("retryFailed", label, why + ". Blocklisted that release. " + await retryAfterFailure(env, service, item), service);
        }
      } catch (error) { notes.push(service.name + ": " + error.message); }
    }
    state.failSeen = [...seen].slice(-600);
  }

  // 2. imports that are blocked or waiting with a warning
  for (const record of queue) {
    if (handled.has(record.downloadId || record.id)) continue;
    const stuck = record.state === "importblocked" || (record.state === "importpending" && record.health !== "ok" && record.messages.length);
    if (!stuck) continue;
    const text = record.messages.join(" · ");
    if (rules.autoImport && record.downloadId && handled.has(record.service.key + ":" + record.downloadId)) continue;   // a pack, already dealt with
    if (handled.has(record.downloadId || record.id)) continue;                                                      // removed above
    const key = record.service.key + ":" + (record.downloadId || record.id), tries = state.importTried[key] || 0;
    if (rules.importBlocked && NOT_UPGRADE.test(text)) await act(record, { blocklist: false, redownload: false }, "importBlocked", "You already had it in the same or better quality, so it was removed from the queue.");
    else if (rules.importBlocked && ALREADY_THERE.test(text)) await act(record, { blocklist: false, redownload: false }, "importBlocked", "It was already imported, so the leftover copy was removed from the queue.");
    else if (rules.importBlocked && JUNK.test(text)) await act(record, { blocklist: true, redownload: true }, "importBlocked", plainReason(text).replace(/\.$/, "") + ". Blocklisted it and searched for another release.");
    else if (rules.autoImport && TRANSIENT.test(text) && tries < 4) {
      state.importTried[key] = tries + 1;
      if (!handled.has("scan:" + record.service.key)) {
        handled.add("scan:" + record.service.key);
        try { await arrCall(env, record.service, "api/v3/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ProcessMonitoredDownloads" }) }); log("autoImport", record.title, "It couldn't be read just then (" + plainReason(text).replace(/\.$/, "") + "). Asked " + record.service.name + " to try the import again.", record.service); }
        catch (error) { notes.push(record.service.name + ": " + error.message); }
      }
    }
    else if (rules.autoImport && tries < 2 && budget && !handled.has(record.service.key + ":" + record.downloadId) && record.downloadId && (record.seriesId || record.movieId)) {
      handled.add(record.service.key + ":" + record.downloadId);
      state.importTried[key] = tries + 1;
      const group = queue.filter(r => r.service === record.service && r.downloadId === record.downloadId);
      try {
        if (record.service.type === "tv") {   // never put a worse copy over what's already in the library
          const have = await arrCall(env, record.service, "api/v3/episode/" + record.episodeId);
          if (have?.hasFile && have.episodeFileId) {
            const file = await arrCall(env, record.service, "api/v3/episodefile/" + have.episodeFileId);
            if (qualityRank(file?.quality, 0, 0) >= qualityRank(record.quality, 0, 0)) {
              state.importTried[key] = 0;
              await act(record, { blocklist: false, redownload: false }, "importBlocked", "The library already has this episode in the same or better quality, so this copy was removed from the queue.");
              continue;
            }
          }
        }
        const n = await manualImport(env, group);
        if (n) { budget--; log("autoImport", record.title, "Sonarr/Radarr couldn't match it by itself, so Autopilot did the Manual Import (" + n + " file" + (n === 1 ? "" : "s") + ").", record.service); }
        else needsYou.push({ title: record.title, reason: plainReason(text) || "Import is blocked.", detail: "Autopilot couldn't match the files safely. " + text.slice(0, 260), service: record.service.name });
      } catch (error) { needsYou.push({ title: record.title, reason: "Autopilot's manual import didn't work: " + error.message, detail: text.slice(0, 300), service: record.service.name }); }
    }
    else if (!needsYou.some(n => n.title === record.title)) needsYou.push({ title: record.title, reason: plainReason(text) || "Import is blocked.", detail: text.slice(0, 300), service: record.service.name });
  }
  // forget the tries of downloads that have left the queue
  const inQueue = new Set(queue.map(r => r.service.key + ":" + (r.downloadId || r.id)));
  for (const k of Object.keys(state.importTried)) if (!inQueue.has(k)) delete state.importTried[k];

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

  // phone notifications for anything new since the last pass (never lets a push problem stop Autopilot)
  try { await notify(env, state, { services, queue, needsYou }); } catch (error) { notes.push("Notifications: " + error.message); }

  state.log = [...fixed.reverse(), ...state.log];
  state.lastRun = { at, trigger, fixed: fixed.length, checked: queue.length, needsYou: needsYou.slice(0, 30), notes: notes.slice(0, 8), waiting: stillMissing.size };
  await saveState(env, state);
  return state;
}

export function publicState(state) {
  return { rules: RULES, settings: state.settings, log: state.log.slice(0, 60), lastRun: state.lastRun };
}

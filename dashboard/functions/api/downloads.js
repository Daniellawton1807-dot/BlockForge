import { loginConfigured, validSession } from "../_utils/downloads-auth.js";
import { arrCall, arrServiceStatus, arrServices } from "../_utils/arr.js";
const DEFAULT_QBITTORRENT_URL = "https://qb.danielvault.uk";
const DEFAULT_SABNZBD_URL = "https://sab.danielvault.uk";
const MAX_ITEMS_PER_SOURCE = 30;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});
function serviceRoot(value, fallback) {
  const input = String(value || fallback).trim();
  const root = new URL(input);
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash) {
    throw new Error("Service URL must be HTTPS and cannot contain credentials.");
  }
  root.pathname = root.pathname.replace(/\/+$/, "") + "/";
  return root;
}

function apiUrl(root, path) {
  const prefix = root.pathname.replace(/\/+$/, "");
  return new URL(prefix + "/" + path.replace(/^\/+/, ""), root.origin);
}

async function readJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(7000),
    redirect: "manual"
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("The service redirected the API request.");
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/[\\r\\n\\t]+/g, " ").trim().slice(0, 240);
    throw new Error("The service returned HTTP " + response.status + (detail ? ": " + detail : ".") );
  }

  try {
    return await response.json();
  } catch {
    throw new Error("The service returned invalid JSON.");
  }
}

function mediaType(category) {
  const value = String(category || "").toLowerCase();
  if (value.includes("movie") || value.includes("film")) return "Movie";
  if (value.includes("tv") || value.includes("show") || value.includes("series")) return "TV show";
  return category ? String(category).slice(0, 40) : "Download";
}

function displayName(value) {
  return String(value || "Untitled download").replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}

function qbitState(value) {
  const states = {
    downloading: "Downloading",
    forcedDL: "Downloading",
    metaDL: "Getting metadata",
    queuedDL: "Queued",
    pausedDL: "Paused",
    stalledDL: "Stalled",
    checkingDL: "Checking",
    allocating: "Preparing",
    moving: "Moving"
  };
  return states[value] || (value ? String(value).slice(0, 32) : "In queue");
}

async function qbitItems(env) {
  const username = String(env.QBITTORRENT_USERNAME || "");
  const password = String(env.QBITTORRENT_PASSWORD || "");
  if (!username || !password) throw new Error("Set the protected qBittorrent username and password in Pages.");

  const root = serviceRoot(env.QBITTORRENT_BASE_URL, DEFAULT_QBITTORRENT_URL);
  const form = new URLSearchParams({ username, password });
  const login = await fetch(apiUrl(root, "api/v2/auth/login"), {
    method: "POST",
    headers: {
      accept: "text/plain",
      "content-type": "application/x-www-form-urlencoded",
      origin: root.origin,
      referer: root.href
    },
    body: form.toString(),
    signal: AbortSignal.timeout(7000),
    redirect: "manual"
  });
  if (login.status >= 300 && login.status < 400) throw new Error("qBittorrent redirected its login request.");
  const cookie = login.headers.get("set-cookie") || "";
  const sid = cookie.match(/(?:^|[,;\s])SID=([^;,\s]+)/)?.[1];
  const loginText = await login.text().catch(() => "");
  if (!login.ok || !sid || !/^Ok\.?$/i.test(loginText.trim())) {
    throw new Error("qBittorrent login failed; check the protected credentials.");
  }

  const torrents = await readJson(apiUrl(root, "api/v2/torrents/info"), {
    headers: { cookie: "SID=" + sid, origin: root.origin, referer: root.href }
  });
  if (!Array.isArray(torrents)) throw new Error("qBittorrent returned an invalid queue.");

  return torrents
    .filter(torrent => Number.isFinite(Number(torrent?.progress)) && Number(torrent.progress) < 1 && ["downloading","forcedDL","metaDL","allocating","moving"].includes(torrent?.state))
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((torrent, index) => {
      const progress = Math.max(0, Math.min(100, Number(torrent.progress) * 100));
      const eta = Number(torrent.eta);
      return {
        id: "qbittorrent-" + index,
        torrentHash: String(torrent.hash || ""),
        source: "qBittorrent",
        name: displayName(torrent.name),
        category: mediaType(torrent.category),
        progress,
        etaSeconds: Number.isFinite(eta) && eta >= 0 && eta < 8640000 ? eta : null,
        status: qbitState(torrent.state),
        lifecycle: "downloading"
      };
    });
}

function sabEta(value, status) {
  const parts = String(value || "").trim().split(":");
  if (parts.length < 2 || parts.some(part => !/^\d+$/.test(part))) return null;

  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (seconds === 0 && !/download/i.test(String(status || ""))) return null;
  return seconds;
}

async function queueReplacementSearch(env, name, onlyService = null) {
  const candidates = onlyService
    ? [onlyService]
    : arrServices().filter(service => arrServiceStatus(env, service).configured);
  if (onlyService && !arrServiceStatus(env, onlyService).configured) {
    return json({ ok: false, error: onlyService.name + " is not configured, so no replacement search was started." }, 503);
  }

  const normalize = value => String(value || "").toLowerCase()
    .replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const rawName = String(name || ""), wanted = normalize(rawName);
  const episodeCode = rawName.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) || rawName.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  const matches = [], failures = [];

  for (const service of candidates) {
    try {
      if (service.type === "tv") {
        const series = await arrCall(env, service, "api/v3/series");
        const match = (Array.isArray(series) ? series : []).map(item => ({ item, title: normalize(item.title) }))
          .filter(entry => entry.title && wanted.includes(entry.title))
          .sort((a, b) => b.title.length - a.title.length)[0]?.item;
        if (!match) {
          if (onlyService) return json({ ok: false, error: "Couldn't match this download to a show in " + service.name + ". No search was started." }, 404);
          continue;
        }

        const episodes = await arrCall(env, service, "api/v3/episode?seriesId=" + Number(match.id));
        if (!Array.isArray(episodes)) throw new Error(service.name + " did not return its episode list.");
        let found = [];
        if (episodeCode) {
          found = episodes.filter(episode => Number(episode.seasonNumber) === Number(episodeCode[1]) && Number(episode.episodeNumber) === Number(episodeCode[2]));
        } else {
          const residual = wanted.replace(normalize(match.title), " ").trim();
          const words = residual.split(/\s+/).filter(word => word.length > 2 && !/^(1080p|720p|2160p|web|webrip|bluray|h264|h265|x264|x265|proper|repack|aac|dts|hdr)$/i.test(word));
          const distinctive = words.join(" ");
          if (distinctive.length >= 4) found = episodes.filter(episode => normalize(episode.title) === distinctive);
        }
        if (!found.length) {
          if (onlyService) return json({ ok: false, error: episodeCode
            ? "Found " + match.title + " in " + service.name + ", but couldn't find episode S" + String(episodeCode[1]).padStart(2, "0") + "E" + String(episodeCode[2]).padStart(2, "0") + ". No search was started."
            : "Found " + match.title + " in " + service.name + ", but couldn't identify the exact episode from the release name. No search was started." }, 404);
          continue;
        }
        matches.push({ service, match, episodes: found });
      } else {
        const movies = await arrCall(env, service, "api/v3/movie");
        const match = (Array.isArray(movies) ? movies : []).map(item => ({ item, title: normalize(item.title) }))
          .filter(entry => entry.title && wanted.includes(entry.title))
          .sort((a, b) => b.title.length - a.title.length)[0]?.item;
        if (match) matches.push({ service, match });
        else if (onlyService) return json({ ok: false, error: "Couldn't match this download to a film in " + service.name + ". No search was started." }, 404);
      }
    } catch (error) {
      if (onlyService) throw error;
      failures.push(service.name + ": " + (error?.message || "lookup failed"));
    }
  }

  if (!matches.length) return json({ ok: true, searchQueued: false, message: "Download removed, but the exact episode or film could not be identified. No broad search was started." + (failures.length ? " Instance errors: " + failures.join("; ").slice(0, 300) : "") });
  const queued = [], errors = [];
  for (const entry of matches) {
    const { service, match } = entry;
    try {
      const command = service.type === "tv"
        ? { name: "EpisodeSearch", episodeIds: entry.episodes.map(episode => Number(episode.id)) }
        : { name: "MoviesSearch", movieIds: [Number(match.id)] };
      await arrCall(env, service, "api/v3/command", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
      });
      queued.push(service.name + (service.type === "tv" ? " (" + entry.episodes.map(episode => "S" + String(episode.seasonNumber).padStart(2, "0") + "E" + String(episode.episodeNumber).padStart(2, "0")).join(", ") + ")" : ""));
    } catch (error) { errors.push(service.name + ": " + (error?.message || "search queue failed")); }
  }
  if (!queued.length) return json({ ok: false, error: "The replacement search could not be queued. " + errors.join("; ").slice(0, 400) }, 502);
  return json({ ok: true, searchQueued: true, message: (onlyService ? "Replacement search queued in " : "Download removed. Targeted search queued in ") + queued.join(", ") + (errors.length ? ". Errors: " + errors.join("; ").slice(0, 200) : "") });
}

async function sabItems(env) {
  const apiKey = String(env.SABNZBD_API_KEY || "");
  if (!apiKey) throw new Error("Set the protected SABnzbd API key in Pages.");

  const root = serviceRoot(env.SABNZBD_BASE_URL, DEFAULT_SABNZBD_URL);
  const url = apiUrl(root, "api");
  url.searchParams.set("mode", "queue");
  url.searchParams.set("output", "json");
  url.searchParams.set("apikey", apiKey);

  const document = await readJson(url);
  const slots = document?.queue?.slots;
  if (!Array.isArray(slots)) throw new Error("SABnzbd returned an invalid queue.");

  return slots
    // Keep paused and queued jobs visible in the active-downloads section.
    // SABnzbd reports paused jobs in queue.slots too; only exclude completed/failed jobs.
    .filter(slot => Number.isFinite(Number(slot?.percentage)) && !/completed|failed/i.test(String(slot?.status || "")))
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((slot, index) => {
      const paused = /pause/i.test(String(slot?.status || ""));
      const queued = /queued|pending/i.test(String(slot?.status || ""));
      const importing = Number(slot.percentage) >= 100 && !paused;
      return {
        id: "sabnzbd-" + index,
        nzoId: String(slot.nzo_id || ""),
        source: "SABnzbd",
        name: displayName(slot.filename),
        category: mediaType(slot.cat),
        progress: Math.max(0, Math.min(100, Number(slot.percentage))),
        etaSeconds: paused || queued ? null : sabEta(slot.timeleft, slot.status),
        status: paused ? "Paused" : queued ? "Queued" : importing ? "Importing" : displayName(slot.status || "Downloading").slice(0, 32),
        lifecycle: importing ? "importing" : "downloading"
      };
    });
}

export async function onRequest({ env, request }) {
  if (!["GET","POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);

  if (!loginConfigured(env)) {
    return json({
      code: "login_setup_required",
      error: "Dashboard downloads login has not been configured."
    }, 503);
  }

  if (!await validSession(request, env)) {
    return json({
      code: "login_required",
      error: "Sign in to view download details."
    }, 401);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({error:"Invalid request body."},400); }
    const action = String(body?.action || "");
    const source = String(body?.source || "");
    const id = String(body?.id || "");
    const name = displayName(body?.name || "");
    const replacementService = action === "replace" ? arrServices().find(service => service.name === source) : null;
    if (!["pause","resume","remove","replace"].includes(action) || (!(["qBittorrent","SABnzbd"].includes(source) || replacementService)) || !name) return json({error:"Invalid download action."},400);
    if (replacementService && !id.startsWith("arr-" + replacementService.key + "-")) return json({ error: "This is not a failed library event that can be retried." }, 400);
    try {
      // Failed Sonarr/Radarr history items are not downloader queue jobs. Search
      // that exact library item directly instead of passing the ARR name into
      // the qBittorrent/SAB queue-action handlers.
      if (replacementService) return await queueReplacementSearch(env, name, replacementService);
      if (source === "qBittorrent") {
        const username=String(env.QBITTORRENT_USERNAME||""), password=String(env.QBITTORRENT_PASSWORD||"");
        if(!username||!password) throw new Error("qBittorrent credentials are not configured.");
        const root=serviceRoot(env.QBITTORRENT_BASE_URL,DEFAULT_QBITTORRENT_URL);
        const login=await fetch(apiUrl(root,"api/v2/auth/login"),{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",origin:root.origin,referer:root.href},body:new URLSearchParams({username,password}).toString(),signal:AbortSignal.timeout(7000),redirect:"manual"});
        const cookie=login.headers.get("set-cookie")||"",sid=cookie.match(/(?:^|[,;\\s])SID=([^;,\\s]+)/)?.[1],loginText=await login.text().catch(()=>"");
        if(!login.ok||!sid||!/^Ok\\.?$/i.test(loginText.trim())) throw new Error("qBittorrent login failed.");
        const hash=String(body?.torrentHash||"");
        if(!/^[a-f0-9]{40}$/i.test(hash)) throw new Error("Missing torrent identifier. Refresh the queue and try again.");
        const command=action==="pause"?"api/v2/torrents/pause":action==="resume"?"api/v2/torrents/resume":"api/v2/torrents/delete";
        const params=action==="pause"||action==="resume"?{hashes:hash}:{hashes:hash,deleteFiles:"true"};
        const response=await fetch(apiUrl(root,command),{method:"POST",headers:{cookie:"SID="+sid,origin:root.origin,referer:root.href,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(params).toString(),signal:AbortSignal.timeout(7000),redirect:"manual"});
        if(!response.ok) throw new Error("qBittorrent rejected the action.");
      } else {
        const apiKey=String(env.SABNZBD_API_KEY||"");
        if(!apiKey) throw new Error("SABnzbd API key is not configured.");
        const root=serviceRoot(env.SABNZBD_BASE_URL,DEFAULT_SABNZBD_URL), url=apiUrl(root,"api");
        url.searchParams.set("mode",action==="pause"?"queue":"queue");
        url.searchParams.set("name",action==="pause"?"pause":action==="resume"?"resume":"delete");
        url.searchParams.set("output","json"); url.searchParams.set("apikey",apiKey);
        const nzoId=String(body?.nzoId||"");
        if(!/^[A-Za-z0-9_-]{8,160}$/.test(nzoId)) throw new Error("Missing or invalid SABnzbd job identifier. Refresh the queue and try again.");
        url.searchParams.set("value",nzoId);
        if(action!=="pause" && action!=="resume") url.searchParams.set("del_files","1");
        const actionResult = await readJson(url);
        if (actionResult?.status === false || actionResult?.status === "false") {
          throw new Error("SABnzbd did not " + (action === "resume" ? "resume" : action === "pause" ? "pause" : "remove") + " this job. It may no longer be in the queue; refresh and try again.");
        }
      }
      if (action === "replace") return await queueReplacementSearch(env, name);
      return json({ok:true,message:action==="pause"?"Download paused.":action==="resume"?"Download resumed.":action==="replace"?"Download removed and a replacement search was queued.":"Download removed and downloaded files deleted."});
    } catch(error) { return json({error:error.message||"Download action failed."},502); }
  }

  const results = await Promise.allSettled([qbitItems(env), sabItems(env)]);
  const items = [];
  const sources = [
    { id: "qbittorrent", name: "qBittorrent", result: results[0] },
    { id: "sabnzbd", name: "SABnzbd", result: results[1] }
  ].map(source => {
    if (source.result.status === "fulfilled") {
      items.push(...source.result.value);
      return { id: source.id, name: source.name, connected: true, count: source.result.value.length };
    }

    const message = String(source.result.reason?.message || "");
    const configured = !message.startsWith("Set the protected");
    return {
      id: source.id,
      name: source.name,
      connected: false,
      count: 0,
      message: configured
        ? "Could not read this queue. Check the service URL and credentials."
        : message
    };
  });

  const historyResults = await Promise.all(arrServices().map(async service => {
    if (!arrServiceStatus(env, service).configured) return [];
    try {
      const response = await arrCall(env, service, "api/v3/history?page=1&pageSize=30&sortKey=date&sortDirection=descending");
      const records = Array.isArray(response) ? response : Array.isArray(response?.records) ? response.records : [];
      return records.filter(record => /downloadfolderimported|downloaded|imported|fail|error/i.test(String(record.eventType || record.event || ""))).map((record, index) => {
        const event = String(record.eventType || record.event || "");
        const failed = /fail|error/i.test(event);
        const title = displayName(record.sourceTitle || record.data?.sourceTitle || record.series?.title || record.movie?.title || record.message || "Media download");
        return {
          id: "arr-" + service.key + "-" + String(record.id || index),
          source: service.name,
          name: title,
          category: service.type === "tv" ? "TV show" : "Movie",
          progress: failed ? 0 : 100,
          etaSeconds: null,
          status: failed ? "Failed" : "Imported",
          lifecycle: failed ? "failed" : "imported",
          eventDate: String(record.date || record.dateAdded || ""),
          eventDetail: String(record.message || record.data?.message || event).slice(0, 300)
        };
      });
    } catch { return []; }
  }));
  const lifecycleItems = historyResults.flat().sort((a,b) => Date.parse(b.eventDate || 0) - Date.parse(a.eventDate || 0)).slice(0, 12);
  const seen = new Set(items.map(item => item.name.toLowerCase()));
  for (const item of lifecycleItems) {
    if (!seen.has(item.name.toLowerCase())) items.push(item);
  }

  return json({
    updatedAt: new Date().toISOString(),
    items: items.slice(0, MAX_ITEMS_PER_SOURCE * 2),
    sources
  });
}

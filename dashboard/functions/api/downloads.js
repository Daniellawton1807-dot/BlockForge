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
    if (!["pause","resume","remove","replace"].includes(action) || !["qBittorrent","SABnzbd"].includes(source) || !name) return json({error:"Invalid download action."},400);
    try {
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
      if(action==="replace") {
        const candidates=arrServices().filter(service=>arrServiceStatus(env,service).configured);
        let triggered=false;
        for(const service of candidates) {
          try {
            if(service.type==="tv") {
              const series=await arrCall(env,service,"api/v3/series");
              const match=(Array.isArray(series)?series:[]).find(item=>String(item.title||"").toLowerCase()===name.toLowerCase());
              if(match){await arrCall(env,service,"api/v3/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"SeriesSearch",seriesId:Number(match.id)})});triggered=true;break;}
            } else {
              const movies=await arrCall(env,service,"api/v3/movie");
              const match=(Array.isArray(movies)?movies:[]).find(item=>String(item.title||"").toLowerCase()===name.toLowerCase());
              if(match){await arrCall(env,service,"api/v3/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"MoviesSearch",movieIds:[Number(match.id)]})});triggered=true;break;}
            }
          } catch {}
        }
        if(!triggered) return json({ok:true,message:"Download removed, but no matching monitored title was found in Sonarr/Radarr to rescan."});
      }
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

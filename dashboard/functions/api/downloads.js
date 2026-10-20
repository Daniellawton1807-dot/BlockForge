import { loginConfigured, validSession } from "../_utils/downloads-auth.js";
const DEFAULT_QBITTORRENT_URL = "https://qb.danielvault.uk";
const DEFAULT_SABNZBD_URL = "https://sab.danielvault.uk";
const MAX_ITEMS_PER_SOURCE = 30;
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
  if (!response.ok) throw new Error("The service returned HTTP " + response.status + ".");

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
    .filter(torrent => Number.isFinite(Number(torrent?.progress)) && Number(torrent.progress) < 1)
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((torrent, index) => {
      const progress = Math.max(0, Math.min(100, Number(torrent.progress) * 100));
      const eta = Number(torrent.eta);
      return {
        id: "qbittorrent-" + index,
        source: "qBittorrent",
        name: displayName(torrent.name),
        category: mediaType(torrent.category),
        progress,
        etaSeconds: Number.isFinite(eta) && eta >= 0 && eta < 8640000 ? eta : null,
        status: qbitState(torrent.state)
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
    .filter(slot => Number.isFinite(Number(slot?.percentage)) && Number(slot.percentage) < 100)
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((slot, index) => ({
      id: "sabnzbd-" + index,
      source: "SABnzbd",
      name: displayName(slot.filename),
      category: mediaType(slot.cat),
      progress: Math.max(0, Math.min(100, Number(slot.percentage))),
      etaSeconds: sabEta(slot.timeleft, slot.status),
      status: displayName(slot.status || "In queue").slice(0, 32)
    }));
}

export async function onRequest({ env, request }) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

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

  return json({
    updatedAt: new Date().toISOString(),
    items,
    sources
  });
}

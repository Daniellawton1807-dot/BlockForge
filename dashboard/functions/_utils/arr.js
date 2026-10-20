const ARR_BRIDGE_BINDING = "ARR_BRIDGE";

const ARR_SERVICES = [
  { key: "sonarr-daniel", name: "Sonarr", type: "tv", apiKey: "SONARR_DANIEL_API_KEY" },
  { key: "sonarr-mum", name: "Sonarr Mum", type: "tv", apiKey: "SONARR_MUM_API_KEY" },
  { key: "sonarr-extra", name: "Sonarr Extra", type: "tv", apiKey: "SONARR_EXTRA_API_KEY" },
  { key: "radarr", name: "Radarr", type: "movie", apiKey: "RADARR_API_KEY" }
];

export class ArrError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "ArrError";
    this.code = code;
    this.status = status;
  }
}

export function arrService(key) {
  return ARR_SERVICES.find(service => service.key === key) || null;
}

export function arrServiceStatus(env, service) {
  const bridge = env[ARR_BRIDGE_BINDING];
  const apiKey = String(env[service.apiKey] || "").trim();
  if (!bridge || typeof bridge.fetch !== "function") {
    return { key: service.key, name: service.name, type: service.type, configured: false, code: "binding_missing", message: "Private ARR bridge binding " + ARR_BRIDGE_BINDING + " is not configured." };
  }
  if (!apiKey) {
    return { key: service.key, name: service.name, type: service.type, configured: false, code: "api_key_missing", message: "Protected Pages secret " + service.apiKey + " is not configured." };
  }
  return { key: service.key, name: service.name, type: service.type, configured: true };
}

export async function arrCall(env, service, path, options = {}) {
  const status = arrServiceStatus(env, service);
  if (!status.configured) throw new ArrError(status.code, status.message, 503);
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  if (!/^api\/v3\/[A-Za-z0-9_./?=&%:+-]+$/.test(normalizedPath) || normalizedPath.includes("..")) {
    throw new ArrError("invalid_upstream_path", "That media operation is not supported.", 400);
  }

  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new ArrError("invalid_upstream_method", "That media operation is not supported.", 400);
  }

  const headers = new Headers(options.headers || {});
  headers.set("X-Homebase-Service", service.key);
  headers.set("X-Api-Key", String(env[service.apiKey]));
  headers.set("Accept", "application/json");

  let request;
  try {
    request = new Request("https://homebase-arr-bridge/" + normalizedPath, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body
    });
  } catch {
    throw new ArrError("invalid_request", "That media operation could not be prepared.", 400);
  }

  let response;
  try {
    response = await env[ARR_BRIDGE_BINDING].fetch(request);
  } catch {
    throw new ArrError("service_unavailable", service.name + " is not reachable from Homebase right now.");
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "arr_auth_failed" : "arr_request_failed";
    throw new ArrError(code, service.name + " returned HTTP " + response.status + ". Check its API key and configuration.", 502);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!/application\/json/i.test(contentType)) {
    throw new ArrError("invalid_upstream_response", service.name + " returned an unexpected response.");
  }
  try {
    return await response.json();
  } catch {
    throw new ArrError("invalid_upstream_response", service.name + " returned invalid JSON.");
  }
}

export async function readArrOptions(env, service) {
  const [rootFolders, qualityProfiles, library] = await Promise.all([
    arrCall(env, service, "api/v3/rootfolder"),
    arrCall(env, service, "api/v3/qualityprofile"),
    arrCall(env, service, service.type === "tv" ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true")
  ]);
  return {
    rootFolders: Array.isArray(rootFolders) ? rootFolders.map(folder => ({
      id: Number(folder.id),
      path: String(folder.path || ""),
      freeSpace: Number.isFinite(Number(folder.freeSpace)) ? Number(folder.freeSpace) : null
    })).filter(folder => folder.path) : [],
    qualityProfiles: Array.isArray(qualityProfiles) ? qualityProfiles.map(profile => ({
      id: Number(profile.id),
      name: String(profile.name || "")
    })).filter(profile => Number.isSafeInteger(profile.id) && profile.id > 0 && profile.name) : [],
    library: Array.isArray(library) ? library.map(item => normalizeLibraryItem(service, item)).filter(Boolean).slice(0, 2000) : []
  };
}

function posterUrl(item) {
  const image = Array.isArray(item.images) ? item.images.find(candidate => String(candidate.coverType || "").toLowerCase() === "poster") : null;
  const value = String(image?.remoteUrl || image?.url || "");
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["image.tmdb.org", "artworks.thetvdb.com", "www.thetvdb.com"].includes(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
}

export function normalizeLookup(service, item) {
  const mediaType = service.type === "tv" ? "tv" : "movie";
  const title = String(item.title || item.sortTitle || "Untitled").slice(0, 180);
  const year = Number(item.year) || Number(String(item.firstAired || item.releaseDate || "").slice(0, 4)) || null;
  const tmdbId = Number(item.tmdbId) > 0 ? Number(item.tmdbId) : null;
  const tvdbId = Number(item.tvdbId) > 0 ? Number(item.tvdbId) : null;
  const itemId = mediaType === "tv" ? tvdbId || tmdbId : tmdbId;
  if (!itemId) return null;
  return {
    mediaType,
    id: itemId,
    tmdbId,
    tvdbId,
    title,
    year,
    overview: String(item.overview || "").slice(0, 700),
    posterUrl: posterUrl(item),
    genres: Array.isArray(item.genres) ? item.genres.map(value => String(value).slice(0, 50)).slice(0, 6) : [],
    sourceServices: [service.key]
  };
}

export function normalizeLibraryItem(service, item) {
  const mediaType = service.type === "tv" ? "tv" : "movie";
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    serviceKey: service.key,
    serviceName: service.name,
    mediaType,
    id,
    tmdbId: Number(item.tmdbId) > 0 ? Number(item.tmdbId) : null,
    tvdbId: Number(item.tvdbId) > 0 ? Number(item.tvdbId) : null,
    title: String(item.title || "Untitled").slice(0, 180),
    year: Number(item.year) || null,
    monitored: Boolean(item.monitored),
    status: String(item.status || "").slice(0, 40),
    rootFolderPath: String(item.rootFolderPath || ""),
    qualityProfileId: Number(item.qualityProfileId) || null,
    sizeOnDisk: Number(item.statistics?.sizeOnDisk || item.sizeOnDisk || 0),
    posterUrl: posterUrl(item),
    episodeFileCount: Number(item.statistics?.episodeFileCount || 0),
    episodeCount: Number(item.statistics?.episodeCount || 0)
  };
}

export function arrServices() {
  return ARR_SERVICES;
}

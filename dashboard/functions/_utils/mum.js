// Mum's request page (/mum/): trending, her own recommendations and search, and one-tap requests that go
// straight into her Sonarr ("Sonarr Mum", its /mum tv folder) or Radarr's "Movies - Mum" folder.
// Picks and trending come from tvbot (Seerr/TMDB); what she already has comes from her Sonarr and Radarr.
import { arrCall, arrService } from "./arr.js";
import { json, loginConfigured, mumCookie, mumSession } from "./downloads-auth.js";

export const MUM_USER = "Mum";
const TV = "sonarr-mum", MOVIES = "radarr";
const MUM_MOVIES = /movies - mum/i;

// every /api/mum route except setup: signed in on her phone, else 401; renews the cookie as she uses it
export async function mumRoute(request, env, handler) {
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Homebase sign-in isn't set up." }, 503);
  const session = await mumSession(request, env);
  if (!session) return json({ code: "setup_required", error: "This phone needs setting up." }, 401);
  let response;
  try { response = await handler(); }
  catch (error) { response = json({ code: error?.code || "unavailable", error: error?.message || "Something went wrong. Try again in a minute." }, error?.status || 502); }
  if (session.renew) response.headers.append("set-cookie", await mumCookie(env));
  return response;
}

export async function tvbot(env, path) {
  const token = String(env.TVBOT_TOKEN || "").trim();
  if (!token || !env.ARR_BRIDGE) throw Object.assign(new Error("The recommendations service isn't set up."), { status: 503 });
  let response;
  try {
    response = await env.ARR_BRIDGE.fetch(new Request("https://homebase-arr-bridge/" + path, { headers: { "x-homebase-service": "tvbot", "x-tv-token": token, accept: "application/json" } }));
  } catch { throw Object.assign(new Error("Couldn't reach the server. Try again in a minute."), { status: 502 }); }
  if (!response.ok) throw Object.assign(new Error("The server couldn't load that just now. Try again in a minute."), { status: 502 });
  return response.json();
}

// what she has: shows in her Sonarr, films in Radarr (hers if they're in her folder)
export async function mumLibrary(env) {
  const [series, movies] = await Promise.all([
    arrCall(env, arrService(TV), "api/v3/series"),
    arrCall(env, arrService(MOVIES), "api/v3/movie?excludeLocalCovers=true")
  ]);
  const tv = new Map(), film = new Map();
  for (const s of Array.isArray(series) ? series : []) {
    const entry = { has: Number(s.statistics?.episodeFileCount) > 0 };
    if (Number(s.tmdbId) > 0) tv.set(Number(s.tmdbId), entry);
  }
  for (const m of Array.isArray(movies) ? movies : []) {
    if (Number(m.tmdbId) > 0) film.set(Number(m.tmdbId), { has: Boolean(m.hasFile), mine: MUM_MOVIES.test(String(m.rootFolderPath || m.path || "")) });
  }
  return { tv, film, series: Array.isArray(series) ? series : [], movies: Array.isArray(movies) ? movies : [] };
}

// "request" | "coming" (asked for, not downloaded yet) | "have" | "elsewhere" (a film already in Daniel's folder)
export function statusOf(library, type, tmdb) {
  if (type === "tv") { const s = library.tv.get(tmdb); return !s ? "request" : s.has ? "have" : "coming"; }
  const m = library.film.get(tmdb);
  return !m ? "request" : !m.mine ? "elsewhere" : m.has ? "have" : "coming";
}

export function card(library, x) {
  const tmdb = Number(x.tmdb);
  if (!tmdb || !["tv", "movie"].includes(x.type)) return null;
  return {
    tmdb, type: x.type, title: String(x.title || "").slice(0, 160), year: String(x.year || "").slice(0, 4),
    poster: /^\/[A-Za-z0-9._-]+$/.test(String(x.poster || "")) ? x.poster : "",
    overview: String(x.overview || "").slice(0, 600), rating: Number(x.rating) || 0,
    status: statusOf(library, x.type, tmdb)
  };
}

const mostCommon = values => { const count = new Map(); for (const v of values) if (v != null && v !== "") count.set(v, (count.get(v) || 0) + 1); return [...count].sort((a, b) => b[1] - a[1])[0]?.[0]; };

// add it the way her library is already set up: same folder and quality as most of her shows/films, search straight away
export async function requestTitle(env, type, tmdb) {
  const library = await mumLibrary(env);
  const before = statusOf(library, type, tmdb);
  if (before !== "request") return { status: before, already: true };
  const service = arrService(type === "tv" ? TV : MOVIES);
  const [roots, profiles, lookup] = await Promise.all([
    arrCall(env, service, "api/v3/rootfolder"),
    arrCall(env, service, "api/v3/qualityprofile"),
    arrCall(env, service, "api/v3/" + (type === "tv" ? "series" : "movie") + "/lookup?term=" + encodeURIComponent("tmdb:" + tmdb))
  ]);
  const meta = (Array.isArray(lookup) ? lookup : []).find(item => Number(item.tmdbId) === tmdb);
  if (!meta) throw Object.assign(new Error("Couldn't find that one. Try searching for it by name."), { status: 404 });
  const rootPaths = (Array.isArray(roots) ? roots : []).map(r => String(r.path || ""));
  const profileIds = (Array.isArray(profiles) ? profiles : []).map(p => Number(p.id));
  let rootFolderPath, qualityProfileId;
  if (type === "tv") {
    rootFolderPath = [mostCommon(library.series.map(s => s.rootFolderPath)), ...rootPaths].find(p => p && rootPaths.includes(p));
    qualityProfileId = [mostCommon(library.series.map(s => Number(s.qualityProfileId))), ...profileIds].find(id => profileIds.includes(id));
  } else {
    rootFolderPath = rootPaths.find(p => MUM_MOVIES.test(p));
    qualityProfileId = [mostCommon(library.movies.filter(m => MUM_MOVIES.test(String(m.rootFolderPath || ""))).map(m => Number(m.qualityProfileId))), ...profileIds].find(id => profileIds.includes(id));
  }
  if (!rootFolderPath || !qualityProfileId) throw Object.assign(new Error("Her " + (type === "tv" ? "TV shows" : "films") + " folder isn't set up in " + service.name + "."), { status: 503 });
  const payload = { ...meta, id: 0, rootFolderPath, qualityProfileId, monitored: true };
  if (type === "tv") {
    payload.seasonFolder = true;
    payload.seriesType = meta.seriesType || "standard";
    payload.addOptions = { monitor: "all", searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false };
  } else {
    payload.minimumAvailability = meta.minimumAvailability || "released";
    payload.addOptions = { searchForMovie: true };
  }
  await arrCall(env, service, "api/v3/" + (type === "tv" ? "series" : "movie"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { status: "coming", title: String(meta.title || "") };
}

import { arrCall, arrServiceStatus, arrServices, normalizeLookup } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to search media." }, 401);

  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2 || query.length > 120) return json({ code: "invalid_query", error: "Enter between 2 and 120 characters to search." }, 400);

  const services = arrServices();
  const attempts = await Promise.all(services.map(async service => {
    const status = arrServiceStatus(env, service);
    if (!status.configured) return { service, error: status.message };
    try {
      const endpoint = "api/v3/" + (service.type === "tv" ? "series" : "movie") + "/lookup?term=";
      // ARR lookup can return different fuzzy matches depending on capitalization
      // in some upstream metadata providers. Query the original and a normalized
      // title-case variant, then merge/deduplicate before relevance ranking.
      const variants = [...new Set([query, query.charAt(0).toLocaleUpperCase("en-US") + query.slice(1)])];
      const results = await Promise.all(variants.map(async term => {
        try {
          const result = await arrCall(env, service, endpoint + encodeURIComponent(term));
          return Array.isArray(result) ? result : [];
        } catch {
          return [];
        }
      }));
      return { service, items: results.flat() };
    } catch (error) {
      return { service, error: error?.message || service.name + " is unavailable." };
    }
  }));

  const successful = attempts.filter(result => Array.isArray(result.items));
  if (!successful.length) {
    const missing = attempts.filter(result => result.error).map(result => result.service.apiKey);
    return json({
      code: "arr_unavailable",
      error: "None of the Sonarr or Radarr instances is ready for search.",
      missingSecrets: [...new Set(missing)]
    }, 503);
  }

  const byKey = new Map();
  for (const attempt of successful) {
    for (const raw of attempt.items) {
      const item = normalizeLookup(attempt.service, raw);
      if (!item) continue;
      const identity = item.mediaType + ":" + (item.mediaType === "tv" ? (item.tvdbId || item.tmdbId) : item.tmdbId);
      const existing = byKey.get(identity);
      if (existing) {
        if (!existing.posterUrl && item.posterUrl) existing.posterUrl = item.posterUrl;
        if (!existing.overview && item.overview) existing.overview = item.overview;
        if (!existing.genres.length && item.genres.length) existing.genres = item.genres;
        if (!existing.sourceServices.includes(attempt.service.key)) existing.sourceServices.push(attempt.service.key);
      } else {
        byKey.set(identity, item);
      }
    }
  }
  // Normalize titles and queries identically so capitalization never affects ranking.
  // Rank exact matches first, then titles beginning with the query, then word-prefix matches,
  // substring matches, and finally broader fuzzy results from Sonarr/Radarr.
  function normalizeTitle(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  const normalizedQuery = normalizeTitle(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  function titleRank(item) {
    const title = normalizeTitle(item.title);
    if (!title) return 100;
    if (title === normalizedQuery) return 0;
    if (title.startsWith(normalizedQuery + " ") || title.startsWith(normalizedQuery)) return 1;
    if (title.split(/\s+/).some(word => word.startsWith(normalizedQuery))) return 2;
    if (title.includes(normalizedQuery)) return 3;
    if (tokens.length && tokens.every(token => title.includes(token))) return 4;
    return 10;
  }
  const results = [...byKey.values()]
    .sort((a, b) => titleRank(a) - titleRank(b) || (a.title || "").localeCompare(b.title || ""))
    .slice(0, 30);
  return json({
    results,
    services: attempts.map(attempt => ({ key: attempt.service.key, name: attempt.service.name, connected: Array.isArray(attempt.items), message: attempt.error || "" }))
  });
}

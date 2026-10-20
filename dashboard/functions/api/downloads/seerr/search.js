import { json, loginConfigured, validSession } from "../../../_utils/downloads-auth.js";
import { SeerrError, seerrCall, seerrConfigured } from "../../../_utils/seerr.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) {
    return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  }
  if (!await validSession(request, env)) {
    return json({ code: "login_required", error: "Sign in to search Seerr." }, 401);
  }
  if (!seerrConfigured(env)) {
    return json({ code: "seerr_setup_required", error: "Set SEERR_API_KEY as a Secret in the Cloudflare Pages Production environment." }, 503);
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2 || query.length > 120) {
    return json({ code: "invalid_query", error: "Enter between 2 and 120 characters to search." }, 400);
  }

  try {
    const result = await seerrCall(env, "search?query=" + encodeURIComponent(query) + "&page=1");
    const results = Array.isArray(result?.results) ? result.results : [];
    const media = results
      .filter(item => ["movie", "tv"].includes(String(item?.mediaType || item?.media_type || "").toLowerCase()))
      .slice(0, 16)
      .map(item => ({
        id: Number(item.id),
        mediaType: String(item.mediaType || item.media_type).toLowerCase(),
        title: String(item.title || item.name || "Untitled").slice(0, 180),
        overview: String(item.overview || "").slice(0, 600),
        releaseDate: String(item.releaseDate || item.firstAirDate || item.release_date || item.first_air_date || "").slice(0, 20),
        posterPath: typeof item.posterPath === "string" && /^\/[A-Za-z0-9_./-]+$/.test(item.posterPath) ? item.posterPath : "",
        tvdbId: Number.isSafeInteger(Number(item.tvdbId)) && Number(item.tvdbId) > 0 ? Number(item.tvdbId) : null
      }))
      .filter(item => Number.isSafeInteger(item.id) && item.id > 0);
    return json({ results: media });
  } catch (error) {
    return json({
      code: error instanceof SeerrError ? error.code : "seerr_unavailable",
      error: error instanceof SeerrError ? error.message : "Seerr search is unavailable."
    }, error instanceof SeerrError ? error.status : 502);
  }
}

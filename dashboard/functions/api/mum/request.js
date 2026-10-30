import { json, readJsonBody, validRequestOrigin } from "../../_utils/downloads-auth.js";
import { mumRoute, requestTitle } from "../../_utils/mum.js";

// POST {type: "tv" | "movie", tmdb}: straight into her Sonarr / her Radarr folder, searching right away
export async function onRequestPost({ request, env }) {
  if (!validRequestOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  return mumRoute(request, env, async () => {
    let body;
    try { body = await readJsonBody(request, 1024); } catch { return json({ error: "Could not read that." }, 400); }
    const type = body?.type, tmdb = Number(body?.tmdb);
    if (!["tv", "movie"].includes(type) || !Number.isSafeInteger(tmdb) || tmdb <= 0) return json({ error: "Pick something to request." }, 400);
    return json(await requestTitle(env, type, tmdb));
  });
}

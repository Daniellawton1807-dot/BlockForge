import { json } from "../../_utils/downloads-auth.js";
import { card, mumLibrary, mumRoute, tvbot } from "../../_utils/mum.js";

export async function onRequestGet({ request, env }) {
  return mumRoute(request, env, async () => {
    const q = (new URL(request.url).searchParams.get("q") || "").replace(/[^\p{L}\p{N} '&:!?.,-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (q.length < 2) return json({ results: [] });
    const [library, found] = await Promise.all([mumLibrary(env), tvbot(env, "api/discover?q=" + encodeURIComponent(q))]);
    return json({ results: (Array.isArray(found) ? found : []).map(x => card(library, x)).filter(Boolean).slice(0, 24) });
  });
}

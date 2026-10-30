import { json } from "../../_utils/downloads-auth.js";
import { MUM_USER, card, mumLibrary, mumRoute, tvbot } from "../../_utils/mum.js";

// Her front page: picks from what she's watched, then what's trending, split into shows and films.
// ?page=N steps through a pool of ~160 picks, 30 at a time (her Refresh button moves on a page, wrapping round);
// ?refresh=1 also fetches trending afresh.
export async function onRequestGet({ request, env }) {
  return mumRoute(request, env, async () => {
    const params = new URL(request.url).searchParams;
    const refresh = params.get("refresh") === "1" ? "&refresh=1" : "";
    const page = Math.max(0, Math.min(1000, Number.parseInt(params.get("page") || "0", 10) || 0));
    const [library, picks, trending] = await Promise.all([
      mumLibrary(env),
      tvbot(env, "api/foryou?details=1&limit=36&offset=" + page * 30 + "&user=" + MUM_USER).catch(() => []),
      tvbot(env, "api/discover?details=1" + refresh).catch(() => [])
    ]);
    const cards = list => (Array.isArray(list) ? list : []).map(x => card(library, x)).filter(Boolean);
    const trend = cards(trending);
    const forYou = cards(picks).filter(x => x.status === "request");
    return json({
      forYou: forYou.slice(0, 24),
      shows: trend.filter(x => x.type === "tv").slice(0, 20),
      films: trend.filter(x => x.type === "movie").slice(0, 20)
    });
  });
}

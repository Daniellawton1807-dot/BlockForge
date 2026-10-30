import { json } from "../../_utils/downloads-auth.js";
import { MUM_USER, card, mumLibrary, mumRoute, tvbot } from "../../_utils/mum.js";

// Her front page: picks from what she's watched, then what's trending, split into shows and films.
export async function onRequestGet({ request, env }) {
  return mumRoute(request, env, async () => {
    const [library, picks, trending] = await Promise.all([
      mumLibrary(env),
      tvbot(env, "api/foryou?user=" + MUM_USER).catch(() => []),
      tvbot(env, "api/discover").catch(() => [])
    ]);
    const cards = list => (Array.isArray(list) ? list : []).map(x => card(library, x)).filter(Boolean);
    const trend = cards(trending);
    return json({
      forYou: cards(picks).filter(x => x.status === "request").slice(0, 24),
      shows: trend.filter(x => x.type === "tv").slice(0, 20),
      films: trend.filter(x => x.type === "movie").slice(0, 20)
    });
  });
}

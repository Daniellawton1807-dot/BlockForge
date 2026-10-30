import { json } from "../../_utils/downloads-auth.js";
import { MUM_USER, card, mumLibrary, mumRoute, tvbot } from "../../_utils/mum.js";

// Her front page: picks from what she's watched, then what's trending, split into shows and films.
// ?refresh=1 (her Refresh button): rebuild the picks from her latest viewing, fetch trending afresh, and
// shuffle the picks a little so ones further down the list get a turn at the front.
export async function onRequestGet({ request, env }) {
  return mumRoute(request, env, async () => {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1" ? "&refresh=1" : "";
    const [library, picks, trending] = await Promise.all([
      mumLibrary(env),
      tvbot(env, "api/foryou?details=1" + refresh + "&user=" + MUM_USER).catch(() => []),
      tvbot(env, "api/discover?details=1" + refresh).catch(() => [])
    ]);
    const cards = list => (Array.isArray(list) ? list : []).map(x => card(library, x)).filter(Boolean);
    const trend = cards(trending);
    let forYou = cards(picks).filter(x => x.status === "request");
    if (refresh) forYou = forYou.map((x, i) => [i + Math.random() * 14, x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
    return json({
      forYou: forYou.slice(0, 24),
      shows: trend.filter(x => x.type === "tv").slice(0, 20),
      films: trend.filter(x => x.type === "movie").slice(0, 20)
    });
  });
}

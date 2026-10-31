import { arrCall, arrServiceStatus, arrServices } from "../_utils/arr.js";

// "Hey Siri" endpoint for an iPhone Shortcut. POST the dictated text (plain text, or JSON {text}) with the
// tvbot token in the X-TV-Token header; the reply is one sentence for Siri to read out.
// A few questions are answered here from Sonarr/Radarr; everything else goes to tvbot like the remote's
// command box (play, pause, rewind, request, which TV, ...). Works from anywhere: no home network needed.

const say = (text, status = 200) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

function sameToken(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const list = items => items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
const episodeLabel = (title, ep) => title + (ep && Number.isFinite(Number(ep.seasonNumber)) ? ` season ${ep.seasonNumber} episode ${ep.episodeNumber}` : "");

async function eachArr(env, fn) {
  const out = await Promise.all(arrServices().map(async service => {
    if (!arrServiceStatus(env, service).configured) return [];
    try { return await fn(service); } catch { return []; }
  }));
  return out.flat();
}

async function downloading(env) {
  const items = await eachArr(env, async service => {
    const include = service.type === "tv" ? "&includeSeries=true&includeEpisode=true" : "&includeMovie=true";
    const r = await arrCall(env, service, "api/v3/queue?page=1&pageSize=50" + include);
    return (r?.records || []).map(q => ({
      name: service.type === "tv" ? episodeLabel(q.series?.title || "a show", q.episode) : (q.movie?.title || "a film"),
      pct: q.size ? Math.round(100 * (1 - (q.sizeleft || 0) / q.size)) : 0,
      state: String(q.trackedDownloadState || "").toLowerCase()
    }));
  });
  if (!items.length) return "Nothing's downloading right now.";
  const importing = items.filter(i => i.state.startsWith("import") && i.state !== "importblocked").length;
  const blocked = items.filter(i => i.state === "importblocked").length;
  const active = items.filter(i => !i.state.startsWith("import")).sort((a, b) => b.pct - a.pct);
  const parts = [];
  if (active.length) parts.push(`${active.length} downloading: ${list(active.slice(0, 3).map(i => `${i.name} at ${i.pct} percent`))}${active.length > 3 ? ", and more" : ""}.`);
  if (importing) parts.push(`${importing} being imported.`);
  if (blocked) parts.push(`${blocked} stuck on import. Check Downloads in Homebase.`);
  return parts.join(" ");
}

async function tonight(env) {
  const day = new Date(), start = day.toISOString().slice(0, 10), end = new Date(day.getTime() + 86400000).toISOString().slice(0, 10);
  const items = await eachArr(env, async service => {
    if (service.type !== "tv") return [];
    const r = await arrCall(env, service, `api/v3/calendar?start=${start}&end=${end}&unmonitored=false&includeSeries=true`);
    return (Array.isArray(r) ? r : []).filter(e => String(e.airDateUtc || "").slice(0, 10) === start)
      .map(e => ({ name: e.series?.title || "a show", has: Boolean(e.hasFile) }));
  });
  if (!items.length) return "Nothing new from your shows today.";
  const names = [...new Set(items.map(i => i.name))];
  const ready = items.filter(i => i.has).length;
  return `Today: ${list(names)}.` + (ready ? ` ${ready === items.length ? "All" : ready} ready to watch.` : " Not downloaded yet.");
}

async function whatsNew(env) {
  const since = Date.now() - 36 * 3600000;
  const items = await eachArr(env, async service => {
    const include = service.type === "tv" ? "&includeSeries=true" : "&includeMovie=true";
    const r = await arrCall(env, service, "api/v3/history?page=1&pageSize=40&sortKey=date&sortDirection=descending&eventType=3" + include);
    return (r?.records || []).filter(h => Date.parse(h.date) > since).map(h => service.type === "tv" ? (h.series?.title || "") : (h.movie?.title || "")).filter(Boolean);
  });
  if (!items.length) return "Nothing new has come in since yesterday.";
  const counts = new Map(); for (const n of items) counts.set(n, (counts.get(n) || 0) + 1);
  const names = [...counts].map(([n, c]) => c > 1 ? `${c} episodes of ${n}` : n);
  return `New since yesterday: ${list(names.slice(0, 5))}${names.length > 5 ? ", and more" : ""}.`;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return say("Send a POST with what you'd like done.", 405);
  const expected = String(env.TVBOT_TOKEN || "").trim();
  const given = (request.headers.get("x-tv-token") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "").trim();
  if (!expected) return say("Homebase isn't set up for Siri yet.", 503);
  if (!sameToken(given, expected)) return say("That token isn't right.", 401);

  const raw = await request.text().catch(() => "");
  let text = raw;
  try { if (raw.trim().startsWith("{")) text = String(JSON.parse(raw).text || ""); } catch {}
  text = text.trim().slice(0, 300);
  if (!text) return say("I didn't catch that.");
  const q = text.toLowerCase().replace(/[?.!]/g, "").trim();

  try {
    if (/\b(what'?s|what is|anything) (downloading|in the queue)\b|\bdownload(s|ing)? status\b/.test(q)) return say(await downloading(env));
    if (/\bwhat'?s (on|out|coming out|airing) (tonight|today)\b|\bnew episodes (tonight|today)\b|\bwhat'?s on tonight\b/.test(q)) return say(await tonight(env));
    if (/\bwhat'?s new\b|\bwhat (just )?(came in|arrived|finished downloading)\b|\banything new\b/.test(q)) return say(await whatsNew(env));
  } catch {
    return say("I couldn't reach Sonarr and Radarr just now.");
  }

  // everything else: tvbot, exactly like typing it into the remote
  const bridge = env.ARR_BRIDGE;
  if (!bridge || typeof bridge.fetch !== "function") return say("Homebase can't reach the TVs right now.", 503);
  try {
    const r = await bridge.fetch(new Request("https://homebase-arr-bridge/cmd", {
      method: "POST",
      headers: { "x-homebase-service": "tvbot", "x-tv-token": expected, "content-type": "application/json", accept: "text/plain" },
      body: JSON.stringify({ text })
    }));
    const reply = (await r.text()).trim().slice(0, 500);
    return say(r.ok ? reply || "Done." : r.status === 401 ? "The TV bot rejected Homebase's token." : "The TVs didn't answer.");
  } catch {
    return say("Homebase can't reach the TVs right now.");
  }
}

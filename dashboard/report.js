/* Homebase weekly report: /api/report (library, Autopilot, disk) plus /api/health (are the apps answering). */
(() => {
  const { $, el, api, errorText, gate } = Hub;
  const RULE_WORDS = { stalled: "stalled", importBlocked: "blocked imports", research: "re-searches", upgrade: "upgrades" };
  const gb = b => b >= 1e12 ? (b / 1e12).toFixed(1) + " TB" : Math.round(b / 1073741824) + " GB";
  const day = iso => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const when = iso => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  function stat(k, v, d, warn) { const s = el("div", "hub-stat" + (warn ? " warn" : "")); s.append(el("div", "k", k), el("div", "v", v), el("div", "d", d || "")); return s; }
  function row(left, right, dot) {
    const r = el("div", "rp-row"); if (dot) r.append(el("i", "rp-dot " + dot));
    r.append(el("span", "rp-l", left), el("span", "rp-r", right || "")); return r;
  }

  async function load() {
    $("rpRange").textContent = "Checking…";
    const [rep, health] = await Promise.all([api("/api/report"), api("/api/health")]);
    if (!rep.ok) { $("rpRange").textContent = errorText(rep, "Couldn't build the report."); return; }
    const d = rep.data;
    $("rpRange").textContent = day(d.from) + " to " + day(d.to);

    const weeks = d.disk?.daysLeft != null ? Math.round(d.disk.daysLeft / 7) : null;
    $("rpStats").replaceChildren(
      stat("Added", String(d.added.episodes + d.added.films), `${d.added.episodes} episodes, ${d.added.films} films`),
      stat("Downloaded", gb(d.added.bytes), "this week"),
      stat("Fixed by Autopilot", String(d.autopilot.total), d.autopilot.total ? d.autopilot.rules.map(r => r.count + " " + (RULE_WORDS[r.rule] || r.rule)).join(", ") : "nothing needed fixing"),
      stat("Media drive", d.disk ? gb(d.disk.free) + " free" : "–", weeks != null ? `full in about ${weeks} week${weeks === 1 ? "" : "s"}` : "no forecast yet", weeks != null && weeks < 8)
    );

    const top = $("rpTop"); top.replaceChildren();
    if (!d.added.top.length) top.append(el("p", "rp-empty", "Nothing new arrived this week."));
    for (const t of d.added.top) top.append(row(t.title, t.count > 1 ? t.count + " episodes" : "1 item"));

    const log = $("rpFixes"); log.replaceChildren();
    if (!d.autopilot.recent.length) log.append(el("p", "rp-empty", "Autopilot had nothing to fix."));
    for (const f of d.autopilot.recent) { const r = row(f.title, when(f.at)); r.title = f.detail || ""; log.append(r); }

    const svc = $("rpServices"); svc.replaceChildren();
    if (!health.ok) svc.append(el("p", "rp-empty", "Couldn't check the apps."));
    else for (const [name, s] of Object.entries(health.data.services)) svc.append(row(name, s.up ? s.ms + " ms" : "not answering", s.up ? "up" : "down"));
  }

  gate({ message: "Sign in to see the weekly report.", onReady: load });
})();

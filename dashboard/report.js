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
    const ppl = d.watched?.people || [];
    $("rpStats").replaceChildren(
      stat("Added", String(d.added.episodes + d.added.films), `${d.added.episodes} episodes, ${d.added.films} films`),
      stat("Downloaded", gb(d.added.bytes), "this week"),
      stat("Watched", d.watched ? String(d.watched.titles) : "–", d.watched ? (ppl.map(p => p.user + " " + p.titles).join(" · ") || "titles, nobody yet") : "watch data unavailable"),
      stat("Fixed by Autopilot", String(d.autopilot.total), d.autopilot.total ? d.autopilot.rules.map(r => r.count + " " + (RULE_WORDS[r.rule] || r.rule)).join(", ") : "nothing needed fixing"),
      stat("Media drive", d.disk ? gb(d.disk.free) + " free" : "–", d.disk ? Math.round(d.disk.used / d.disk.total * 100) + "% of " + gb(d.disk.total) + " used" : ""),
      stat("Full in", weeks != null ? weeks + " wk" : "–", d.disk?.perDay ? "at about " + gb(d.disk.perDay) + " a day" : "no forecast yet", weeks != null && weeks < 8)
    );

    const fresh = $("rpNew"); fresh.replaceChildren();
    if (!d.added.titles.length) fresh.append(el("p", "rp-empty", "Nothing new arrived this week."));
    for (const t of d.added.titles) fresh.append(row(t.title, (t.tv ? t.count + (t.count === 1 ? " episode" : " episodes") : "Film") + " · " + gb(t.bytes)));

    const seen = $("rpWatched"); seen.replaceChildren();
    if (!d.watched) seen.append(el("p", "rp-empty", "Couldn't read watch history."));
    else if (!d.watched.top.length) seen.append(el("p", "rp-empty", "Nobody watched anything this week."));
    for (const w of d.watched?.top || []) seen.append(row(w.name, w.viewers.join(", ")));

    const log = $("rpFixes"); log.replaceChildren();
    if (!d.autopilot.recent.length) log.append(el("p", "rp-empty", "Autopilot had nothing to fix."));
    for (const f of d.autopilot.recent) { const r = row(f.title, when(f.at)); if (f.detail) r.append(el("small", "rp-sub", f.detail)); log.append(r); }

    const disk = $("rpDisk"); disk.replaceChildren();
    if (d.disk) {
      const pct = Math.round(d.disk.used / d.disk.total * 100), bar = el("div", "rp-bar"), fill = el("i"); fill.style.width = pct + "%"; bar.append(fill);
      disk.append(bar, row("Added in the last 30 days", gb(d.disk.monthBytes)),
        row("Already watched by everyone", d.disk.reclaimTitles ? gb(d.disk.reclaimBytes) + " in " + d.disk.reclaimTitles + " titles" : "nothing to clear"));
      const go = el("a", "rp-link", "Review cleanup suggestions ›"); go.href = "/media/"; disk.append(go);
    } else disk.append(el("p", "rp-empty", "Couldn't read the drive."));

    const svc = $("rpServices"); svc.replaceChildren();
    if (!health.ok) svc.append(el("p", "rp-empty", "Couldn't check the apps."));
    else for (const [name, s] of Object.entries(health.data.services)) svc.append(row(name, s.up ? s.ms + " ms" : "not answering", s.up ? "up" : "down"));
  }

  gate({ message: "Sign in to see the weekly report.", onReady: load });
})();

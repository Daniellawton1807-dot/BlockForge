/* Homebase Overview: what's going on, at a glance.
   Public (always): server load (Glances via /api/metrics), app health (/api/health), the app list (config.js).
   After sign-in: the three TVs, downloads + Autopilot, tonight's episodes, Minecraft, and the real drives. */
(() => {
  const { $, el, icon, api, gate, TVS } = Hub;
  const cfg = window.HOMEBASE_CONFIG || { services: [] };
  const GB = 1073741824;
  const size = b => { b = Number(b) || 0; return b >= 1024 * GB ? (b / 1024 / GB).toFixed(1) + " TB" : Math.round(b / GB) + " GB"; };
  const pct = n => n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const clock = d => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const summary = {};

  // ---------- greeting ----------
  const hour = new Date().getHours();
  $("ovGreeting").textContent = (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening") + ", Daniel";
  $("ovDate").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  function paintSummary() {
    const bits = [];
    if (summary.playing != null) bits.push(summary.playing ? plural(summary.playing, "TV") + " playing" : "Nothing on the TVs");
    if (summary.tonight != null && summary.tonight) bits.push(plural(summary.tonight, "new episode") + " tonight");
    if (summary.downloading != null) bits.push(summary.downloading ? summary.downloading + " downloading" : "Downloads quiet");
    if (summary.attention) bits.push(plural(summary.attention, "thing") + " need" + (summary.attention === 1 ? "s" : "") + " you");
    if (summary.mc != null) bits.push(summary.mc === false ? "Minecraft off" : "Minecraft: " + (summary.mc ? summary.mc + " playing" : "online"));
    if (summary.down != null) bits.push(summary.down ? plural(summary.down, "app") + " down" : "All apps up");
    $("ovSummary").textContent = bits.join(" · "); $("ovSummary").hidden = !bits.length;
  }

  // ---------- server health (public) ----------
  let metrics = null, drives = null;
  function bar(p, cls) { const b = el("div", "hub-bar-line" + (cls ? " " + cls : "")), i = el("i"); i.style.width = Math.max(2, Math.min(100, p || 0)) + "%"; b.append(i); return b; }
  function tile(k, v, d, p, warn) {
    const s = el("div", "hub-stat" + (warn ? " warn" : "")), val = el("div", "v");
    if (Array.isArray(v)) val.append(document.createTextNode(v[0]), el("small", null, v[1])); else val.textContent = v;
    s.append(el("div", "k", k), val);
    if (p != null) { const b = bar(p, p >= 90 ? "" : "good"); b.style.marginTop = "10px"; s.append(b); }
    s.append(el("div", "d", d || "")); if (p != null) s.lastChild.style.marginTop = "8px";
    return s;
  }
  function paintServer() {
    const box = $("ovServer"); box.replaceChildren();
    const m = metrics || {};
    const cpu = pct(m.cpuPercent), ram = pct(m.memoryPercent);
    box.append(tile("CPU", cpu == null ? "–" : [cpu, "%"], cpu == null ? "Monitoring not answering" : "right now", cpu));
    box.append(tile("Memory", ram == null ? "–" : [ram, "%"], m.memoryUsedBytes ? size(m.memoryUsedBytes) + " of " + size(m.memoryTotalBytes) : "", ram));
    const media = drives?.find(d => d.kind === "media"), system = drives?.find(d => d.kind === "system");
    if (media) {
      const p = Math.round(100 * media.used / media.total), days = drives.forecast?.daysLeft;
      box.append(tile("Media drive", [size(media.free), " free"], `${p}% of ${size(media.total)} used` + (days ? ` · full in ~${days > 365 ? "a year+" : days > 60 ? Math.round(days / 30) + " months" : days + " days"}` : ""), p, p >= 90));
    } else box.append(tile("Media drive", "–", "Sign in to see your media drive"));
    const sys = system ? { p: Math.round(100 * system.used / system.total), free: system.free, total: system.total } : m.diskTotalBytes ? { p: pct(m.diskPercent), free: m.diskTotalBytes - m.diskUsedBytes, total: m.diskTotalBytes } : null;
    box.append(sys ? tile("System disk", [size(sys.free), " free"], `${sys.p}% of ${size(sys.total)} used`, sys.p, sys.p >= 90) : tile("System disk", "–", ""));
    $("connectionLabel").textContent = metrics ? "Monitoring connected" : "Monitoring not answering";
  }
  async function loadMetrics() {
    try { const r = await fetch("/api/metrics", { cache: "no-store" }); metrics = r.ok ? await r.json() : null; } catch { metrics = null; }
    $("ovUpdated").textContent = "Updated " + clock(Date.now()); paintServer();
  }

  // ---------- apps (public) ----------
  let health = {};
  const TONES = { purple: "#8f7dff", blue: "#4ea2ff", green: "#3fbf8a", orange: "#f0a43c" };
  function paintApps() {
    const box = $("ovApps"), q = $("ovAppSearch").value.trim().toLowerCase(); box.replaceChildren();
    let up = 0, checked = 0;
    for (const s of cfg.services || []) {
      const h = health[s.name], local = !h && /^http:\/\/(192\.168|10\.|localhost)/.test(s.url || "");
      if (h) { checked++; if (h.up) up++; }
      if (q && !(s.name + " " + (s.desc || "")).toLowerCase().includes(q)) continue;
      const a = el("a", "ov-app"); a.href = s.url || "#"; a.target = "_blank"; a.rel = "noopener";
      const ic = el("span", "ov-app-ic", s.icon || s.name[0]); ic.style.background = TONES[s.tone] || "var(--accent)";
      const txt = el("span", "ov-app-txt"); txt.append(el("b", null, s.name), el("small", null, (s.desc || "").replace(/ — URL to be added/, "")));
      const dot = el("i", "ov-dot " + (h ? (h.up ? "up" : "down") : local ? "local" : ""));
      dot.title = h ? (h.up ? "Answering" + (h.ms ? ` (${h.ms} ms)` : "") : "Not answering" + (h.status ? ` (HTTP ${h.status})` : "")) : local ? "Home network only" : "Checking…";
      a.append(ic, txt, dot); box.append(a);
    }
    if (!box.childNodes.length) box.append(el("div", "hub-note", "No app matches."));
    $("ovAppsUp").textContent = checked ? `${up} of ${checked} answering` : "";
    if (checked) { summary.down = checked - up; paintSummary(); }
  }
  $("ovAppSearch").addEventListener("input", paintApps);
  async function loadHealth() {
    try { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok) health = (await r.json()).services || {}; } catch {}
    paintApps();
  }

  // ---------- private glance cards ----------
  const body = id => $(id).querySelector(".ov-body");
  const line = (main, sub, extra) => { const r = el("div", "ov-line"); const t = el("div", "ov-line-txt"); t.append(el("b", null, main)); if (sub) t.append(el("small", null, sub)); if (extra) r.append(extra); r.append(t); return r; };
  const quiet = text => el("div", "ov-quiet", text);

  async function loadTvs() {
    const keys = Object.keys(TVS);
    const res = await Promise.all(keys.map(k => api("/api/tv/api/status?tv=" + encodeURIComponent(k))));
    const b = body("ovTv"); b.replaceChildren(); let playing = 0;
    keys.forEach((k, i) => {
      const r = res[i], p = r.ok && r.data.playing;
      const dot = el("i", "ov-dot " + (p ? (p.paused ? "paused" : "up") : r.ok && r.data.online ? "idle" : ""));
      if (p) playing++;
      b.append(line(TVS[k], p ? (p.paused ? "Paused · " : "") + [p.title, p.subtitle].filter(Boolean).join(" · ") : r.ok ? (r.data.online ? "On, nothing playing" : "Off") : "Couldn't reach it", dot));
    });
    summary.playing = playing; paintSummary();
  }
  async function loadDownloads() {
    const [d, a] = await Promise.all([api("/api/downloads"), api("/api/autopilot")]);
    const b = body("ovDl"); b.replaceChildren();
    if (!d.ok) { b.append(quiet("Couldn't load downloads.")); return; }
    const items = d.data.items || [];
    const active = items.filter(i => i.lifecycle === "downloading" || i.lifecycle === "importing");
    const stuck = items.filter(i => i.lifecycle === "blocked" || i.lifecycle === "failed").length;
    const needs = (a.ok && a.data.lastRun?.needsYou?.length) || 0;
    summary.downloading = active.length; summary.attention = stuck + needs; paintSummary();
    if (!active.length) b.append(quiet(stuck + needs ? "Nothing downloading." : "Nothing downloading. All quiet."));
    for (const i of active.slice(0, 3)) {
      const row = line(i.label || String(i.name || "").replace(/[._]+/g, " "), i.lifecycle === "importing" ? i.status || "Importing" : Math.round(Number(i.progress) || 0) + "%" + (/paused/i.test(i.status || "") ? " · paused" : ""));
      if (i.lifecycle === "downloading") { const bl = bar(i.progress); bl.style.marginTop = "6px"; row.querySelector(".ov-line-txt").append(bl); }
      b.append(row);
    }
    if (active.length > 3) b.append(quiet("and " + (active.length - 3) + " more"));
    if (stuck + needs) { const w = el("div", "ov-warn"); w.append(icon("info"), el("span", null, plural(stuck + needs, "item") + " need" + (stuck + needs === 1 ? "s" : "") + " you")); b.append(w); }
  }
  async function loadTonight() {
    const r = await api("/api/media/calendar?days=1"), b = body("ovTonight"); b.replaceChildren();
    if (!r.ok) { b.append(quiet("Couldn't load the calendar.")); return; }
    const today = new Date().toDateString();
    const eps = (r.data.items || []).filter(i => i.mediaType === "tv" && new Date(i.date).toDateString() === today);
    summary.tonight = eps.length; paintSummary();
    if (!eps.length) { b.append(quiet("Nothing new from your shows today.")); return; }
    for (const e of eps.slice(0, 4)) {
      const th = el("span", "ov-thumb"); if (e.fanartUrl || e.posterUrl) th.style.backgroundImage = `url("${String(e.fanartUrl || e.posterUrl).replace(/["\\]/g, "")}")`;
      b.append(line(e.title, [e.code, e.hasFile ? "ready to watch" : clock(e.date)].join(" · "), th));
    }
    if (eps.length > 4) b.append(quiet("and " + (eps.length - 4) + " more"));
  }
  async function loadMinecraft() {
    const r = await api("/api/tv/api/minecraft"), b = body("ovMc"); b.replaceChildren();
    if (!r.ok) { b.append(quiet("Couldn't reach Crafty.")); return; }
    const s = r.data; summary.mc = s.running ? s.online : false; paintSummary();
    b.append(line(s.running ? `Online · ${s.online} of ${s.max} playing` : "Switched off", s.running ? "Minecraft " + (s.version || "") : "Start it from the Minecraft page", el("i", "ov-dot " + (s.running ? "up" : ""))));
    if (s.running && s.players.length) {
      const chips = el("div", "ov-chips");
      for (const n of s.players.slice(0, 6)) { const c = el("span", "ov-chip"), img = el("img"); img.alt = ""; img.loading = "lazy"; img.src = "https://mc-heads.net/avatar/" + encodeURIComponent(n) + "/32"; c.append(img, document.createTextNode(n)); chips.append(c); }
      b.append(chips);
    }
  }
  async function loadDrives() {
    const r = await api("/api/storage?summary=1");
    if (r.ok) { drives = r.data.drives || []; drives.forecast = r.data.forecast; paintServer(); }
  }

  function loadPrivate() { loadTvs(); loadDownloads(); loadTonight(); loadMinecraft(); loadDrives(); }
  gate({ message: "Sign in to see your TVs, downloads, tonight's episodes and the Minecraft server.", onReady() {
    loadPrivate();
    setInterval(() => { if (!document.hidden) { loadTvs(); loadDownloads(); loadMinecraft(); } }, 20000);
  } });
  loadMetrics(); loadHealth(); paintServer(); paintApps();
  setInterval(() => { if (!document.hidden) loadMetrics(); }, 15000);
  setInterval(() => { if (!document.hidden) loadHealth(); }, 120000);
})();

/* Homebase Overview: what's going on, at a glance.
   Public (always): server load (Glances via /api/metrics), app health (/api/health), the app list (config.js).
   After sign-in: the three TVs, downloads + Autopilot, tonight's episodes, Minecraft, and the real drives. */
(() => {
  const { $, el, icon, api, gate, TVS, store, toast, errorText } = Hub;
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
    hero(keys, res);
  }
  // the big card at the top: what's on a TV right now, else a calm "nothing playing"
  function hero(keys, res) {
    const i = res.findIndex(r => r.ok && r.data.playing), p = i >= 0 ? res[i].data.playing : null;
    $("ovHeroK").textContent = p ? (p.paused ? "Paused" : "Now playing") + " · " + TVS[keys[i]] : "Tonight";
    $("ovHeroT").textContent = p ? p.title || "Playing" : "Nothing playing";
    $("ovHeroS").textContent = p ? [p.subtitle, p.runtime > 0 ? left(Math.max(0, p.runtime - p.position)) : ""].filter(Boolean).join(" · ") : "The TVs are idle. Pick something to watch.";
    const track = $("ovHeroTrack"); track.hidden = !(p && p.runtime > 0);
    if (!track.hidden) track.firstElementChild.style.width = Math.min(100, Math.round(p.position / p.runtime * 100)) + "%";
    $("ovHeroGo").textContent = p ? "Open the remote" : "Browse the media hub"; $("ovHeroGo").href = p ? "/remote/" : "/media/";
    $("ovHeroBg").style.backgroundImage = p ? `url("/api/tv/img/${encodeURIComponent(p.backdrop || p.thumb)}"), var(--cin-fallback)` : "";
  }
  const left = s => s >= 3600 ? Math.floor(s / 3600) + "h " + Math.round(s % 3600 / 60) + "m left" : Math.max(1, Math.round(s / 60)) + " min left";
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
      const row = line(i.label || String(i.name || "").replace(/[._]+/g, " "), i.lifecycle === "importing" ? i.status || "Importing" : Math.round(Number(i.progress) || 0) + "%" + (/paused/i.test(i.status || "") ? " · paused" : i.etaSeconds > 0 ? " · " + left(i.etaSeconds) : ""));
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
  const METHODS = { DirectPlay: ["Direct play", "good"], DirectStream: ["Direct stream", "info"], Transcode: ["Transcoding", "warn"] };
  const REASONS = { ContainerNotSupported: "container", VideoCodecNotSupported: "video codec", AudioCodecNotSupported: "audio codec", SubtitleCodecNotSupported: "subtitles", VideoBitrateNotSupported: "bitrate", ContainerBitrateExceedsLimit: "bitrate", AudioChannelsNotSupported: "audio channels", AudioProfileNotSupported: "audio profile", VideoProfileNotSupported: "video profile", VideoLevelNotSupported: "video level", RefFramesNotSupported: "ref frames", DirectPlayError: "playback error" };
  const mins = s => Math.round(s / 60);
  async function loadWatching() {
    const r = await api("/api/tv/api/sessions"), b = body("ovWatch"); b.replaceChildren();
    if (!r.ok) { b.append(quiet("Couldn't reach Jellyfin.")); $("ovWatchCount").textContent = ""; return; }
    const list = r.data.sessions || [], heavy = list.filter(s => s.transcode && s.transcode.what.includes("video") && !s.transcode.hw).length;
    $("ovWatchCount").textContent = list.length ? plural(list.length, "stream") : "";
    if (!list.length) { b.append(quiet("Nobody's watching Jellyfin right now.")); return; }
    for (const s of list) {
      const th = el("span", "ov-thumb"); th.style.backgroundImage = `url("/api/tv/img/${encodeURIComponent(s.id)}")`;
      const [label, tone] = METHODS[s.method] || [s.method, "info"], t = s.transcode;
      const badge = el("span", "ov-badge " + tone + (t && t.what.includes("video") && !t.hw ? " heavy" : ""), label);
      const detail = [s.paused ? "Paused" : null, [s.title, s.subtitle].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
      const row = line(detail, `${s.user} · ${s.device || s.client}` + (s.runtime ? ` · ${mins(s.position)} of ${mins(s.runtime)} min` : ""), th);
      row.classList.add("ov-watch-row"); row.append(badge);
      if (t) {
        const why = [...new Set(t.reasons.map(x => REASONS[x] || x.replace(/NotSupported$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()))];
        const note = el("small", "ov-watch-note", `Converting ${t.what.join(" and ")}${t.hw ? " with " + t.hw : " in software"}` + (t.kbps ? ` · ${(t.kbps / 1000).toFixed(1)} Mbps` : "") + (why.length ? ` · because of ${why.join(", ")}` : ""));
        row.querySelector(".ov-line-txt").append(note);
      }
      b.append(row);
    }
    if (heavy) { const w = el("div", "ov-warn"); w.append(icon("info"), el("span", null, plural(heavy, "stream") + " " + (heavy === 1 ? "is" : "are") + " transcoding video in software, which can load the CPU")); b.append(w); }
  }
  async function loadDrives() {
    const r = await api("/api/storage?summary=1");
    if (r.ok) { drives = r.data.drives || []; drives.forecast = r.data.forecast; paintServer(); }
  }

  // ---------- notifications on this device ----------
  const PUSH_ORDER = ["ready", "requests", "attention", "disk", "minecraft", "f1"];
  const keyBytes = k => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((k.length + 3) % 4)), c => c.charCodeAt(0));
  const deviceName = () => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : /Mac/.test(navigator.platform) ? "Mac" : "Computer";
  async function loadNotify() {
    const sec = $("ovNotify"), box = $("ovNotifyBody"), state = $("ovNotifyState"); sec.hidden = false; box.replaceChildren();
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) {
      state.textContent = "Not available here";
      box.append(ios && !installed
        ? el("p", "ov-quiet", "On iPhone, notifications only work once Homebase is on your Home Screen: tap Share, then Add to Home Screen, then open Homebase from its new icon and turn them on here.")
        : el("p", "ov-quiet", "This browser can't show notifications."));
      return;
    }
    const info = await api("/api/push");
    if (!info.ok) { state.textContent = ""; box.append(el("p", "ov-quiet", errorText(info, "Notifications aren't available right now."))); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const id = store.get("hb_push_id", ""), me = (info.data.devices || []).find(d => d.id === id);
    if (!sub || !me) {
      state.textContent = "Off on this device";
      box.append(el("p", "ov-quiet", "Get a notification when something you asked for is ready, Mum requests something, a download needs you, the media drive fills up or the Minecraft server stops."));
      const on = el("button", "hub-btn primary"); on.type = "button"; on.append(icon("bell"), el("span", null, "Turn on notifications"));
      on.onclick = async () => {
        on.disabled = true;
        try {
          if (await Notification.requestPermission() !== "granted") { toast("Notifications are blocked for Homebase in this browser's settings.", "error"); on.disabled = false; return; }
          sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.data.publicKey) });
          const r = await api("/api/push", { method: "POST", body: { action: "subscribe", subscription: sub.toJSON(), name: deviceName() } });
          if (!r.ok) throw new Error(errorText(r, "Couldn't save this device."));
          store.set("hb_push_id", r.data.id); toast("Notifications are on for this " + deviceName() + "."); loadNotify();
        } catch (error) { toast(error.message || "Couldn't turn notifications on.", "error"); on.disabled = false; }
      };
      const row = el("div", "sh-actions"); row.style.marginTop = "12px"; row.append(on); box.append(row);
      return;
    }
    state.textContent = "On for this " + me.name + ((info.data.devices || []).length > 1 ? ` · ${info.data.devices.length} devices` : "");
    const list = el("div", "ov-notify-list");
    for (const key of PUSH_ORDER) {
      const label = info.data.types?.[key]; if (!label) continue;
      const on = me.prefs?.[key] !== false, rowEl = el("div", "ov-notify-row"), sw = el("button", "ap-switch" + (on ? " on" : ""));
      sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", on); sw.setAttribute("aria-label", label); sw.append(el("i"));
      sw.onclick = async () => {
        const next = !sw.classList.contains("on"); sw.classList.toggle("on", next); sw.setAttribute("aria-checked", next);
        const r = await api("/api/push", { method: "POST", body: { action: "prefs", id: me.id, prefs: { [key]: next } } });
        if (!r.ok) { sw.classList.toggle("on", !next); toast(errorText(r, "Couldn't save that."), "error"); }
      };
      rowEl.append(el("span", null, label), sw); list.append(rowEl);
    }
    box.append(list);
    const test = el("button", "hub-btn small"); test.type = "button"; test.append(icon("bell"), el("span", null, "Send a test"));
    test.onclick = async () => { const r = await api("/api/push", { method: "POST", body: { action: "test", id: me.id } }); toast(r.ok ? (r.data.sent ? "Sent. It should arrive in a few seconds." : "The test didn't go through. Try turning notifications off and on again here.") : errorText(r, "Couldn't send a test."), r.ok && r.data.sent ? {} : "error"); };
    const off = el("button", "hub-btn small ghost"); off.type = "button"; off.append(el("span", null, "Turn off on this device"));
    off.onclick = async () => { await api("/api/push", { method: "POST", body: { action: "unsubscribe", id: me.id } }); try { await sub.unsubscribe(); } catch {} store.set("hb_push_id", ""); toast("Notifications are off for this device."); loadNotify(); };
    const row = el("div", "sh-actions"); row.style.marginTop = "14px"; row.append(test, off); box.append(row);
  }

  // the notifications section can be folded away; the choice is remembered on this device
  function paintNotifyFold() {
    const hidden = store.get("hb_notify_hidden", "") === "1", btn = $("ovNotifyToggle");
    $("ovNotifyBody").hidden = hidden; btn.textContent = hidden ? "Show" : "Hide"; btn.setAttribute("aria-expanded", String(!hidden));
  }
  $("ovNotifyToggle").onclick = () => { store.set("hb_notify_hidden", store.get("hb_notify_hidden", "") === "1" ? "" : "1"); paintNotifyFold(); };
  paintNotifyFold();

  function loadPrivate() { loadTvs(); loadDownloads(); loadTonight(); loadMinecraft(); loadWatching(); loadDrives(); loadNotify(); }
  gate({ message: "Sign in to see your TVs, downloads, tonight's episodes and the Minecraft server.", onReady() {
    loadPrivate();
    setInterval(() => { if (!document.hidden) { loadTvs(); loadDownloads(); loadMinecraft(); loadWatching(); } }, 20000);
  } });
  loadMetrics(); loadHealth(); paintServer(); paintApps();
  setInterval(() => { if (!document.hidden) loadMetrics(); }, 15000);
  setInterval(() => { if (!document.hidden) loadHealth(); }, 120000);
})();

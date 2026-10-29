/* Homebase Media hub: For You, Coming up, Library and Downloads, plus search across everything, with sheets for
   requesting (straight to Sonarr/Radarr) and managing titles down to single episodes.
   Built on the /api/media/* and /api/downloads Pages Functions; For You and "play on TV" come from tvbot
   through /api/tv/*. Everything is rendered with textContent, never innerHTML. */
(() => {
  const { $, el, icon, store, toast, openSheet, closeSheet, sheetOpen, skeleton, rail, api, errorText, gate, TVS, TV_SUFFIX } = Hub;
  const VIEWS = ["foryou", "upcoming", "library", "downloads"];
  let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get("hb_media_view", "foryou");
  if (!VIEWS.includes(view)) view = "foryou";
  let services = [], library = [], forYou = null, forYouError = "", recent = null, calendar = null, calendarAt = 0, downloads = null;
  let libFilter = store.get("hb_lib_filter", "all"), libSort = store.get("hb_lib_sort", "added"), upFilter = "all";
  let searching = false, searchTimer, searchSeq = 0, remoteResults = null, remoteError = "";
  let dlTimer = null, spotTimer = null, flashDownload = "", dlShape = "", showDismissedDownloads = false;
  const dismissedDownloadHistory = new Set();
  try { for (const id of JSON.parse(localStorage.getItem("hb_dismissed_download_history") || "[]")) dismissedDownloadHistory.add(String(id)); } catch {}

  // ---------- formatting ----------
  const tmdb = (path, w = "w342") => path ? `https://image.tmdb.org/t/p/${w}${path}` : "";
  const bg = url => url ? `url("${String(url).replace(/["\\\n]/g, "")}")` : "";
  const typeName = t => t === "tv" ? "Series" : "Film";
  const size = b => { b = Number(b) || 0; if (!b) return ""; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(b >= 100 || i < 2 ? 0 : 1) + " " + u[i]; };
  const dateText = (d, opts = { day: "numeric", month: "short", year: "numeric" }) => { const t = Date.parse(d); return t ? new Date(t).toLocaleDateString([], opts) : ""; };
  const timeText = d => { const t = Date.parse(d); return t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; };
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
  function dayLabel(t) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - today) / 86400000);
    return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : new Date(t).toLocaleDateString([], { weekday: "long" });
  }
  const code = (s, e) => "S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0");
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // which library entry (if any) is this title?
  function inLibrary(item) {
    const type = item.mediaType;
    return library.find(l => l.mediaType === type && ((item.tmdbId && l.tmdbId === Number(item.tmdbId)) || (type === "tv" && item.tvdbId && l.tvdbId === Number(item.tvdbId)))) || null;
  }
  const svc = key => services.find(s => s.key === key);
  const missingOf = l => l.mediaType === "tv" ? Math.max(0, l.episodeCount - l.episodeFileCount) : (l.sizeOnDisk ? 0 : 1);
  function mostCommon(values) { const c = {}; let best = null; for (const v of values) { if (v == null || v === "") continue; c[v] = (c[v] || 0) + 1; if (best == null || c[v] > c[best]) best = v; } return best; }

  // ---------- small UI pieces ----------
  function button(label, cls, onClick, iconName) {
    const b = el("button", "hub-btn " + (cls || "")); b.type = "button";
    if (iconName) b.append(icon(iconName));
    if (label) b.append(el("span", null, label));
    b.onclick = onClick; return b;
  }
  function iconButton(name, label, cls, onClick) { const b = el("button", "hub-icon-btn " + (cls || "")); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.append(icon(name)); b.onclick = onClick; return b; }
  // two taps to confirm anything destructive
  function armed(b, confirmLabel, onConfirm) {
    let timer = null; const original = b.title, label = b.querySelector("span")?.textContent;
    const reset = () => { timer = null; b.classList.remove("armed"); b.title = original; const s = b.querySelector("span"); if (s) s.textContent = label; };
    b.onclick = async () => {
      if (!timer) { b.classList.add("armed"); b.title = confirmLabel; const s = b.querySelector("span"); if (s) s.textContent = confirmLabel; timer = setTimeout(reset, 4000); return; }
      clearTimeout(timer); reset(); b.disabled = true; await onConfirm(); b.disabled = false;
    };
    return b;
  }
  const note = (title, text) => { const n = el("div", "hub-note"); if (title) n.append(el("b", null, title)); if (text) n.append(document.createTextNode(text)); return n; };
  function sectionHead(kicker, title, aside) {
    const h = el("div", "hub-section-head"), left = el("div");
    left.append(el("div", "kicker", kicker)); if (title) left.append(el("h3", null, title));
    h.append(left); if (aside) h.append(typeof aside === "string" ? el("span", "aside", aside) : aside); return h;
  }
  function section(kicker, title, aside) { const s = el("section", "hub-section"); s.append(sectionHead(kicker, title, aside)); return s; }
  function tile({ poster, title, sub, badge, badgeClass, rating, progress, onClick }, i = 0) {
    const t = el("button", "hub-tile"); t.type = "button"; t.style.setProperty("--i", i);
    const art = el("div", "art" + (poster ? "" : " empty"), poster ? null : title); if (poster) art.style.backgroundImage = bg(poster);
    if (badge) art.append(el("span", "hub-badge " + (badgeClass || ""), badge));
    if (rating) { const r = el("span", "rating"); r.append(icon("star"), document.createTextNode(Number(rating).toFixed(1))); art.append(r); }
    if (progress != null) { const p = el("div", "hub-progress"), bar = el("i"); bar.style.width = Math.max(2, Math.min(100, progress)) + "%"; p.append(bar); art.append(p); }
    t.append(art, el("div", "t", title), el("div", "s", sub || "")); t.onclick = onClick; return t;
  }
  function grid(items, toTile) { const g = el("div", "hub-grid"); items.forEach((x, i) => g.append(toTile(x, i))); return g; }
  function stat(k, v, d, cls) { const s = el("div", "hub-stat " + (cls || "")), val = el("div", "v"); if (Array.isArray(v)) val.append(document.createTextNode(v[0]), el("small", null, v[1] || "")); else val.textContent = v; s.append(el("div", "k", k), val, el("div", "d", d || "")); return s; }
  function pill(text, cls, iconName) { const p = el("span", "hub-pill " + (cls || "")); if (iconName) p.append(icon(iconName)); p.append(document.createTextNode(text)); return p; }
  function libraryTile(l, i) {
    const tv = l.mediaType === "tv", miss = missingOf(l);
    return tile({ poster: l.posterUrl, title: l.title, sub: tv ? `${l.episodeFileCount} of ${l.episodeCount} episodes` : [l.year, l.sizeOnDisk ? size(l.sizeOnDisk) : "Not downloaded"].filter(Boolean).join(" · "),
      badge: miss && (l.monitored || !tv) ? (tv ? miss + " missing" : "Missing") : null, badgeClass: "missing",
      progress: tv && l.episodeCount && l.episodeFileCount < l.episodeCount ? 100 * l.episodeFileCount / l.episodeCount : null, onClick: () => openLibraryItem(l) }, i);
  }

  // ---------- loading ----------
  async function loadBasics() {
    const [cfg, lib] = await Promise.all([api("/api/media/config"), api("/api/media/library")]);
    services = cfg.ok ? cfg.data.services || [] : services;
    library = lib.ok ? lib.data.items || [] : library;
    const ready = services.filter(s => s.connected).length, status = $("arrStatus");
    status.className = "hub-status " + (cfg.ok && ready === services.length ? "ok" : "warn");
    status.lastChild.textContent = cfg.ok ? (ready === services.length ? "Sonarr & Radarr online" : `${ready} of ${services.length} connected`) : "Media services offline";
    $("arrConnectionLabel").textContent = cfg.ok ? `${ready} of ${services.length} Sonarr/Radarr connected` : errorText(cfg, "Couldn't reach Sonarr and Radarr.");
  }
  function visibleDownloadItems() {
    return (downloads?.items || []).filter(item => item.lifecycle !== "failed" || showDismissedDownloads || !dismissedDownloadHistory.has(String(item.id)));
  }
  function saveDismissedDownloadHistory() {
    try { localStorage.setItem("hb_dismissed_download_history", JSON.stringify([...dismissedDownloadHistory])); } catch {}
  }
  function setDownloadHistoryDismissed(item, dismissed) {
    const id = String(item.id || "");
    if (!id) return;
    if (dismissed) dismissedDownloadHistory.add(id); else dismissedDownloadHistory.delete(id);
    saveDismissedDownloadHistory();
    toast(dismissed ? "Failed entry hidden from Homebase on this device." : "Failed entry restored to Homebase.", dismissed ? {} : {});
    drawDownloads();
  }
  function downloadShape(items) {
    return (items || []).map(i => [i.id || i.name, i.lifecycle, i.stage || "", /paused/i.test(i.status || "")].join(":")).sort().join("|");
  }
  function patchDownloadsInPlace() {
    const v = $("view"), stats = v.querySelector(".hub-stats");
    if (!stats || !downloads || downloads.error) return drawDownloads();
    const items = visibleDownloadItems();
    const values = downloadStats(items).map(x => [x[1], x[2]]), failed = items.filter(i => i.lifecycle === "failed" || i.lifecycle === "blocked");
    [...stats.children].forEach((card, index) => {
      if (!values[index]) return;
      const value = card.querySelector(".v"), detail = card.querySelector(".d");
      if (value) value.textContent = values[index][0];
      if (detail) detail.textContent = values[index][1];
      card.classList.toggle("warn", index === 3 && failed.length > 0);
    });
    const rows = new Map([...v.querySelectorAll(".hub-dl")].map(row => [row.dataset.id, row]));
    for (const item of items) {
      const row = rows.get(String(item.id || item.name));
      if (!row) continue;
      const pausedItem = /paused/i.test(item.status || ""), pct = Math.round(Number(item.progress) || 0);
      const status = row.querySelector(".dl-status"), etaNode = row.querySelector(".dl-eta");
      if (status) status.textContent = item.lifecycle === "importing" ? item.status || "Importing" : pausedItem ? "Paused · " + pct + "%" : pct + "%";
      const eta = item.lifecycle === "downloading" && !pausedItem && item.etaSeconds > 0
        ? (item.etaSeconds >= 3600 ? Math.floor(item.etaSeconds / 3600) + "h " + Math.round(item.etaSeconds % 3600 / 60) + "m left" : Math.max(1, Math.round(item.etaSeconds / 60)) + " min left") : "";
      if (etaNode) { etaNode.textContent = eta; etaNode.hidden = !eta; }
      const step = row.querySelector(".hub-stages span.now");
      if (step && item.lifecycle === "downloading") step.style.setProperty("--p", pct + "%");
    }
  }
  async function refreshDownloads() {
    const r = await api("/api/downloads");
    if (r.ok) downloads = r.data; else if (!downloads) downloads = { items: [], error: errorText(r, "Couldn't load the download queue.") };
    const items = downloads.items || [];
    const active = items.filter(i => i.lifecycle === "downloading" || i.lifecycle === "importing").length;
    $("dlCount").textContent = active || "";
    if (view === "downloads" && !searching) {
      const nextShape = downloadShape(items);
      // background refreshes never replay the fade-in; only switching tabs animates
      if (nextShape !== dlShape || !$("view").querySelector(".hub-stats")) { $("view").classList.add("quiet"); drawDownloads(); }
      else patchDownloadsInPlace();
    }
  }

  // ---------- views and tabs ----------
  function moveIndicator() {
    const on = document.querySelector("#tabs button.on"), ind = document.querySelector("#tabs .ind");
    ind.style.opacity = on ? "1" : "0"; if (!on) return;
    ind.style.width = on.offsetWidth + "px"; ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  addEventListener("resize", moveIndicator);
  document.fonts?.ready.then(moveIndicator);
  function setView(v) {
    view = v; store.set("hb_media_view", v);
    // after any sheet's history entry has been popped, so the hash lands on the right entry
    setTimeout(() => { try { history.replaceState(history.state, "", "#" + view); } catch {} }, 150);
    if (searching) { $("q").value = ""; $("searchBox").classList.remove("has-text"); searching = false; }
    document.querySelectorAll("#tabs button").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    moveIndicator();
    clearInterval(dlTimer); dlTimer = setInterval(() => { if (!document.hidden) refreshDownloads(); }, v === "downloads" ? 5000 : 20000);
    draw();
  }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => setView(b.dataset.view));
  function draw() {
    clearInterval(spotTimer); $("view").classList.remove("quiet");
    if (searching) return drawSearch();
    if (view === "foryou") return drawForYou();
    if (view === "upcoming") return drawUpcoming();
    if (view === "library") return drawLibrary();
    return drawDownloads();
  }
  const fresh = () => { const v = $("view"); v.replaceChildren(); return v; };

  // ---------- For You ----------
  async function drawForYou() {
    const v = fresh();
    if (!forYou || !recent) {
      v.append(el("div", "hub-skel spot")); const s = section("LOADING", "Picking things you'll like"); s.append(skeleton("rail", 8)); v.append(s);
      const [fy, rc] = await Promise.all([forYou ? null : api("/api/tv/api/foryou"), recent ? null : api("/api/media/recent")]);
      if (fy) { forYou = fy.ok && Array.isArray(fy.data) ? fy.data : []; forYouError = fy.ok ? "" : (fy.data?.code === "tv_setup_required" || fy.data?.code === "binding_missing" ? "For You needs the private connection to tvbot, which isn't set up in Cloudflare yet." : errorText(fy, "Couldn't load your recommendations.")); }
      if (rc) recent = rc.ok ? rc.data.items || [] : [];
      if (view !== "foryou" || searching) return;
      fresh();
    }
    const picks = forYou.map(f => ({ mediaType: f.type, tmdbId: Number(f.tmdb), title: f.title, year: Number(f.year) || null, overview: f.overview, posterUrl: tmdb(f.poster),
      backdropUrl: tmdb(f.backdrop, "w1280"), rating: Number(f.rating) || 0, because: f.because || [] })).filter(p => !inLibrary(p));

    if (picks.length) v.append(spotlight(picks.filter(p => p.backdropUrl).slice(0, 5)));
    else v.append(note(forYouError ? "Recommendations aren't available" : "Nothing new to suggest", forYouError || "Watch a few things and check back. Picks come from what you've watched lately."));

    const landed = [], seen = new Set();
    for (const r of recent || []) { const k = r.serviceKey + r.title; if (seen.has(k)) continue; seen.add(k); landed.push(r); }
    if (landed.length) {
      const s = section("JUST LANDED", "Recently downloaded", plural(landed.length, "title"));
      s.append(rail(landed.slice(0, 24).map((r, i) => {
        const mine = library.find(l => l.serviceKey === r.serviceKey && l.title === r.title);
        return tile({ poster: r.posterUrl || mine?.posterUrl, title: r.title, sub: r.episodeLabel || dateText(r.date, { day: "numeric", month: "short" }), badge: "New", badgeClass: "new",
          onClick: () => mine ? openLibraryItem(mine) : setView("library") }, i);
      })));
      v.append(s);
    }
    // a row for any show with plenty of picks, then everything else in one grid, each saying why
    const groups = new Map();
    for (const p of picks) { const k = p.because[0] || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    const extra = [];
    for (const [seed, list] of groups) {
      if (!seed || list.length < 5) { extra.push(...list); continue; }
      const s = section("BECAUSE YOU WATCHED", seed, plural(list.length, "pick"));
      s.append(rail(list.map((p, i) => pickTile(p, i, false)))); v.append(s);
    }
    if (extra.length) { const s = section("PICKED FOR YOU", "More you might like", plural(extra.length, "pick")); s.append(grid(extra, (p, i) => pickTile(p, i, true))); v.append(s); }
  }
  const pickTile = (p, i, why) => tile({ poster: p.posterUrl, title: p.title, sub: why && p.because[0] ? "Because you watched " + p.because[0] : [p.year, typeName(p.mediaType)].filter(Boolean).join(" · "),
    rating: p.rating >= 6 ? p.rating : null, onClick: () => openRequest(p) }, i);
  function spotlight(items) {
    if (!items.length) return el("div");
    const box = el("section", "hub-spot"), layers = [el("div", "bg"), el("div", "bg")], inner = el("div", "in"), dots = el("div", "dots");
    box.append(...layers, inner, dots);
    let at = -1, layer = 0;
    const show = n => {
      at = (n + items.length) % items.length; const p = items[at];
      layer ^= 1; layers[layer].style.backgroundImage = bg(p.backdropUrl); layers[layer].classList.add("on"); layers[layer ^ 1].classList.remove("on");
      const meta = el("div", "meta"); [p.year, typeName(p.mediaType)].filter(Boolean).forEach(x => meta.append(el("span", null, String(x))));
      if (p.rating) { const st = el("span", "star"); st.append(icon("star"), document.createTextNode(p.rating.toFixed(1))); meta.append(st); }
      const acts = el("div", "acts");
      acts.append(button(p.mediaType === "tv" ? "Request show" : "Request film", "primary", () => openRequest(p), "plus"), button("More info", "", () => openRequest(p), "info"));
      inner.replaceChildren(el("div", "why", p.because[0] ? "Because you watched " + p.because[0] : "Picked for you"), el("h2", null, p.title), meta, el("p", null, p.overview || ""), acts);
      inner.classList.remove("swap"); void inner.offsetWidth; inner.classList.add("swap");
      dots.querySelectorAll("button").forEach((d, i) => d.classList.toggle("on", i === at));
    };
    const restart = () => { clearInterval(spotTimer); if (items.length > 1) spotTimer = setInterval(() => { if (!document.hidden && !sheetOpen() && !box.matches(":hover")) show(at + 1); }, 8000); };
    items.forEach((p, i) => { const d = el("button"); d.type = "button"; d.setAttribute("aria-label", "Show " + p.title); d.onclick = () => { show(i); restart(); }; dots.append(d); });
    if (items.length < 2) dots.hidden = true;
    // swipe between picks on phones
    let sx = null; box.addEventListener("touchstart", e => { sx = e.touches[0].clientX; }, { passive: true });
    box.addEventListener("touchend", e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50) { show(at + (dx < 0 ? 1 : -1)); restart(); } });
    show(0); restart(); return box;
  }

  // ---------- Coming up ----------
  async function drawUpcoming() {
    const v = fresh();
    if (!calendar || Date.now() - calendarAt > 5 * 60000) {
      v.append(skeleton("list", 6));
      const r = await api("/api/media/calendar?days=21");
      calendar = r.ok ? r.data.items || [] : []; calendarAt = r.ok ? Date.now() : 0;
      if (view !== "upcoming" || searching) return;
      fresh(); if (!r.ok) { v.append(note("Couldn't load the calendar", errorText(r, "Sonarr and Radarr didn't answer."))); return; }
    }
    const tools = el("div", "hub-toolbar"), chips = el("div", "hub-chips");
    for (const [k, label] of [["all", "Everything"], ["tv", "Episodes"], ["movie", "Films"]]) {
      const c = el("button", "hub-chip" + (upFilter === k ? " on" : ""), label); c.type = "button"; c.onclick = () => { upFilter = k; drawUpcoming(); }; chips.append(c);
    }
    const items = calendar.filter(c => upFilter === "all" || c.mediaType === upFilter);
    tools.append(chips, el("div", "right", plural(items.length, "release") + " in the next 3 weeks")); v.append(tools);
    if (!items.length) { v.append(note("Nothing coming up", "New episodes of the shows you follow and films you're waiting for will show here.")); return; }
    const days = new Map();
    for (const c of items) { const t = Date.parse(c.date); const k = dayKey(t); if (!days.has(k)) days.set(k, { t, list: [] }); days.get(k).list.push(c); }
    for (const { t, list } of days.values()) {
      const s = section(dayLabel(t).toUpperCase(), new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }), plural(list.length, "release"));
      const g = el("div", "hub-cal");
      for (const c of list) g.append(calendarItem(c));
      s.append(g); v.append(s);
    }
  }
  function calendarItem(c) {
    const b = el("button", "hub-cal-item"); b.type = "button";
    const th = el("div", "th"); th.style.backgroundImage = bg(c.fanartUrl || c.posterUrl);
    const info = el("div", "info"), when = el("div", "when"), past = Date.parse(c.date) < Date.now();
    if (c.hasFile) { const tag = el("span", "hub-tag good"); tag.append(icon("check"), document.createTextNode("Downloaded")); when.append(tag); }
    else if (past && c.mediaType === "tv") when.append(el("span", "hub-tag warn", "Aired · not downloaded yet"));
    else when.append(el("span", "hub-tag accent", c.mediaType === "tv" ? timeText(c.date) : c.episodeTitle));
    if (c.network) when.append(el("span", "s", c.network));
    info.append(el("div", "t", c.title), el("div", "s", c.mediaType === "tv" ? [c.code, c.episodeTitle].filter(Boolean).join(" · ") : c.episodeTitle), when);
    b.append(th, info);
    b.onclick = () => openLibraryItem(library.find(l => l.serviceKey === c.serviceKey && l.id === c.id) || { serviceKey: c.serviceKey, id: c.id, title: c.title, mediaType: c.mediaType, posterUrl: c.posterUrl, fanartUrl: c.fanartUrl },
      c.mediaType === "tv" ? { season: Number(c.code.slice(1, 3)) } : {});
    return b;
  }

  // ---------- Library ----------
  function drawLibrary() {
    const v = fresh();
    if (!library.length) { v.append(note("Your library is empty", services.some(s => s.connected) ? "Search above to add your first show or film." : "Sonarr and Radarr aren't connected to Homebase.")); return; }
    const shows = library.filter(l => l.mediaType === "tv"), films = library.filter(l => l.mediaType === "movie");
    const missingEps = shows.filter(l => l.monitored).reduce((n, l) => n + missingOf(l), 0), missingFilms = films.filter(l => l.monitored && !l.sizeOnDisk).length;
    const onDisk = size(library.reduce((n, l) => n + (l.sizeOnDisk || 0), 0)) || "0 B";
    const stats = el("div", "hub-stats");
    stats.append(stat("Shows", String(shows.length), plural(shows.reduce((n, l) => n + l.episodeFileCount, 0), "episode") + " on disk"),
      stat("Films", String(films.length), films.filter(l => l.sizeOnDisk).length + " downloaded"),
      stat("Missing", String(missingEps + missingFilms), [missingEps && plural(missingEps, "episode"), missingFilms && plural(missingFilms, "film")].filter(Boolean).join(" · ") || "All caught up", missingEps + missingFilms ? "warn" : ""),
      stat("On disk", onDisk.split(" "), "Across " + plural(services.filter(s => s.connected).length, "service")));
    v.append(stats);

    const tools = el("div", "hub-toolbar"), chips = el("div", "hub-chips");
    const tvServices = services.filter(s => s.connected && s.type === "tv");
    const filters = [["all", "All"], ["tv", "Shows"], ["movie", "Films"], ["missing", "Missing"], ...(tvServices.length > 1 ? tvServices.map(s => [s.key, s.name]) : [])];
    for (const [k, label] of filters) { const c = el("button", "hub-chip" + (libFilter === k ? " on" : ""), label); c.type = "button"; c.onclick = () => { libFilter = k; store.set("hb_lib_filter", k); drawLibrary(); }; chips.append(c); }
    const sort = el("select", "hub-select"); sort.setAttribute("aria-label", "Sort");
    for (const [k, label] of [["added", "Recently added"], ["title", "A–Z"], ["year", "Newest first"], ["size", "Biggest first"], ["missing", "Most missing"]]) { const o = el("option", null, label); o.value = k; sort.append(o); }
    sort.value = libSort; sort.onchange = () => { libSort = sort.value; store.set("hb_lib_sort", libSort); drawLibrary(); };
    const items = library.filter(l => libFilter === "all" || l.mediaType === libFilter || l.serviceKey === libFilter || (libFilter === "missing" && missingOf(l) && (l.monitored || l.mediaType === "movie")));
    const cmp = { added: (a, b) => Date.parse(b.added || 0) - Date.parse(a.added || 0), title: (a, b) => a.title.localeCompare(b.title), year: (a, b) => (b.year || 0) - (a.year || 0),
      size: (a, b) => (b.sizeOnDisk || 0) - (a.sizeOnDisk || 0), missing: (a, b) => missingOf(b) - missingOf(a) }[libSort] || (() => 0);
    items.sort(cmp);
    const right = el("div", "right"); right.append(el("span", null, plural(items.length, "title")), sort);
    tools.append(chips, right); v.append(tools);
    v.append(items.length ? grid(items.slice(0, 800), libraryTile) : note("Nothing here", libFilter === "missing" ? "Everything you follow is downloaded." : "Try another filter."));
  }

  // ---------- Downloads ----------
  // the four numbers along the top: [label, value, detail, class]
  function downloadStats(items) {
    const downloading = items.filter(i => i.lifecycle === "downloading"), paused = downloading.filter(i => /paused/i.test(i.status || "")).length;
    const importing = items.filter(i => i.lifecycle === "importing").length, done = items.filter(i => i.lifecycle === "imported").length;
    const attention = items.filter(i => i.lifecycle === "failed" || i.lifecycle === "blocked").length;
    return [["Downloading", String(downloading.length - paused), paused ? plural(paused, "paused") : downloading.length ? Math.round(downloading.reduce((n, i) => n + (Number(i.progress) || 0), 0) / downloading.length) + "% average" : "Queue is empty"],
      ["Importing", String(importing), importing ? "Sonarr/Radarr moving files" : "Nothing waiting"],
      ["Finished", String(done), "Recently imported"],
      ["Attention", String(attention), attention ? "Blocked imports or failures" : "No problems", attention ? "warn" : ""]];
  }
  // Grabbed → Downloading → Importing → Imported, like Sonarr's Activity queue
  const STAGES = ["Grabbed", "Downloading", "Importing", "Imported"];
  function stageTrack(i) {
    const at = i.lifecycle === "imported" ? 3 : i.stage === "imported" ? 3 : i.lifecycle === "importing" || i.lifecycle === "blocked" ? 2 : 1;
    const track = el("div", "hub-stages" + (i.lifecycle === "blocked" ? " blocked" : ""));
    STAGES.forEach((label, n) => track.append(el("span", n < at || (n === at && i.lifecycle === "imported") ? "done" : n === at ? "now" : "", label)));
    // the Downloading step fills up as the download progresses
    if (at === 1) track.children[1].style.setProperty("--p", Math.round(Number(i.progress) || 0) + "%");
    return track;
  }
  function drawDownloads() {
    const v = fresh();
    if (!downloads) { v.append(skeleton("list", 4)); return; }
    if (downloads.error) { v.append(note("Couldn't load downloads", downloads.error)); return; }
    const items = visibleDownloadItems();
    dlShape = downloadShape(items);
    const active = items.filter(i => i.lifecycle === "downloading" || i.lifecycle === "importing"), done = items.filter(i => i.lifecycle === "imported"), failed = items.filter(i => i.lifecycle === "failed" || i.lifecycle === "blocked");
    const stats = el("div", "hub-stats");
    stats.append(...downloadStats(items).map(([k, v, d, cls]) => stat(k, v, d, cls)));
    v.append(stats);
    if (!items.length) { v.append(note("Nothing downloading", "Request something from For You or search, and it'll show up here.")); return; }
    for (const [kicker, title, list] of [["IN PROGRESS", "Downloading", active], ["NEEDS ATTENTION", "Blocked or failed", failed], ["DONE", "Recently finished", done]]) {
      const hiddenFailed = (downloads.items || []).filter(item => item.lifecycle === "failed" && dismissedDownloadHistory.has(String(item.id))).length;
      if (!list.length && !(kicker === "NEEDS ATTENTION" && hiddenFailed)) continue;
      const aside = kicker === "NEEDS ATTENTION" && hiddenFailed
        ? button(showDismissedDownloads ? "Hide dismissed" : "Show dismissed (" + hiddenFailed + ")", "small", () => { showDismissedDownloads = !showDismissedDownloads; drawDownloads(); })
        : plural(list.length, "item");
      const s = section(kicker, title, aside), box = el("div", "hub-list");
      for (const i of list) box.append(downloadRow(i));
      s.append(box); v.append(s);
    }
    if (flashDownload) {
      const words = flashDownload.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 3);
      const row = [...v.querySelectorAll(".hub-dl")].find(r => words.every(w => r.dataset.name.includes(w)));
      if (row) { flashDownload = ""; row.classList.add("hub-flash"); row.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  }
  function downloadRow(i) {
    const row = el("div", "hub-dl" + (i.lifecycle === "failed" || i.lifecycle === "blocked" ? " failed" : ""));
    row.dataset.id = String(i.id || i.name);
    row.dataset.name = String(i.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    const src = /sab/i.test(i.source) ? ["sab", "SAB"] : /qbit|torrent/i.test(i.source) ? ["qb", "qB"] : ["arr", (i.source || "?").slice(0, 2)];
    const paused = /paused/i.test(i.status || ""), pct = Math.round(Number(i.progress) || 0), info = el("div", "info");
    info.append(el("div", "nm", i.label || String(i.name || "Download").replace(/[._]+/g, " ")));
    if (i.label) info.append(el("div", "rel", i.name));
    const sub = el("div", "sub");
    const status = i.lifecycle === "failed" ? "Failed" : i.lifecycle === "blocked" ? "Import blocked" : i.lifecycle === "imported" ? "Imported " + dateText(i.eventDate, { day: "numeric", month: "short" }) : i.lifecycle === "importing" ? i.status || "Importing" : paused ? "Paused · " + pct + "%" : pct + "%";
    const eta = i.lifecycle === "downloading" && !paused && i.etaSeconds > 0 ? (i.etaSeconds >= 3600 ? Math.floor(i.etaSeconds / 3600) + "h " + Math.round(i.etaSeconds % 3600 / 60) + "m left" : Math.max(1, Math.round(i.etaSeconds / 60)) + " min left") : "";
    sub.append(el("span", "dl-status", status));
    const etaSpan = el("span", "dl-eta", eta); etaSpan.hidden = !eta; sub.append(etaSpan);
    [i.category, i.service, i.source].filter(Boolean).forEach(x => sub.append(el("span", null, x)));
    info.append(sub);
    if (i.lifecycle !== "failed") info.append(stageTrack(i));
    if (i.eventDetail && i.lifecycle !== "imported") info.append(el("div", "why", i.eventDetail));
    row.append(el("div", "src " + src[0], src[1]), info);
    const acts = el("div", "acts");
    if (i.lifecycle === "downloading") {
      acts.append(iconButton(paused ? "play" : "pause", paused ? "Resume" : "Pause", "", () => downloadAction(i, paused ? "resume" : "pause")));
      acts.append(armed(iconButton("trash", "Remove", "danger"), "Tap again to remove", () => downloadAction(i, "remove")));
    }
    if (i.lifecycle === "failed") {
      acts.append(button("Replace", "small", () => downloadAction(i, "replace"), "refresh"));
      const dismissed = dismissedDownloadHistory.has(String(i.id));
      const hide = button(dismissed ? "Restore" : "Dismiss", "small", () => setDownloadHistoryDismissed(i, !dismissed), dismissed ? "refresh" : "close");
      hide.title = dismissed ? "Restore this failed entry in Homebase" : "Hide this failed entry from Homebase on this device";
      acts.append(armed(hide, dismissed ? "Tap again to restore" : "Tap again to dismiss", () => setDownloadHistoryDismissed(i, !dismissed)));
    }
    if (acts.childNodes.length) row.append(acts);
    return row;
  }
  async function downloadAction(item, action) {
    const r = await api("/api/downloads", { method: "POST", body: { action, source: item.source, id: item.id, name: item.name, torrentHash: item.torrentHash, nzoId: item.nzoId } });
    toast(r.ok ? { pause: "Paused.", resume: "Resumed.", remove: "Removed from the queue.", replace: "Looking for a different release." }[action] : errorText(r, "That didn't work."), r.ok ? {} : "error");
    refreshDownloads();
  }
  function goToDownloads(name) { flashDownload = name || ""; closeSheet(); setView("downloads"); refreshDownloads(); scrollTo({ top: 0, behavior: "smooth" }); }
  const viewDownloads = { label: "View downloads", onClick: () => goToDownloads() };

  // ---------- search: your library first, then everything you could add ----------
  const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = $("q").value.trim(); $("searchBox").classList.toggle("has-text", Boolean(q));
    if (q.length < 2) { if (searching) { searching = false; setView(view); } return; }
    if (!searching) { searching = true; document.querySelectorAll("#tabs button").forEach(b => { b.classList.remove("on"); b.setAttribute("aria-selected", "false"); }); moveIndicator(); }
    remoteResults = null; drawSearch();
    searchTimer = setTimeout(() => runSearch(q), 350);
  });
  $("qClear").onclick = () => { $("q").value = ""; $("q").dispatchEvent(new Event("input")); $("q").focus(); };
  $("q").addEventListener("keydown", e => { if (e.key === "Escape" && $("q").value) { e.stopPropagation(); $("qClear").click(); } });
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") && !sheetOpen()) { e.preventDefault(); $("q").focus(); }
  });
  async function runSearch(q) {
    const seq = ++searchSeq;
    const r = await api("/api/media/search?q=" + encodeURIComponent(q));
    if (seq !== searchSeq || !searching) return;
    remoteResults = r.ok ? r.data.results || [] : []; remoteError = r.ok ? "" : errorText(r, "Search failed.");
    drawSearch();
  }
  function drawSearch() {
    const v = fresh(), q = norm($("q").value);
    const mine = library.filter(l => norm(l.title).includes(q)).sort((a, b) => (norm(b.title).startsWith(q) - norm(a.title).startsWith(q)) || Date.parse(b.added || 0) - Date.parse(a.added || 0));
    if (mine.length) { const s = section("IN YOUR LIBRARY", "Already yours", plural(mine.length, "match")); s.append(grid(mine.slice(0, 24), libraryTile)); v.append(s); }
    const s = section("ADD TO YOUR LIBRARY", "Request it");
    if (remoteResults == null) s.append(skeleton("grid", 6));
    else {
      const others = remoteResults.filter(r => !inLibrary(r));
      if (remoteError) s.append(note("Search didn't work", remoteError));
      else if (!others.length) s.append(note(mine.length ? "That's everything" : "No matches", mine.length ? "Everything matching is already in your library." : "Try a different spelling, or the year it came out."));
      else s.append(grid(others, (r, i) => tile({ poster: r.posterUrl, title: r.title, sub: [r.year, typeName(r.mediaType)].filter(Boolean).join(" · "), onClick: () => openRequest(r) }, i)));
    }
    v.append(s);
  }

  // ---------- sheets ----------
  function sheetHeader(body, { backdrop, poster, kicker, title, pills = [] }) {
    const wrap = el("div", "sh-banner-wrap"), banner = el("div", "sh-banner" + (backdrop ? "" : " blur"));
    banner.style.backgroundImage = bg(backdrop || poster); wrap.append(banner);
    const head = el("div", "sh-head"), art = el("div", "sh-poster"), txt = el("div", "sh-title");
    if (poster) art.style.backgroundImage = bg(poster);
    txt.append(el("div", "kicker", kicker), el("h2", null, title));
    const p = el("div", "hub-pills"); pills.filter(Boolean).forEach(x => p.append(x)); txt.append(p);
    head.append(art, txt);
    const content = el("div", "sh-content");
    body.append(wrap, head, content); return { content, pills: p };
  }
  function overview(text) { const p = el("p", "sh-overview", text || "No description yet."); p.onclick = () => p.classList.toggle("open"); return p; }
  function sheetSection(kicker, aside) { const s = el("div", "sh-section"); if (aside) { const h = el("div", "sh-section-head"); h.append(el("div", "kicker", kicker), aside); s.append(h); } else s.append(el("div", "kicker", kicker)); return s; }
  function select(label, options, value, onChange) {
    const f = el("label", "hub-field"), s = el("select");
    for (const [v, text] of options) { const o = el("option", null, text); o.value = v; s.append(o); }
    s.value = String(value); s.onchange = () => onChange(s.value); f.append(el("span", null, label), s); return f;
  }

  // request: not in your library yet
  const WHAT = [["all", "Every episode", "Everything that's aired, plus new ones"], ["latestSeason", "Latest season", "Just the newest season"],
    ["firstSeason", "First season", "Try it from the start"], ["future", "New episodes only", "From the next one that airs"], ["none", "I'll choose", "Add it, then pick episodes yourself"]];
  function openRequest(item) {
    const mine = inLibrary(item); if (mine) return openLibraryItem(mine);
    openSheet(body => {
      const tv = item.mediaType === "tv", choices = services.filter(s => s.connected && s.type === item.mediaType);
      const { content } = sheetHeader(body, { backdrop: item.backdropUrl || item.fanartUrl, poster: item.posterUrl, kicker: tv ? "SERIES" : "FILM", title: item.title,
        pills: [item.year && pill(String(item.year)), item.rating && pill(item.rating.toFixed(1), "", "star"), ...(item.genres || []).slice(0, 2).map(g => pill(g)), pill("Not in your library", "warn")] });
      if (item.because?.length) { const k = el("div", "kicker", "Because you watched " + item.because.join(", ")); k.style.marginBottom = "8px"; content.append(k); }
      content.append(overview(item.overview));
      if (!choices.length) { const n = note(tv ? "No Sonarr is connected" : "Radarr isn't connected", "Homebase can't add this until it's back."); n.style.marginTop = "16px"; content.append(n); return; }

      const pick = { serviceKey: (tv ? choices.find(s => s.key === "sonarr-daniel") : null)?.key || choices[0].key, monitorType: "all" };
      const defaults = key => {
        const s = svc(key), mineHere = library.filter(l => l.serviceKey === key), trim = p => String(p || "").replace(/\/+$/, "");
        const common = mostCommon(mineHere.map(l => trim(l.rootFolderPath)));
        pick.rootFolderPath = (s.rootFolders || []).find(f => trim(f.path) === common)?.path || s.rootFolders?.[0]?.path || "";
        const q = Number(mostCommon(mineHere.map(l => l.qualityProfileId)));
        pick.qualityProfileId = (s.qualityProfiles || []).some(p => p.id === q) ? q : s.qualityProfiles?.[0]?.id || 0;
      };
      defaults(pick.serviceKey);
      const foot = el("div", "sh-foot"), hint = el("div", "hint");
      const paintHint = () => { const s = svc(pick.serviceKey); hint.textContent = [s.name, pick.rootFolderPath, s.qualityProfiles?.find(q => q.id === pick.qualityProfileId)?.name].filter(Boolean).join(" · "); };
      if (tv) {
        const sec = sheetSection("WHAT TO GET"), opts = el("div", "hub-options");
        for (const [k, t, d] of WHAT) {
          const o = el("button", "hub-option" + (pick.monitorType === k ? " on" : "")); o.type = "button"; o.append(el("span", "t", t), el("span", "d", d));
          o.onclick = () => { pick.monitorType = k; opts.querySelectorAll(".hub-option").forEach(x => x.classList.toggle("on", x === o)); go.lastChild.textContent = k === "none" ? "Add show" : "Request show"; }; opts.append(o);
        }
        sec.append(opts); content.append(sec);
      }
      const more = el("details", "hub-more"), fields = el("div"); more.append(el("summary", null, "Where it goes and what quality"), fields);
      const fill = () => {
        fields.replaceChildren(); const s = svc(pick.serviceKey), row = el("div", "hub-fields");
        if (choices.length > 1) row.append(select(tv ? "Sonarr" : "Radarr", choices.map(c => [c.key, c.name]), pick.serviceKey, v => { pick.serviceKey = v; defaults(v); fill(); paintHint(); }));
        row.append(select("Folder", (s.rootFolders || []).map(f => [f.path, f.path + (f.freeSpace ? " · " + size(f.freeSpace) + " free" : "")]), pick.rootFolderPath, v => { pick.rootFolderPath = v; paintHint(); }));
        row.append(select("Quality", (s.qualityProfiles || []).map(q => [q.id, q.name]), pick.qualityProfileId, v => { pick.qualityProfileId = Number(v); paintHint(); }));
        fields.append(row);
      };
      fill(); content.append(more);

      const go = button(tv ? "Request show" : "Request film", "primary", async () => {
        go.disabled = true; go.lastChild.textContent = "Adding…";
        const searchOnAdd = pick.monitorType !== "none";
        const r = await api("/api/media/add", { method: "POST", body: { serviceKey: pick.serviceKey, mediaType: item.mediaType, tmdbId: item.tmdbId || 0, tvdbId: item.tvdbId || 0,
          rootFolderPath: pick.rootFolderPath, qualityProfileId: pick.qualityProfileId, monitored: true, searchOnAdd, monitorType: pick.monitorType, seasonFolder: true } });
        const already = r.status === 409 && r.data.code === "already_in_library";
        if (!r.ok && !already) { toast(errorText(r, "That request didn't go through."), "error"); go.disabled = false; go.lastChild.textContent = "Try again"; return; }
        if (forYou) forYou = forYou.filter(f => Number(f.tmdb) !== Number(item.tmdbId));
        await loadBasics();
        const m = library.find(l => l.serviceKey === pick.serviceKey && l.id === (r.data.item?.id || r.data.itemId)) || inLibrary(item);
        draw();
        const msg = already ? "It was already in your library." : !searchOnAdd ? `Added to ${svc(pick.serviceKey).name}. Pick the episodes you want below.`
          : `Added to ${svc(pick.serviceKey).name} and searching for ${tv ? "episodes" : "it"} now.`;
        // carry straight on to managing it
        if (m) openLibraryItem(m, { banner: msg, bannerAction: searchOnAdd && !already });
        else { closeSheet(); toast(msg, { action: viewDownloads }); }
      }, "plus");
      paintHint(); foot.append(hint, go); content.append(foot);
    });
  }

  // manage: what you already have
  async function openLibraryItem(lib, opts = {}) {
    let content, pillBox;
    openSheet(body => {
      ({ content, pills: pillBox } = sheetHeader(body, { backdrop: lib.fanartUrl, poster: lib.posterUrl, kicker: lib.mediaType === "tv" ? "SERIES · IN YOUR LIBRARY" : "FILM · IN YOUR LIBRARY", title: lib.title }));
      if (opts.banner) content.append(successBanner(opts.banner, opts.bannerAction));
      content.append(skeleton("list", 4));
    });
    const r = await api(`/api/media/details?serviceKey=${encodeURIComponent(lib.serviceKey)}&id=${lib.id}`);
    if (!content.isConnected) return;  // they moved on
    content.querySelector(".hub-list")?.remove();
    if (!r.ok) { content.append(note("Couldn't load this title", errorText(r, "Sonarr or Radarr didn't answer."))); return; }
    const d = r.data.item, tv = d.mediaType === "tv", s = svc(d.serviceKey);
    const quality = s?.qualityProfiles?.find(q => q.id === d.qualityProfileId)?.name;
    pillBox.replaceChildren(...[d.year && pill(String(d.year)), d.network && pill(d.network), pill(d.serviceName), quality && pill(quality),
      d.sizeOnDisk ? pill(size(d.sizeOnDisk)) : null, tv && d.status ? pill(d.status === "ended" ? "Ended" : "Continuing") : null,
      tv ? null : pill(d.hasFile ? "Downloaded" : "Not downloaded", d.hasFile ? "good" : "warn")].filter(Boolean));
    const block = el("div", "hub-sheet-body swap"); content.append(block);
    block.append(overview(d.overview));
    if (tv && d.episodeCount) {
      const prog = el("div", "sh-progress"), line = el("div", "hub-bar-line" + (d.episodeFileCount >= d.episodeCount ? " good" : "")), b = el("i");
      b.style.width = (100 * d.episodeFileCount / d.episodeCount) + "%"; line.append(b);
      prog.append(line, el("span", null, `${d.episodeFileCount} of ${plural(d.episodeCount, "episode")}`)); block.append(prog);
    }

    // actions: play on a TV, then the management buttons, then remove on its own
    const acts = el("div", "sh-actions"), split = el("div", "hub-split");
    // Play goes to the device you're holding unless you pick a TV for this title
    let tvKey = "here";
    const tvPick = el("select"); tvPick.setAttribute("aria-label", "Where to play");
    for (const [k, n] of [["here", "This device"], ...Object.entries(TVS).map(([k, n]) => [k, n.replace(" TV", "")])]) { const o = el("option", null, n); o.value = k; tvPick.append(o); }
    tvPick.value = tvKey;
    tvPick.onchange = () => { tvKey = tvPick.value; play.lastChild.textContent = tvKey === "here" ? (tv ? "Play" : "Play film") : "Play on " + TVS[tvKey].replace(" TV", ""); if (tvKey !== "here") store.set("jr_tv", tvKey); };
    const playable = tv ? d.episodeFileCount > 0 : d.hasFile;
    const play = button(tv ? "Play" : "Play film", "primary", () => playOnTv(d, null, () => tvKey), "play");
    play.disabled = !playable; if (!playable) play.title = "Nothing downloaded yet";
    split.append(play, tvPick); acts.append(split);
    acts.append(button(tv ? "Search missing" : "Search", "", () => act({ serviceKey: d.serviceKey, id: d.id, action: "search" }, tv ? "Searching for missing episodes." : "Searching for the film.", true), "search"));
    const refresh = iconButton("refresh", "Rescan files and metadata", "", () => act({ serviceKey: d.serviceKey, id: d.id, action: "refresh" }, "Rescanning files and metadata."));
    refresh.classList.add("tall");
    let monitored = d.monitored;
    const mon = button(monitored ? "Monitored" : "Not monitored", "", async () => {
      if (await act({ serviceKey: d.serviceKey, id: d.id, action: "monitor", value: !monitored }, !monitored ? "Now monitored: new episodes download automatically." : "No longer monitored.")) {
        monitored = !monitored; mon.replaceChildren(icon(monitored ? "bell" : "bellOff"), el("span", null, monitored ? "Monitored" : "Not monitored"));
        const l = library.find(x => x.serviceKey === d.serviceKey && x.id === d.id); if (l) l.monitored = monitored;
      }
    }, monitored ? "bell" : "bellOff");
    acts.append(mon, refresh);
    block.append(acts);
    // removing lives at the very bottom, apart from everything else
    const removeZone = el("div", "sh-section sh-danger"), txt = el("div");
    txt.append(el("b", null, tv ? "Remove this show" : "Remove this film"), el("span", null, "Deletes it from " + d.serviceName + " along with its files on disk."));
    removeZone.append(txt, armed(button("Remove", "danger small", null, "trash"), "Tap again to delete", async () => {
      if (await act({ serviceKey: d.serviceKey, id: d.id, action: tv ? "removeSeries" : "removeMovie" }, "Removed " + d.title + " and its files.")) { closeSheet(); await loadBasics(); draw(); }
    }));
    const finish = () => block.append(removeZone);

    if (!tv) {
      const files = d.files || []; if (!files.length) return finish();
      const sec = sheetSection("FILE");
      for (const f of files) { const p = el("div", "hub-pills"); [f.quality, f.mediaInfo?.resolution, f.mediaInfo?.videoCodec, f.mediaInfo?.audioCodec, size(f.size)].filter(Boolean).forEach(x => p.append(pill(x))); sec.append(p, el("div", "sh-path", f.relativePath || "")); }
      block.append(sec); finish(); return;
    }
    // seasons and episodes
    const seasons = (d.seasons || []).filter(x => d.episodes.some(e => e.seasonNumber === x.seasonNumber)).sort((a, b) => (a.seasonNumber || 99) - (b.seasonNumber || 99));
    if (!seasons.length) return finish();
    const aired = e => !e.airDate || Date.parse(e.airDate) <= Date.now();
    let season = opts.season != null && seasons.some(x => x.seasonNumber === opts.season) ? opts.season
      : (seasons.find(x => x.seasonNumber > 0 && d.episodes.some(e => e.seasonNumber === x.seasonNumber && !e.hasFile && e.monitored && aired(e))) || seasons.filter(x => x.seasonNumber > 0).pop() || seasons[0]).seasonNumber;
    const chips = el("div", "hub-chips"), sec = sheetSection("EPISODES", chips), list = el("div");
    const drawSeason = () => {
      chips.querySelectorAll(".hub-chip").forEach(c => c.classList.toggle("on", Number(c.dataset.s) === season));
      list.replaceChildren(); list.className = ""; void list.offsetWidth; list.className = "hub-sheet-body swap";
      const eps = d.episodes.filter(e => e.seasonNumber === season).sort((a, b) => a.episodeNumber - b.episodeNumber);
      const missing = eps.filter(e => aired(e) && !e.hasFile && !e.download), have = eps.filter(e => e.hasFile).length;
      const queued = eps.filter(e => !e.hasFile && e.download);
      const downloading = queued.filter(e => ["Downloading", "Importing"].includes(e.download.state)).length;
      const waiting = queued.length - downloading;
      const head = el("div", "sh-progress"), line = el("div", "hub-bar-line" + (missing.length ? "" : " good")), b = el("i");
      b.style.width = (eps.length ? 100 * have / eps.length : 0) + "%"; line.append(b);
      const summary = `${have} of ${eps.length} downloaded` + (downloading ? ` · ${downloading} downloading` : "") + (waiting ? ` · ${waiting} queued` : "");
      head.append(line, el("span", null, summary));
      if (missing.length) head.append(button(`Get ${missing.length} missing`, "small", () => act({ serviceKey: d.serviceKey, id: d.id, action: "requestSeason", seasonNumber: season }, `Looking for ${plural(missing.length, "episode")}.`, true), "download"));
      head.style.margin = "0 0 6px"; list.append(head);
      for (const e of eps) list.append(episodeRow(d, e, () => tvKey));
    };
    for (const x of seasons) { const c = el("button", "hub-chip", x.seasonNumber === 0 ? "Specials" : "Season " + x.seasonNumber); c.type = "button"; c.dataset.s = x.seasonNumber; c.onclick = () => { season = x.seasonNumber; drawSeason(); }; chips.append(c); }
    sec.append(list); block.append(sec); drawSeason(); finish();

    // while anything in this show is downloading, follow it live from qBittorrent/SABnzbd (Sonarr's own
    // queue only catches up about once a minute): poll every 3s, count the ETA down every second, and
    // reload the episodes once a download has been imported
    const downloadingNow = () => d.episodes.some(e => !e.hasFile && e.download);
    if (!downloadingNow()) return;
    const seen = new Set(); let reloading = false;
    const alive = () => list.isConnected && sheetOpen();
    const paint = () => list.querySelectorAll(".hub-ep[data-ep]").forEach(row => {
      const e = d.episodes.find(x => String(x.id) === row.dataset.ep); if (!e || e.hasFile || !e.download) return;
      row.querySelector(".sub").textContent = episodeSub(e);
      const fill = row.querySelector(".episode-download-progress i"); if (fill) fill.style.width = Math.max(0, Math.min(100, Number(e.download.progress) || 0)) + "%";
    });
    const sync = async () => {
      if (!alive()) return stop();
      await refreshDownloads();
      const live = new Map((downloads?.items || []).filter(i => i.downloadId).map(i => [String(i.downloadId).toLowerCase(), i]));
      let finished = false;
      for (const e of d.episodes) {
        if (e.hasFile || !e.download?.downloadId) continue;
        const it = live.get(e.download.downloadId);
        if (!it) { if (seen.has(e.id)) finished = true; continue; }
        seen.add(e.id);
        const paused = /paused/i.test(it.status || "");
        e.download.state = it.lifecycle === "importing" ? "Importing" : it.lifecycle === "blocked" ? "Needs attention" : it.lifecycle === "imported" ? "Imported" : paused ? "Paused" : "Downloading";
        e.download.progress = it.lifecycle === "downloading" ? Number(it.progress) || 0 : 100;
        e.download.etaSec = it.lifecycle === "downloading" && !paused && it.etaSeconds > 0 ? it.etaSeconds : null;
        if (it.lifecycle === "imported") finished = true;
      }
      if (!alive()) return stop();
      paint();
      if (finished && !reloading) {
        reloading = true;
        const fresh = await api(`/api/media/details?serviceKey=${encodeURIComponent(d.serviceKey)}&id=${d.id}`);
        reloading = false;
        if (fresh.ok && alive()) { d.episodes = fresh.data.item.episodes; d.episodeFileCount = fresh.data.item.episodeFileCount; seen.clear(); drawSeason(); }
      }
      if (!downloadingNow()) stop();
    };
    const tick = () => { if (!alive()) return stop(); for (const e of d.episodes) if (e.download?.etaSec > 0) e.download.etaSec--; paint(); };
    const pollTimer = setInterval(sync, 3000), tickTimer = setInterval(tick, 1000);
    function stop() { clearInterval(pollTimer); clearInterval(tickTimer); }
    sync();
    requestAnimationFrame(() => { const on = chips.querySelector(".hub-chip.on"); if (on) chips.scrollLeft = on.offsetLeft - chips.clientWidth / 2 + on.offsetWidth / 2; });
  }
  function successBanner(text, withDownloads) {
    const b = el("div", "hub-banner"); b.append(icon("check"), el("span", null, text));
    if (withDownloads) b.append(button("Follow in Downloads", "small", () => goToDownloads()));
    b.style.margin = "0 0 16px"; return b;
  }
  async function act(body, okText, showDownloads) {
    const r = await api("/api/media/manage", { method: "POST", body });
    toast(r.ok ? okText : errorText(r, "That didn't work."), r.ok ? (showDownloads ? { action: viewDownloads } : {}) : "error");
    if (r.ok && showDownloads) setTimeout(refreshDownloads, 4000);
    return r.ok;
  }
  // tvbot finds the title in Jellyfin by its TVDB/TMDB id, falling back to the name
  const playRef = d => d.mediaType === "tv" ? (d.tvdbId ? "tvdb:" + d.tvdbId : d.tmdbId ? "tmdb:" + d.tmdbId : d.title) : (d.tmdbId ? "tmdb:" + d.tmdbId : d.title);
  const JELLYFIN = "https://jellyfin.danielvault.uk";
  // play a title (or one episode) on this device via Jellyfin, or on a TV via tvbot
  async function playOnTv(d, e, getTarget) {
    const key = getTarget(), what = playRef(d) + (e ? ` season ${e.seasonNumber} episode ${e.episodeNumber}` : "");
    if (key === "here") {
      // tvbot waits on the server for Jellyfin to open on this device, then tells it to play (the browser
      // can't do the waiting: a phone pauses it as soon as the Jellyfin app comes to the front)
      const phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const win = phone ? null : window.open("", "_blank");  // opened during the tap so it isn't blocked
      const ask = { ref: playRef(d), season: e?.seasonNumber ?? null, episode: e?.episodeNumber ?? null, kind: phone ? "app" : "web" };
      const r = await api("/api/tv/api/playhere", { method: "POST", body: ask });
      const reply = r.data?.reply;
      if (!r.ok || reply?.status !== "armed") { win?.close(); toast(typeof reply === "string" ? reply : errorText(r, "Couldn't find that in Jellyfin."), "error"); return; }
      if (phone) {
        toast("Opening Jellyfin to play " + reply.name + "…");
        location.href = "org.jellyfin.expo://";  // the Jellyfin iOS app; it starts playing once it connects
        return;
      }
      const found = await api("/api/tv/api/locate?ref=" + encodeURIComponent(ask.ref) + (e ? `&season=${e.seasonNumber}&episode=${e.episodeNumber}` : ""));
      const url = found.ok && found.data.id ? `${JELLYFIN}/web/#/details?id=${encodeURIComponent(found.data.id)}&serverId=${encodeURIComponent(found.data.serverId || "")}` : JELLYFIN + "/web/";
      if (win) win.location.href = url; else location.href = url;
      toast("Playing " + reply.name + " in Jellyfin.");
      return;
    }
    const r = await api("/api/tv/cmd", { method: "POST", body: { text: "play " + what + TV_SUFFIX[key] } });
    toast(r.ok ? r.data.text || "Playing on " + TVS[key] + "." : errorText(r, "The TV didn't answer."), r.ok ? { action: { label: "Open remote", onClick: () => { location.href = "/remote/"; } } } : "error");
  }

  // "hh:mm:ss" / "d.hh:mm:ss" from Sonarr's queue, as seconds
  const etaFrom = t => { const m = String(t || "").match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/); return m ? ((+m[1] || 0) * 86400) + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : null; };
  const etaText = s => s == null || s < 0 ? "" : s >= 3600 ? Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m left" : Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") + " left";
  function episodeSub(e) {
    const future = Boolean(e.airDate) && Date.parse(e.airDate) > Date.now(), dl = !e.hasFile && e.download;
    if (dl && dl.etaSec === undefined) dl.etaSec = etaFrom(dl.eta);
    const queueLabel = dl ? [dl.state || "Grabbed", Number.isFinite(Number(dl.progress)) && dl.state !== "Importing" ? Math.round(Number(dl.progress)) + "%" : "", dl.state === "Downloading" ? etaText(dl.etaSec) : ""].filter(Boolean).join(" · ") : "";
    return [future ? "Airs " + dateText(e.airDate, { weekday: "short", day: "numeric", month: "short" }) : dateText(e.airDate), e.runtime ? e.runtime + " min" : "",
      e.hasFile ? [e.file?.quality, size(e.file?.size)].filter(Boolean).join(" · ") : queueLabel || (future ? "" : e.monitored ? "Wanted" : "Not monitored")].filter(Boolean).join(" · ");
  }
  function episodeRow(d, e, getTv) {
    const row = el("div", "hub-ep"), info = el("div", "info"), acts = el("div", "acts");
    row.dataset.ep = e.id;
    const future = Boolean(e.airDate) && Date.parse(e.airDate) > Date.now();
    const queued = !e.hasFile && e.download;
    const queueState = queued ? String(e.download.state || "Grabbed") : "";
    const dotClass = e.hasFile ? "have" : queued && ["Downloading", "Importing"].includes(queueState) ? "downloading" : queued ? "queued" : future ? "soon" : e.monitored ? "want" : "";
    const name = el("div", "nm"); name.append(el("i", "hub-dot " + dotClass), el("span", null, e.title || "Episode " + e.episodeNumber));
    info.append(name, el("div", "sub", episodeSub(e)));
    if (queued && Number.isFinite(Number(e.download.progress))) {
      const progressLine = el("div", "hub-bar-line episode-download-progress"), progressFill = el("i");
      progressFill.style.width = Math.max(0, Math.min(100, Number(e.download.progress))) + "%";
      progressLine.append(progressFill); info.append(progressLine);
    }
    info.onclick = () => { const m = row.querySelector(".more"); if (m) m.remove(); else if (e.overview) row.append(el("div", "more", e.overview)); };
    const busy = async fn => { row.classList.add("busy"); await fn(); row.classList.remove("busy"); };
    if (e.hasFile) acts.append(iconButton("play", "Play", "go", () => playOnTv(d, e, getTv)));
    else if (!future && !queued) {
      const get = iconButton("download", "Get this episode", "", () => busy(async () => {
        if (await act({ serviceKey: d.serviceKey, id: d.id, action: "requestEpisode", episodeId: e.id }, `Looking for ${code(e.seasonNumber, e.episodeNumber)}.`, true)) { e.monitored = true; get.classList.add("done"); get.replaceChildren(icon("check")); }
      }));
      acts.append(get);
    }
    if (!future) acts.append(iconButton("list", "Choose a release", "", () => openReleases(d, e)));
    if (e.hasFile) acts.append(armed(iconButton("trash", "Delete this file", "danger"), "Tap again to delete the file", () => busy(async () => {
      if (await act({ serviceKey: d.serviceKey, id: d.id, action: "removeEpisode", episodeId: e.id, episodeFileEpisodeIds: e.file?.episodeIds?.length ? e.file.episodeIds : [e.id] }, "Deleted the file.")) {
        e.hasFile = false; row.replaceWith(episodeRow(d, e, getTv));
      }
    })));
    row.append(el("div", "n", "E" + String(e.episodeNumber).padStart(2, "0")), info, acts);
    return row;
  }
  async function openReleases(d, e) {
    const back = () => openLibraryItem(library.find(l => l.serviceKey === d.serviceKey && l.id === d.id) || d, { season: e.seasonNumber });
    let content;
    openSheet(body => {
      ({ content } = sheetHeader(body, { backdrop: d.fanartUrl, poster: d.posterUrl, kicker: code(e.seasonNumber, e.episodeNumber) + " · CHOOSE A RELEASE", title: e.title || d.title, pills: [pill(d.title)] }));
      const top = el("div", "sh-actions"); top.style.marginTop = "0"; top.append(button("Back to " + d.title, "small ghost", back, "chevL")); content.append(top, skeleton("list", 5));
    });
    const r = await api(`/api/media/releases?serviceKey=${encodeURIComponent(d.serviceKey)}&seriesId=${d.id}&episodeId=${e.id}`);
    if (!content.isConnected) return;
    content.querySelector(".hub-list")?.remove();
    if (!r.ok) { content.append(note("Couldn't search for releases", errorText(r, "The indexers didn't answer."))); return; }
    const rel = (r.data.releases || []).sort((a, b) => (b.approved - a.approved) || ((b.score || 0) - (a.score || 0)) || ((b.seeders || 0) - (a.seeders || 0)));
    const good = rel.filter(x => !x.rejected), bad = rel.filter(x => x.rejected);
    const box = el("div", "hub-sheet-body swap"); content.append(box);
    if (!rel.length) { box.append(note("No releases found", "Nothing on your indexers matches this episode yet.")); return; }
    const sec = sheetSection(good.length ? "BEST MATCHES FIRST" : "NONE PASS YOUR QUALITY RULES", el("span", "aside", plural(rel.length, "release")));
    sec.style.cssText = "margin-top:8px;padding-top:0;border-top:0"; box.append(sec);
    const row = x => {
      const item = el("div", "hub-release" + (x.rejected ? " rejected" : "")), info = el("div");
      const p = el("div", "hub-pills"); [x.quality && pill(x.quality, x.approved ? "good" : ""), x.size && pill(size(x.size)), x.protocol === "torrent" && x.seeders != null ? pill(x.seeders + " seeders") : x.protocol && pill(x.protocol), x.indexer && pill(x.indexer),
        x.publishDate && pill(dateText(x.publishDate, { day: "numeric", month: "short" }))].filter(Boolean).forEach(y => p.append(y));
      info.append(el("div", "nm", x.title), p);
      if (x.rejected && x.rejections?.length) info.append(el("div", "why", x.rejections.join(" · ")));
      const grab = button("Grab", "small" + (x.approved ? " primary" : ""), async () => {
        grab.disabled = true; grab.lastChild.textContent = "Grabbing…";
        const g = await api("/api/media/releases", { method: "POST", body: { serviceKey: d.serviceKey, seriesId: d.id, episodeId: e.id, guid: x.guid, title: x.title, indexerId: x.indexerId } });
        if (!g.ok) { toast(errorText(g, "Couldn't grab that release."), "error"); grab.disabled = false; grab.lastChild.textContent = "Grab"; return; }
        toast("Sent to the downloader.");
        setTimeout(() => goToDownloads(x.title), 350);  // carry on to the queue, where it'll be highlighted
      }, "download");
      item.append(info, grab); return item;
    };
    good.slice(0, 50).forEach(x => sec.append(row(x)));
    if (bad.length) {
      const more = el("details", "hub-more"); more.append(el("summary", null, `${plural(bad.length, "release")} that don't match your quality rules`));
      bad.slice(0, 50).forEach(x => more.append(row(x))); sec.append(more);
    }
  }

  // the tab bar only gets its frosted background once it's stuck to the top
  const sentinel = el("div"); $("hubContent").prepend(sentinel);
  new IntersectionObserver(([e]) => document.querySelector(".hub-bar").classList.toggle("stuck", !e.isIntersecting)).observe(sentinel);

  // ---------- start ----------
  gate({ message: "Sign in to search, request and manage your media.", async onReady() {
    const v = fresh(); v.append(el("div", "hub-skel spot"), skeleton("rail", 8));
    await loadBasics(); refreshDownloads(); setView(view);
  } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && view === "downloads") refreshDownloads(); });
})();

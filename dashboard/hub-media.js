/* Homebase Media hub: For You, search, library and downloads as poster grids, with sheets for
   requesting (straight to Sonarr/Radarr) and managing titles down to single episodes.
   Built on the existing /api/media/* and /api/downloads Pages Functions; For You and "play on TV"
   come from tvbot through /api/tv/*. Everything is rendered with textContent, never innerHTML. */
(() => {
  const { $, el, store, toast, openSheet, closeSheet, api, errorText, gate, TVS, TV_SUFFIX } = Hub;
  let view = store.get("hb_media_view", "foryou");
  let services = [], library = [], forYou = null, results = [], downloads = { items: [] }, libFilter = "all";
  let searchTimer, searchSeq = 0, dlTimer = null;

  const tmdbPoster = path => path ? "https://image.tmdb.org/t/p/w342" + path : "";
  const bg = url => url ? `url("${String(url).replace(/["\\]/g, "")}")` : "";
  const typeName = t => t === "tv" ? "Series" : "Film";
  const size = b => { b = Number(b) || 0; if (!b) return ""; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(b >= 10 || i < 2 ? 0 : 1) + " " + u[i]; };
  const when = d => { const t = Date.parse(d); return t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : ""; };

  // which library entry (if any) is this title?
  function inLibrary(item) {
    const type = item.mediaType;
    return library.find(l => l.mediaType === type && ((item.tmdbId && l.tmdbId === Number(item.tmdbId)) || (type === "tv" && item.tvdbId && l.tvdbId === Number(item.tvdbId)))) || null;
  }
  const svc = key => services.find(s => s.key === key);
  function mostCommon(values) { const c = {}; let best = null; for (const v of values) { if (v == null || v === "") continue; c[v] = (c[v] || 0) + 1; if (best == null || c[v] > c[best]) best = v; } return best; }

  // ---------- loading ----------
  async function loadBasics() {
    const [cfg, lib] = await Promise.all([api("/api/media/config"), api("/api/media/library")]);
    services = cfg.ok ? cfg.data.services || [] : [];
    library = lib.ok ? lib.data.items || [] : [];
    const ready = services.filter(s => s.connected).length;
    $("arrConnectionLabel").textContent = cfg.ok ? `${ready} of ${services.length} Sonarr/Radarr connected` : errorText(cfg, "Couldn't reach Sonarr and Radarr.");
  }
  async function refreshDownloads() {
    const r = await api("/api/downloads");
    if (r.ok) downloads = r.data;
    const active = (downloads.items || []).filter(i => i.lifecycle === "downloading" || i.lifecycle === "importing").length;
    $("dlCount").textContent = active ? "· " + active : "";
    if (view === "downloads") drawDownloads(r.ok ? null : errorText(r, "Couldn't load the download queue."));
  }

  // ---------- views ----------
  function setView(v) {
    view = v; store.set("hb_media_view", v);
    document.querySelectorAll("#tabs button").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    $("libraryTools").hidden = v !== "library";
    $("searchBox").hidden = v === "downloads";
    $("q").placeholder = v === "library" ? "Filter your library" : "Search for any show or film, to watch or to request";
    clearInterval(dlTimer); if (v === "downloads") dlTimer = setInterval(() => { if (!document.hidden) refreshDownloads(); }, 10000);
    draw();
  }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => { if (b.dataset.view !== "search" || $("q").value.trim().length >= 2) setView(b.dataset.view); else { setView("search"); $("q").focus(); } });
  function draw() {
    if (view === "foryou") return drawForYou();
    if (view === "search") return drawSearch();
    if (view === "library") return drawLibrary();
    return drawDownloads();
  }
  const note = text => el("div", "hub-note", text);
  function grid(items, toTile) { const g = el("div", "hub-grid"); for (const i of items) g.append(toTile(i)); return g; }
  function tile({ poster, title, sub, badge, badgeClass, progress, onClick }) {
    const t = el("button", "hub-tile"); t.type = "button";
    const art = el("div", "art" + (poster ? "" : " empty"), poster ? null : "🎬"); if (poster) art.style.backgroundImage = bg(poster);
    if (badge) art.append(el("span", "hub-badge " + (badgeClass || ""), badge));
    if (progress != null) { const p = el("div", "hub-progress"), i = el("i"); i.style.width = Math.max(0, Math.min(100, progress)) + "%"; p.append(i); art.append(p); }
    t.append(art, el("div", "t", title), el("div", "s", sub || "")); t.onclick = onClick; return t;
  }

  async function drawForYou() {
    const v = $("view"); v.innerHTML = "";
    if (!forYou) {
      v.append(note("Finding things you'd like…"));
      const r = await api("/api/tv/api/foryou");
      if (view !== "foryou") return;
      if (!r.ok) { v.innerHTML = ""; v.append(note(r.data?.code === "tv_setup_required" || r.data?.code === "binding_missing" ? "For You needs the private connection to tvbot set up in Cloudflare." : errorText(r, "Couldn't load your recommendations."))); return; }
      forYou = Array.isArray(r.data) ? r.data : [];
      v.innerHTML = "";
    }
    const picks = forYou.map(f => ({ mediaType: f.type, tmdbId: Number(f.tmdb), title: f.title, year: Number(f.year) || null, overview: f.overview, posterUrl: tmdbPoster(f.poster), rating: f.rating, because: f.because || [] }))
      .filter(p => !inLibrary(p));
    v.append(el("p", "hub-note small", "Picked from what you've watched lately, and not in your library yet."));
    if (!picks.length) { v.append(note("Nothing to suggest right now. Watch a few things and check back.")); return; }
    v.append(grid(picks, p => tile({ poster: p.posterUrl, title: p.title, sub: "Because you watched " + (p.because[0] || "something"), onClick: () => openRequest(p) })));
  }

  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = $("q").value.trim();
    if (view === "library") return drawLibrary();
    if (q.length < 2) { results = []; if (view === "search") drawSearch(); return; }
    if (view !== "search") setView("search");
    searchTimer = setTimeout(() => runSearch(q), 380);
  });
  async function runSearch(q) {
    const seq = ++searchSeq; const v = $("view"); v.innerHTML = ""; v.append(note("Searching Sonarr and Radarr…"));
    const r = await api("/api/media/search?q=" + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    results = r.ok ? r.data.results || [] : [];
    drawSearch(r.ok ? null : errorText(r, "Search failed."));
  }
  function drawSearch(error) {
    const v = $("view"); v.innerHTML = "";
    if (error) { v.append(note(error)); return; }
    if ($("q").value.trim().length < 2) { v.append(note("Type at least two letters to search everything Sonarr and Radarr can find.")); return; }
    if (!results.length) { v.append(note("Nothing found.")); return; }
    v.append(grid(results, r => {
      const mine = inLibrary(r);
      const missing = mine && (mine.mediaType === "tv" ? mine.episodeFileCount < mine.episodeCount : !mine.sizeOnDisk);
      return tile({ poster: r.posterUrl, title: r.title, sub: [r.year, typeName(r.mediaType)].filter(Boolean).join(" · "),
        badge: mine ? (missing ? "In library · missing" : "In library") : null, badgeClass: mine ? (missing ? "missing" : "have") : "",
        onClick: () => mine ? openLibraryItem(mine) : openRequest(r) });
    }));
  }

  function drawLibrary() {
    const tools = $("libraryTools"); tools.innerHTML = "";
    const filters = [["all", "All"], ["tv", "Shows"], ["movie", "Films"], ...services.filter(s => s.connected).map(s => [s.key, s.name])];
    for (const [k, label] of filters) { const c = el("button", "hub-chip" + (libFilter === k ? " on" : ""), label); c.type = "button"; c.onclick = () => { libFilter = k; drawLibrary(); }; tools.append(c); }
    const q = $("q").value.trim().toLowerCase();
    const items = library.filter(l => (libFilter === "all" || l.mediaType === libFilter || l.serviceKey === libFilter) && (!q || l.title.toLowerCase().includes(q)))
      .sort((a, b) => Date.parse(b.added || 0) - Date.parse(a.added || 0));
    const v = $("view"); v.innerHTML = "";
    if (!items.length) { v.append(note(library.length ? "Nothing matches." : "Your library is empty, or Sonarr and Radarr aren't connected.")); return; }
    v.append(grid(items.slice(0, 600), l => {
      const tv = l.mediaType === "tv", have = tv ? l.episodeFileCount : (l.sizeOnDisk ? 1 : 0), all = tv ? l.episodeCount : 1;
      return tile({ poster: l.posterUrl, title: l.title, sub: tv ? `${l.episodeFileCount}/${l.episodeCount} episodes · ${l.serviceName}` : `${l.year || ""} · ${l.sizeOnDisk ? "On disk" : "Missing"}`,
        badge: have < all ? (tv ? "Missing " + (all - have) : "Missing") : null, badgeClass: "missing", onClick: () => openLibraryItem(l) });
    }));
  }

  function drawDownloads(error) {
    const v = $("view"); v.innerHTML = "";
    if (error) { v.append(note(error)); return; }
    const items = downloads.items || [];
    if (!items.length) { v.append(note("Nothing downloading right now.")); return; }
    const groups = [["Downloading", items.filter(i => i.lifecycle === "downloading" || i.lifecycle === "importing")], ["Recently finished", items.filter(i => i.lifecycle === "imported" || i.lifecycle === "failed")]];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      v.append(el("div", "hub-section-title", title));
      for (const i of list) {
        const row = el("div", "hub-release"), info = el("div", "info");
        const paused = /paused/i.test(i.status || ""), pct = Math.round(Number(i.progress) || 0);
        info.append(el("div", "nm", i.name), el("div", "sub", [i.source, i.category, i.lifecycle === "failed" ? "Failed" : i.status, pct + "%",
          i.etaSeconds != null && !paused && i.lifecycle === "downloading" ? "ETA " + Math.ceil(i.etaSeconds / 60) + " min" : ""].filter(Boolean).join(" · ")));
        if (i.lifecycle === "downloading" || i.lifecycle === "importing") { const p = el("div", "hub-progress"), b = el("i"); p.style.cssText = "position:relative;left:0;right:0;bottom:0;margin-top:7px"; b.style.width = pct + "%"; p.append(b); info.append(p); }
        if (i.eventDetail && i.lifecycle === "failed") info.append(el("div", "sub", i.eventDetail));
        row.append(info);
        if (i.lifecycle === "downloading") {
          const acts = el("div", "hub-actions"); acts.style.marginTop = "0";
          acts.append(button(paused ? "▶ Resume" : "Ⅱ Pause", "small", () => downloadAction(i, paused ? "resume" : "pause")));
          acts.append(confirmButton("Remove", "Tap again to remove", "small danger", () => downloadAction(i, "remove")));
          row.append(acts);
        }
        v.append(row);
      }
    }
  }
  async function downloadAction(item, action) {
    const r = await api("/api/downloads", { method: "POST", body: { action, source: item.source, id: item.id, name: item.name, torrentHash: item.torrentHash, nzoId: item.nzoId } });
    toast(r.ok ? (action === "pause" ? "Paused." : action === "resume" ? "Resumed." : "Removed.") : errorText(r, "That didn't work."));
    refreshDownloads();
  }

  // ---------- small UI helpers ----------
  function button(label, cls, onClick) { const b = el("button", "hub-btn " + (cls || ""), label); b.type = "button"; b.onclick = onClick; return b; }
  function confirmButton(label, confirmLabel, cls, onConfirm) {
    let armed = null; const b = button(label, cls);
    b.onclick = async () => {
      if (!armed) { b.textContent = confirmLabel; armed = setTimeout(() => { armed = null; b.textContent = label; }, 4000); return; }
      clearTimeout(armed); armed = null; b.disabled = true; b.textContent = "Working…"; await onConfirm(); b.disabled = false; b.textContent = label;
    };
    return b;
  }
  async function act(body, okText) {
    const r = await api("/api/media/manage", { method: "POST", body });
    toast(r.ok ? okText : errorText(r, "That didn't work.")); return r.ok;
  }
  function hero(body, { poster, title, meta, extra }) {
    const h = el("div", "hub-hero"), art = el("div", "art"), txt = el("div");
    if (poster) art.style.backgroundImage = bg(poster);
    txt.append(el("h2", null, title), el("div", "hub-meta", meta || ""));
    if (extra) txt.append(extra);
    h.append(art, txt); body.append(h);
  }
  function chipGroup(options, value, onPick) {
    const g = el("div", "hub-chips");
    const paint = v => g.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
    for (const [v, label] of options) { const c = el("button", "hub-chip", label); c.type = "button"; c.dataset.v = v; c.onclick = () => { paint(v); onPick(v); }; g.append(c); }
    paint(value); return g;
  }
  function select(label, options, value, onChange) {
    const f = el("label", "hub-field"), s = el("select");
    for (const [v, text] of options) { const o = el("option", null, text); o.value = v; s.append(o); }
    s.value = String(value); s.onchange = () => onChange(s.value); f.append(el("span", null, label), s); return f;
  }

  // ---------- request sheet (not in your library yet) ----------
  function openRequest(item) {
    const mine = inLibrary(item);
    if (mine) return openLibraryItem(mine);
    openSheet(body => {
      const choices = services.filter(s => s.connected && s.type === item.mediaType);
      hero(body, { poster: item.posterUrl, title: item.title,
        meta: [item.year, typeName(item.mediaType), (item.genres || []).slice(0, 3).join(", "), item.rating ? "★ " + item.rating : ""].filter(Boolean).join(" · ") });
      if (item.because?.length) body.append(el("div", "hub-meta", "Because you watched " + item.because.join(", ")));
      body.append(el("p", "hub-overview", item.overview || "No description yet."));
      if (!choices.length) { body.append(note(item.mediaType === "tv" ? "No Sonarr instance is connected." : "Radarr isn't connected.")); return; }

      const pick = { serviceKey: (item.mediaType === "tv" ? choices.find(s => s.key === "sonarr-daniel") : null)?.key || choices[0].key, monitorType: "all", searchOnAdd: true };
      const defaults = key => {
        const s = svc(key), mineHere = library.filter(l => l.serviceKey === key);
        pick.rootFolderPath = mostCommon(mineHere.map(l => (l.rootFolderPath || "").replace(/\/+$/, ""))) || s.rootFolders?.[0]?.path || "";
        if (!s.rootFolders?.some(f => f.path.replace(/\/+$/, "") === pick.rootFolderPath)) pick.rootFolderPath = s.rootFolders?.[0]?.path || "";
        else pick.rootFolderPath = s.rootFolders.find(f => f.path.replace(/\/+$/, "") === pick.rootFolderPath).path;
        pick.qualityProfileId = Number(mostCommon(mineHere.map(l => l.qualityProfileId))) || s.qualityProfiles?.[0]?.id || 0;
      };
      defaults(pick.serviceKey);

      if (item.mediaType === "tv") {
        const what = el("div", "hub-field"); what.append(el("span", null, "What to get")); body.append(what);
        what.append(chipGroup([["all", "Every episode"], ["future", "New episodes only"], ["latestSeason", "Latest season"], ["firstSeason", "First season"], ["none", "I'll pick episodes"]],
          pick.monitorType, v => { pick.monitorType = v; pick.searchOnAdd = v !== "none"; }));
      }
      const opts = el("details", "hub-more"); opts.append(el("summary", null, "Options: where it goes and what quality"));
      const fill = () => {
        while (opts.childNodes.length > 1) opts.lastChild.remove();
        const s = svc(pick.serviceKey);
        if (choices.length > 1) { const f = el("div", "hub-field"); f.append(el("span", null, item.mediaType === "tv" ? "Sonarr" : "Radarr"), chipGroup(choices.map(c => [c.key, c.name]), pick.serviceKey, v => { pick.serviceKey = v; defaults(v); fill(); })); opts.append(f); }
        opts.append(select("Folder", (s.rootFolders || []).map(f => [f.path, f.path + (f.freeSpace ? " · " + size(f.freeSpace) + " free" : "")]), pick.rootFolderPath, v => pick.rootFolderPath = v));
        opts.append(select("Quality", (s.qualityProfiles || []).map(q => [q.id, q.name]), pick.qualityProfileId, v => pick.qualityProfileId = Number(v)));
      };
      fill(); body.append(opts);

      const go = button(item.mediaType === "tv" ? "＋  Request show" : "＋  Request film", "primary", async () => {
        go.disabled = true; go.textContent = "Requesting…";
        const r = await api("/api/media/add", { method: "POST", body: { serviceKey: pick.serviceKey, mediaType: item.mediaType, tmdbId: item.tmdbId || 0, tvdbId: item.tvdbId || 0,
          rootFolderPath: pick.rootFolderPath, qualityProfileId: pick.qualityProfileId, monitored: true, searchOnAdd: pick.searchOnAdd, monitorType: pick.monitorType } });
        if (r.status === 409 && r.data.code === "already_in_library") { toast("It's already in " + svc(pick.serviceKey).name + "."); await loadBasics(); const m = inLibrary(item); if (m) openLibraryItem(m); return; }
        if (!r.ok) { toast(errorText(r, "That request didn't go through.")); go.disabled = false; go.textContent = "Try again"; return; }
        toast(`Requested ${item.title}${pick.searchOnAdd ? ". Searching for it now." : "."}`);
        if (forYou) forYou = forYou.filter(f => Number(f.tmdb) !== Number(item.tmdbId));
        await loadBasics(); draw();
        const m = library.find(l => l.serviceKey === pick.serviceKey && l.id === r.data.item?.id) || inLibrary(item);
        if (m && pick.monitorType === "none") openLibraryItem(m); else closeSheet();
      });
      const acts = el("div", "hub-actions"); acts.append(go); body.append(acts);
    });
  }

  // ---------- library sheet (manage what you have) ----------
  async function openLibraryItem(lib) {
    openSheet(body => { hero(body, { poster: lib.posterUrl, title: lib.title, meta: "Loading…" }); });
    const r = await api(`/api/media/details?serviceKey=${encodeURIComponent(lib.serviceKey)}&id=${lib.id}`);
    if (!r.ok) { toast(errorText(r, "Couldn't load that title.")); return; }
    const d = r.data.item, tv = d.mediaType === "tv";
    let season = null;
    openSheet(body => {
      const meta = [d.year, d.serviceName, tv ? `${d.episodeFileCount}/${d.episodeCount} episodes` : (d.hasFile ? "On disk" : "Missing"), size(d.sizeOnDisk), d.network].filter(Boolean).join(" · ");
      hero(body, { poster: d.posterUrl, title: d.title, meta });
      body.append(el("p", "hub-overview", d.overview || ""));

      // play it on a TV (tvbot works out the right episode)
      const playRow = el("div", "hub-actions");
      let tvKey = store.get("jr_tv", "living room"); if (!TVS[tvKey]) tvKey = "living room";
      const playBtn = button("▶  Play on " + TVS[tvKey], "primary", async () => {
        const res = await api("/api/tv/cmd", { method: "POST", body: { text: "play " + d.title + TV_SUFFIX[tvKey] } });
        toast(res.ok ? res.data.text || "Playing." : errorText(res, "The TV didn't answer."));
      });
      playRow.append(playBtn, chipGroup(Object.entries(TVS).map(([k, n]) => [k, n.replace(" TV", "")]), tvKey, v => { tvKey = v; store.set("jr_tv", v); playBtn.textContent = "▶  Play on " + TVS[v]; }));
      body.append(playRow);

      const acts = el("div", "hub-actions");
      acts.append(button(tv ? "Search for missing" : "Search for it", "", () => act({ serviceKey: d.serviceKey, id: d.id, action: "search" }, "Searching…")));
      acts.append(button("Refresh", "", () => act({ serviceKey: d.serviceKey, id: d.id, action: "refresh" }, "Refreshing from disk and metadata.")));
      let monitored = d.monitored;
      const mon = button(monitored ? "Monitored ✓" : "Not monitored", "", async () => {
        if (await act({ serviceKey: d.serviceKey, id: d.id, action: "monitor", value: !monitored }, !monitored ? "Now monitored." : "No longer monitored.")) { monitored = !monitored; mon.textContent = monitored ? "Monitored ✓" : "Not monitored"; }
      });
      acts.append(mon);
      acts.append(confirmButton(tv ? "Remove show" : "Remove film", tv ? "Tap again: delete the show and its files" : "Tap again: delete the film and its file", "danger", async () => {
        if (await act({ serviceKey: d.serviceKey, id: d.id, action: tv ? "removeSeries" : "removeMovie" }, "Removed " + d.title + ".")) { closeSheet(); await loadBasics(); draw(); }
      }));
      body.append(acts);

      if (!tv) {
        for (const f of d.files || []) body.append(el("div", "hub-meta", [f.quality, f.mediaInfo?.resolution, f.mediaInfo?.videoCodec, size(f.size), f.relativePath].filter(Boolean).join(" · ")));
        return;
      }
      // seasons and episodes
      const seasons = (d.seasons || []).filter(s => s.seasonNumber > 0 || d.episodes.some(e => e.seasonNumber === 0));
      if (!seasons.length) return;
      season = (seasons.find(s => d.episodes.some(e => e.seasonNumber === s.seasonNumber && !e.hasFile && e.monitored)) || seasons[seasons.length - 1]).seasonNumber;
      const seasonBox = el("div"); seasonBox.style.marginTop = "16px";
      const list = el("div");
      const drawSeason = () => {
        list.innerHTML = "";
        const eps = d.episodes.filter(e => e.seasonNumber === season), missing = eps.filter(e => !e.hasFile).length;
        const head = el("div", "hub-head"); head.style.margin = "12px 0 4px";
        head.append(el("div", "hub-meta", `${eps.length - missing} of ${eps.length} downloaded`));
        if (missing) head.append(button(`Get the ${missing} missing`, "small", () => act({ serviceKey: d.serviceKey, id: d.id, action: "requestSeason", seasonNumber: season }, `Getting ${missing} episode${missing > 1 ? "s" : ""}.`)));
        list.append(head);
        for (const e of eps) list.append(episodeRow(d, e));
      };
      seasonBox.append(chipGroup(seasons.map(s => [String(s.seasonNumber), s.seasonNumber === 0 ? "Specials" : "Season " + s.seasonNumber]), String(season), v => { season = Number(v); drawSeason(); }));
      seasonBox.append(list); body.append(seasonBox); drawSeason();
    });
  }
  function episodeRow(d, e) {
    const row = el("div", "hub-ep"), info = el("div", "info"), acts = el("div", "acts");
    const dot = el("span", "hub-dot " + (e.hasFile ? "have" : e.monitored ? "want" : ""));
    const name = el("div", "nm"); name.append(dot, document.createTextNode(e.title || "Episode " + e.episodeNumber));
    info.append(name, el("div", "sub", [when(e.airDate), e.hasFile ? [e.file?.quality, size(e.file?.size)].filter(Boolean).join(" ") : e.monitored ? "Wanted" : "Not monitored"].filter(Boolean).join(" · ")));
    if (!e.hasFile) acts.append(button("Get", "small", () => act({ serviceKey: d.serviceKey, id: d.id, action: "requestEpisode", episodeId: e.id }, "Getting " + (e.title || "it") + ".")));
    acts.append(button("Search", "small", () => act({ serviceKey: d.serviceKey, id: d.id, action: "searchEpisode", episodeId: e.id }, "Searching…")));
    acts.append(button("Pick", "small", () => openReleases(d, e)));
    if (e.hasFile) acts.append(confirmButton("Delete", "Sure?", "small danger", async () => {
      if (await act({ serviceKey: d.serviceKey, id: d.id, action: "removeEpisode", episodeId: e.id, episodeFileEpisodeIds: e.file?.episodeIds?.length ? e.file.episodeIds : [e.id] }, "Deleted the file.")) { e.hasFile = false; row.replaceWith(episodeRow(d, e)); }
    }));
    row.append(el("div", "n", "E" + String(e.episodeNumber).padStart(2, "0")), info, acts);
    return row;
  }
  async function openReleases(d, e) {
    openSheet(body => { hero(body, { poster: d.posterUrl, title: d.title, meta: `Finding releases for S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}…` }); });
    const r = await api(`/api/media/releases?serviceKey=${encodeURIComponent(d.serviceKey)}&seriesId=${d.id}&episodeId=${e.id}`);
    openSheet(body => {
      hero(body, { poster: d.posterUrl, title: d.title, meta: (r.ok ? r.data.episode.code + " · " + r.data.episode.title : "Releases"),
        extra: button("← Back to the show", "small", () => openLibraryItem(library.find(l => l.serviceKey === d.serviceKey && l.id === d.id) || d)) });
      if (!r.ok) { body.append(note(errorText(r, "Couldn't search for releases."))); return; }
      const rel = (r.data.releases || []).sort((a, b) => (b.approved - a.approved) || ((b.seeders || 0) - (a.seeders || 0)));
      if (!rel.length) { body.append(note("No releases found for this episode.")); return; }
      for (const x of rel.slice(0, 60)) {
        const row = el("div", "hub-release" + (x.rejected ? " rejected" : "")), info = el("div", "info");
        info.append(el("div", "nm", x.title), el("div", "sub", [x.quality, size(x.size), x.releaseType, x.indexer, x.protocol === "torrent" && x.seeders != null ? x.seeders + " seeders" : x.protocol].filter(Boolean).join(" · ")));
        if (x.rejected && x.rejections.length) info.append(el("div", "sub", "⚠ " + x.rejections.join("; ")));
        const grab = button("Grab", "small" + (x.approved ? " primary" : ""), async () => {
          grab.disabled = true; grab.textContent = "Grabbing…";
          const g = await api("/api/media/releases", { method: "POST", body: { serviceKey: d.serviceKey, seriesId: d.id, episodeId: e.id, guid: x.guid, title: x.title, indexerId: x.indexerId } });
          toast(g.ok ? g.data.message || "Grabbed." : errorText(g, "Couldn't grab that release.")); grab.textContent = g.ok ? "Queued ✓" : "Grab"; grab.disabled = g.ok;
        });
        row.append(info, grab); body.append(row);
      }
    });
  }

  // ---------- start ----------
  gate({ message: "Sign in to search, request and manage your media.", async onReady() {
    $("view").innerHTML = ""; $("view").append(note("Loading your library…"));
    await loadBasics(); refreshDownloads(); setView(startView(view));
  } });
  function startView(v) { return ["foryou", "search", "library", "downloads"].includes(v) ? (v === "search" ? "foryou" : v) : "foryou"; }
})();

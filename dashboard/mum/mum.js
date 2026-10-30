/* Films & Shows: Mum's request page (/mum/), added to her phone's home screen.
   Recommended for her, trending shows and films, and search. "Request" sends a show straight to her Sonarr
   or a film to her Radarr folder (functions/api/mum/*). Everything is rendered with textContent. */
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = d => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };
  const TICK = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z", CLOCK = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.5 2-1 1.7L11 13V7h2z";
  const poster = path => path ? `url("https://image.tmdb.org/t/p/w342${path}")` : "";
  const kindName = t => t === "tv" ? "Show" : "Film";
  const PLAY = "M8 5v14l11-7z", TV_ICON = "M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z";
  const LAYERS = "M12 3 2 8l10 5 10-5zm-8.2 9.2L2 13l10 5 10-5-1.8-.8L12 16.2zm0 4L2 17l10 5 10-5-1.8-.8L12 20.2z";
  const DOT = "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z";
  const runtimeText = m => m >= 60 ? Math.floor(m / 60) + "h " + (m % 60 ? (m % 60) + "m" : "") : m + " min";
  const seasonsText = i => i.seasons ? i.seasons + (i.seasons === 1 ? " season" : " seasons") + (i.episodes ? " · " + i.episodes + " episodes" : "") : "";
  const STATUS_TEXT = { Returning: "Still going, more episodes coming", Ended: "Finished, the whole story is here", Cancelled: "Cancelled, no more episodes coming",
    "In production": "New episodes being made" };

  let home = null, searchSeq = 0, searchTimer = null, toastTimer = null;
  const statuses = new Map();   // "tv:123" -> status, so a title changes everywhere it appears once requested

  async function call(path, body) {
    let response;
    try {
      response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { return { ok: false, data: { error: "No internet connection. Try again in a minute." } }; }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/api/mum/setup") showSetup();
    return { ok: response.ok, status: response.status, data };
  }
  function toast(text, bad) {
    const t = $("toast"); t.textContent = text; t.classList.toggle("bad", Boolean(bad)); t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 5000 : 4200);
  }

  // ---------- one poster card ----------
  function action(item) {
    const status = statuses.get(item.type + ":" + item.tmdb) || item.status;
    if (status === "have") { const s = el("div", "state have"); s.append(svg(TICK), el("span", null, "On your TV")); return s; }
    if (status === "coming") { const s = el("div", "state coming"); s.append(svg(CLOCK), el("span", null, "Coming soon")); return s; }
    const b = el("button", "req", "Request"); b.type = "button";
    b.onclick = event => { event.stopPropagation(); request(item); };
    return b;
  }
  function card(item) {
    const c = el("div", "card"); c.dataset.key = item.type + ":" + item.tmdb;
    const p = el("button", "poster"); p.type = "button"; p.setAttribute("aria-label", item.title + ", more about it");
    if (item.poster) p.style.backgroundImage = poster(item.poster); else p.append(el("span", "noimg", item.title));
    p.append(el("span", "kind", kindName(item.type)));
    p.onclick = () => openSheet(item);
    const act = el("div", "act"); act.append(action(item));
    // under the title: year and where it's from (Netflix, BBC One…), then its genres
    const from = item.network || item.streaming?.[0] || "";
    c.append(p, el("div", "t", item.title), el("div", "y", [item.year, from || kindName(item.type)].filter(Boolean).join(" · ")));
    if (item.genres?.length) c.append(el("div", "g", item.genres.slice(0, 2).join(" · ")));
    c.append(act);
    return c;
  }
  function refreshCards(item) {
    document.querySelectorAll(`[data-key="${item.type}:${item.tmdb}"] .act`).forEach(a => { a.replaceChildren(action(item)); a.firstChild.classList.add("pop"); });
  }

  async function request(item) {
    const key = item.type + ":" + item.tmdb;
    document.querySelectorAll(`[data-key="${key}"] .req`).forEach(b => { b.disabled = true; b.replaceChildren(el("span", "spin"), el("span", null, "Requesting…")); });
    const r = await call("/api/mum/request", { type: item.type, tmdb: item.tmdb });
    if (r.ok) {
      statuses.set(key, r.data.status || "coming");
      toast(r.data.already ? (r.data.status === "have" ? "You already have " + item.title + "." : item.title + " is already on its way.")
        : item.type === "tv" ? "Done! " + item.title + " will start appearing on your TV soon." : "Done! " + item.title + " will be on your TV soon.");
    } else toast(r.data?.error || "That didn't work. Try again in a minute.", true);
    refreshCards(item);
  }

  // ---------- details sheet (tap a poster) ----------
  function fillSheet(item) {
    const panel = $("sheet").querySelector(".panel"); panel.replaceChildren();
    const head = el("div", "head"), p = el("div", "poster"); if (item.poster) p.style.backgroundImage = poster(item.poster);
    const info = el("div"); info.append(el("h3", null, item.title), el("div", "meta", [kindName(item.type), item.year, item.rating ? "★ " + item.rating : ""].filter(Boolean).join(" · ")));
    if (item.genres?.length) { const chips = el("div", "chips"); for (const g of item.genres) chips.append(el("span", null, g)); info.append(chips); }
    head.append(p, info);
    // the facts: where it's from, how much there is, whether it's still going
    const facts = el("div", "facts"), fact = (icon, text, cls) => { if (!text) return; const f = el("div", "fact " + (cls || "")); f.append(svg(icon), el("span", null, text)); facts.append(f); };
    if (item.type === "tv") {
      fact(TV_ICON, item.network ? "From " + item.network : "");
      fact(LAYERS, seasonsText(item));
      fact(DOT, item.showStatus ? (STATUS_TEXT[item.showStatus] || item.showStatus) : "", "st " + (item.showStatus || "").toLowerCase().replace(/\s+/g, "-"));
    } else {
      fact(CLOCK, item.runtime ? runtimeText(item.runtime) : "");
    }
    if (item.streaming?.length && !(item.type === "tv" && item.streaming[0] === item.network)) fact(TV_ICON, "Also on " + item.streaming.join(" and "));
    const act = el("div", "act"); act.append(action(item));
    const wrap = el("div", "card"); wrap.dataset.key = item.type + ":" + item.tmdb; wrap.append(act);
    const close = el("button", "close", "Close"); close.type = "button"; close.onclick = closeSheet;
    const ov = el("p", "ov", item.overview || "No description yet.");
    panel.append(el("div", "grab"), head);
    if (facts.childNodes.length) panel.append(facts);
    if (item.tagline) panel.append(el("p", "tag", item.tagline));
    panel.append(ov, wrap);
    // trailer at the bottom: tap to play it right here
    if (item.trailer) {
      const t = el("button", "trailer"); t.type = "button"; t.append(svg(PLAY), el("span", null, "Watch the trailer"));
      t.onclick = () => {
        const box = el("div", "video"), frame = document.createElement("iframe");
        frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(item.trailer) + "?autoplay=1&playsinline=1&rel=0&modestbranding=1";
        frame.title = item.title + " trailer"; frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; frame.allowFullscreen = true;
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        box.append(frame); t.replaceWith(box); box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
      panel.append(t);
    }
    panel.append(close);
  }
  function openSheet(item) {
    const s = $("sheet"); s.dataset.key = item.type + ":" + item.tmdb; fillSheet(item); s.hidden = false; document.body.classList.add("locked");
    try { history.pushState({ sheet: true }, ""); } catch {}
  }
  function hideSheet() { const s = $("sheet"); s.hidden = true; s.dataset.key = ""; document.body.classList.remove("locked"); }
  function closeSheet() { if ($("sheet").hidden) return; hideSheet(); if (history.state?.sheet) history.back(); }
  $("sheet").querySelector(".scrim").onclick = closeSheet;
  addEventListener("popstate", () => { if (!$("sheet").hidden) hideSheet(); });

  // ---------- home and search ----------
  function section(title, sub, items, layout) {
    const s = el("section", "section"), h = el("h2", null, title);
    if (sub) h.append(el("small", null, sub));
    const box = el("div", layout || "rail");
    for (const item of items) box.append(card(item));
    s.append(h, box); return s;
  }
  function skeleton() {
    const s = el("section", "section"), box = el("div", "rail");
    s.append(el("h2", null, "Getting things ready…"));
    for (let i = 0; i < 6; i++) { const c = el("div", "card skel"); c.append(el("div", "poster"), el("div", "t"), el("div", "y")); box.append(c); }
    s.append(box); return s;
  }
  function emptyNote(title, text, retry) {
    const n = el("div", "empty"); n.append(el("b", null, title), document.createTextNode(text));
    if (retry) { const b = el("button", null, "Try again"); b.type = "button"; b.onclick = retry; n.append(el("br"), b); }
    return n;
  }
  function drawHome() {
    const c = $("content"); c.replaceChildren();
    if (!home) { c.append(skeleton()); return; }
    if (home.error) { c.append(emptyNote("Couldn't load", home.error, loadHome)); return; }
    if (home.forYou.length) c.append(section("Recommended for you", "Picked from what you've been watching", home.forYou));
    if (home.shows.length) c.append(section("Trending shows", "Popular this week", home.shows));
    if (home.films.length) c.append(section("Trending films", "Popular this week", home.films));
    if (!c.childNodes.length) c.append(emptyNote("Nothing to show yet", "Search for something you'd like to watch."));
  }
  async function loadHome(fresh) {
    home = null; drawHome();
    const page = Number(localStorage.getItem("mum_page")) || 0;
    const r = await call("/api/mum/home?page=" + page + (fresh ? "&refresh=1" : ""));
    if (r.status === 401) return;
    home = r.ok ? r.data : { error: r.data?.error || "Try again in a minute." };
    if (!$("q").value.trim()) drawHome();
  }

  async function search(q) {
    const seq = ++searchSeq, c = $("content");
    c.replaceChildren(skeleton()); c.querySelector("h2").textContent = "Searching…";
    const r = await call("/api/mum/search?q=" + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    c.replaceChildren();
    if (!r.ok) { if (r.status !== 401) c.append(emptyNote("Couldn't search", r.data?.error || "Try again in a minute.", () => search(q))); return; }
    const results = r.data.results || [];
    if (!results.length) { c.append(emptyNote("Nothing found", `Couldn't find “${q}”. Check the spelling, or try fewer words.`)); return; }
    c.append(section(`Results for “${q}”`, null, results, "grid"));
  }
  $("q").addEventListener("input", () => {
    const q = $("q").value.trim(); $("clear").hidden = !q;
    clearTimeout(searchTimer);
    if (q.length < 2) { searchSeq++; drawHome(); return; }
    searchTimer = setTimeout(() => search(q), 450);
  });
  $("q").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); const q = $("q").value.trim(); if (q.length >= 2) search(q); $("q").blur(); } });
  // Refresh: the next batch of picks she hasn't seen yet (it remembers where she got to), and fresh trending
  $("refresh").onclick = async () => {
    const b = $("refresh"); if (b.disabled) return;
    b.disabled = true; b.classList.add("spinning");
    $("q").value = ""; $("clear").hidden = true; searchSeq++;
    scrollTo({ top: 0, behavior: "smooth" });
    try { localStorage.setItem("mum_page", String((Number(localStorage.getItem("mum_page")) || 0) + 1)); } catch {}
    await loadHome(true);
    b.disabled = false; b.classList.remove("spinning");
    if (home && !home.error) toast("Here are some new suggestions.");
  };
  $("clear").onclick = () => { $("q").value = ""; $("clear").hidden = true; searchSeq++; drawHome(); scrollTo({ top: 0, behavior: "smooth" }); };

  // ---------- first-time setup on her phone ----------
  function showSetup() { $("setup").hidden = false; $("app").hidden = true; }
  $("setupForm").addEventListener("submit", async e => {
    e.preventDefault();
    const b = e.target.querySelector("button"); b.disabled = true; $("setupMsg").textContent = "Setting up…";
    const r = await call("/api/mum/setup", { username: $("su").value, password: $("sp").value });
    b.disabled = false;
    if (!r.ok) { $("setupMsg").textContent = r.data?.error || "That didn't work."; return; }
    $("sp").value = ""; $("setupMsg").textContent = ""; $("setup").hidden = true; $("app").hidden = false; loadHome();
  });

  // come back to the app after a while: freshen the lists
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 30 * 60000 && !$("q").value.trim()) loadHome();
  });

  call("/api/mum/setup").then(r => { if (r.ok && r.data.ready) loadHome(); else showSetup(); });
})();

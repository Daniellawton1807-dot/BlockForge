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
    if (status === "elsewhere") return el("div", "state elsewhere", "Daniel has this one");
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
    c.append(p, el("div", "t", item.title), el("div", "y", [item.year, kindName(item.type)].filter(Boolean).join(" · ")), act);
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
    if ($("sheet").dataset.key === key) fillSheet(item);
  }

  // ---------- details sheet (tap a poster) ----------
  function fillSheet(item) {
    const panel = $("sheet").querySelector(".panel"); panel.replaceChildren();
    const head = el("div", "head"), p = el("div", "poster"); if (item.poster) p.style.backgroundImage = poster(item.poster);
    const info = el("div"); info.append(el("h3", null, item.title), el("div", "meta", [kindName(item.type), item.year, item.rating ? "★ " + item.rating : ""].filter(Boolean).join(" · ")));
    head.append(p, info);
    const act = el("div", "act"); act.append(action(item));
    const wrap = el("div", "card"); wrap.dataset.key = item.type + ":" + item.tmdb; wrap.append(act);
    const close = el("button", "close", "Close"); close.type = "button"; close.onclick = closeSheet;
    panel.append(el("div", "grab"), head, el("p", "ov", item.overview || "No description yet."), wrap, close);
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
  async function loadHome() {
    home = null; drawHome();
    const r = await call("/api/mum/home");
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

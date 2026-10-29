/* Shared helpers for Homebase's Remote and Media pages: sign-in, theme, icons, sheet, toast, API calls.
   All requests are same-origin; the Homebase session cookie is HttpOnly and never touched here. */
window.Hub = (() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v.replace(/^"|"$/g, ""); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} }
  };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // icons: 24px paths, filled with currentColor
  const ICONS = {
    play: "M8 5v14l11-7z", pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z", plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
    search: "M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z",
    refresh: "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z",
    bell: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z",
    bellOff: "M20 18.7 5.3 4 4 5.3l2.9 2.9C6.3 9 6 10 6 11v5l-2 2v1h13.7l1 1zM12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-7.8V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7c-.5.1-.9.3-1.3.5z",
    trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
    list: "M3 13h2v-2H3zm0 4h2v-2H3zm0-8h2V7H3zm4 4h14v-2H7zm0 4h14v-2H7zM7 7v2h14V7z",
    download: "M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z", check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
    close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
    chevL: "M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z", chevR: "M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z",
    logout: "M10 17l1.4-1.4-2.6-2.6H20v-2H8.8l2.6-2.6L10 7l-5 5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z",
    sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z",
    moon: "M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.4 5.4 0 0 1 12.4 3.1 9 9 0 0 0 12 3z",
    tv: "M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z",
    star: "M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z",
    info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z",
    restart: "M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"
  };
  function icon(name, cls) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "hub-ico" + (cls ? " " + cls : ""));
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", ICONS[name] || ""); svg.append(path); return svg;
  }
  // put icons into static markup: <span data-icon="search"></span>
  document.querySelectorAll("[data-icon]").forEach(e => e.replaceChildren(icon(e.dataset.icon)));

  // theme: same key as the rest of Homebase
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const b = $("hubThemeToggle"); if (b) { b.replaceChildren(icon(theme === "light" ? "moon" : "sun")); b.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme"; }
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = theme === "light" ? "#f4f6fb" : "#0b1020";
  }
  setTheme(store.get("homebase-theme", "dark"));
  document.addEventListener("click", e => {
    if (e.target.closest("#hubThemeToggle")) { const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"; store.set("homebase-theme", JSON.stringify(next)); setTheme(next); }
  });
  const signOut = $("hubSignOut"); if (signOut) signOut.replaceChildren(icon("logout"));

  // toast(message) or toast(message, { kind: "error", action: { label, onClick } })
  let toastTimer;
  function toast(message, opts = {}) {
    if (typeof opts === "string") opts = { kind: opts };
    let t = $("hubToast"); if (!t) { t = el("div", "hub-toast"); t.id = "hubToast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.className = "hub-toast" + (opts.kind ? " " + opts.kind : ""); t.replaceChildren(el("span", null, message));
    if (opts.action) { const b = el("button", "hub-toast-action", opts.action.label); b.type = "button"; b.onclick = () => { t.classList.remove("show"); opts.action.onClick(); }; t.append(b); }
    requestAnimationFrame(() => t.classList.add("show")); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), opts.action ? 6000 : 3600);
  }

  // sheet: one at a time; the browser/phone back button closes it
  function ensureSheet() {
    if ($("hubSheet")) return;
    const scrim = el("div", "hub-scrim"); scrim.id = "hubScrim";
    const sheet = el("div", "hub-sheet"); sheet.id = "hubSheet"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    const close = el("button", "hub-sheet-close"); close.type = "button"; close.setAttribute("aria-label", "Close"); close.append(icon("close"));
    const body = el("div", "hub-sheet-body"); body.id = "hubSheetBody";
    sheet.append(close, body); document.body.append(scrim, sheet);
    scrim.onclick = closeSheet; close.onclick = closeSheet;
  }
  let lastFocus = null;
  function openSheet(build) {
    ensureSheet(); const body = $("hubSheetBody"); body.replaceChildren(); build(body);
    body.classList.remove("swap"); void body.offsetWidth; body.classList.add("swap");  // content fades in, also when one sheet turns into another
    if (!sheetOpen()) {
      lastFocus = document.activeElement;
      try { history.pushState({ hubSheet: true }, ""); } catch {}
      document.documentElement.classList.add("hub-locked");
    }
    $("hubScrim").classList.add("open"); $("hubSheet").classList.add("open"); $("hubSheet").scrollTop = 0;
    $("hubSheet").querySelector(".hub-sheet-close").focus({ preventScroll: true });
  }
  function hideSheet() {
    $("hubScrim")?.classList.remove("open"); $("hubSheet")?.classList.remove("open");
    document.documentElement.classList.remove("hub-locked"); lastFocus?.focus?.({ preventScroll: true });
  }
  // closing by hand also pops the history entry the sheet added (ignoring that popstate, so a sheet opened straight after stays open)
  let ignorePop = false;
  function closeSheet() { if (!sheetOpen()) return; hideSheet(); if (history.state?.hubSheet) { ignorePop = true; history.back(); } }
  const sheetOpen = () => Boolean($("hubSheet")?.classList.contains("open"));
  addEventListener("popstate", () => { if (ignorePop) { ignorePop = false; return; } if (sheetOpen()) hideSheet(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetOpen()) { e.preventDefault(); closeSheet(); } });

  // loading placeholders
  function skeleton(kind = "grid", count = 12) {
    const wrap = el("div", kind === "list" ? "hub-list" : kind === "rail" ? "hub-rail" : "hub-grid"); wrap.setAttribute("aria-hidden", "true");
    for (let i = 0; i < count; i++) {
      if (kind === "list") { wrap.append(el("div", "hub-skel row")); continue; }
      const t = el("div", "hub-tile"); t.append(el("div", "art hub-skel"), el("div", "hub-skel line"), el("div", "hub-skel line short")); wrap.append(t);
    }
    return wrap;
  }
  // a horizontal row of tiles with arrow buttons on wide screens
  function rail(tiles) {
    const outer = el("div", "hub-rail-wrap"), row = el("div", "hub-rail");
    tiles.forEach(t => row.append(t));
    const arrow = (dir) => { const b = el("button", "hub-rail-arrow " + dir); b.type = "button"; b.setAttribute("aria-label", dir === "prev" ? "Scroll back" : "Scroll on"); b.append(icon(dir === "prev" ? "chevL" : "chevR"));
      b.onclick = () => row.scrollBy({ left: (dir === "prev" ? -1 : 1) * row.clientWidth * .85, behavior: "smooth" }); return b; };
    const prev = arrow("prev"), next = arrow("next");
    const update = () => { prev.hidden = row.scrollLeft < 8; next.hidden = row.scrollLeft + row.clientWidth >= row.scrollWidth - 8; };
    row.addEventListener("scroll", update, { passive: true }); requestAnimationFrame(update); addEventListener("resize", update);
    outer.append(row, prev, next); return outer;
  }

  // API: JSON or text in, { ok, status, data } out; a 401 anywhere shows the sign-in panel
  let onSignedOut = () => {};
  async function api(path, options = {}) {
    const init = { cache: "no-store", credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } };
    if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
    let response;
    try { response = await fetch(path, init); } catch { return { ok: false, status: 0, data: { error: "Homebase is not reachable. Check your connection." } }; }
    const type = response.headers.get("content-type") || "";
    let data, htmlResponse = false;
    if (type.includes("json")) data = await response.json().catch(() => ({}));
    else {
      const body = await response.text().catch(() => "");
      htmlResponse = /text\/html/i.test(type) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
      data = htmlResponse
        ? { error: response.status >= 500 ? "The service is temporarily unavailable (HTTP " + response.status + "). Try again shortly." : "The service returned an unexpected HTML page (HTTP " + response.status + ")." }
        : { text: body };
    }
    if (response.status === 401 && data.code === "login_required") onSignedOut(data.error);
    return { ok: response.ok && !htmlResponse, status: htmlResponse && response.ok ? 502 : response.status, data };
  }
  const errorText = (result, fallback) => result.data?.error || result.data?.reply || result.data?.text || fallback;

  // sign-in panel: <section id="hubGate"> with the same form fields as the rest of Homebase
  function gate({ onReady, message = "Sign in to continue." }) {
    const panel = $("hubGate"), form = $("hubLoginForm"), note = $("hubGateMessage"), content = $("hubContent");
    const show = text => { panel.hidden = false; content.hidden = true; if (signOut) signOut.hidden = true; note.textContent = text || message; };
    const hide = () => { panel.hidden = true; content.hidden = false; if (signOut) signOut.hidden = false; };
    onSignedOut = text => show(text || "Your Homebase sign-in expired. Sign in again to continue.");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; note.textContent = "Signing in…";
      const result = await api("/api/downloads/login", { method: "POST", body: { username: $("hubUsername").value, password: $("hubPassword").value, remember: $("hubRemember").checked } });
      button.disabled = false;
      if (!result.ok) { note.textContent = result.status === 401 ? "Username or password is incorrect." : errorText(result, "Could not sign in. Try again."); return; }
      $("hubPassword").value = ""; hide(); onReady();
    });
    signOut?.addEventListener("click", async () => { await api("/api/downloads/logout", { method: "POST" }); show("Signed out."); });
    api("/api/downloads/session").then(result => {
      if (result.status === 503) show("The Homebase sign-in is not configured in Cloudflare Pages yet.");
      else if (result.data?.authenticated) { hide(); onReady(); }
      else show(message);
    });
  }

  const TVS = { "living room": "Living Room TV", "mum": "Mum's TV", "daniels tv": "Daniel's TV" };
  const TV_SUFFIX = { "living room": " in the living room", "mum": " on mum's tv", "daniels tv": " on daniel's tv" };
  return { $, el, icon, store, toast, openSheet, closeSheet, sheetOpen, skeleton, rail, api, errorText, gate, TVS, TV_SUFFIX };
})();

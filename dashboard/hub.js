/* Shared helpers for Homebase's Remote and Media pages: sign-in, theme, sheet, toast, API calls.
   All requests are same-origin; the Homebase session cookie is HttpOnly and never touched here. */
window.Hub = (() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v.replace(/^"|"$/g, ""); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} }
  };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // theme: same key as the rest of Homebase
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const b = $("hubThemeToggle"); if (b) { b.textContent = theme === "light" ? "☾" : "☼"; b.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme"; }
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = theme === "light" ? "#f4f6fb" : "#0b1020";
  }
  setTheme(store.get("homebase-theme", "dark"));
  document.addEventListener("click", e => {
    if (e.target.closest("#hubThemeToggle")) { const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"; store.set("homebase-theme", JSON.stringify(next)); setTheme(next); }
  });

  let toastTimer;
  function toast(message) {
    let t = $("hubToast"); if (!t) { t = el("div", "hub-toast"); t.id = "hubToast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.textContent = message; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
  }

  // sheet
  function ensureSheet() {
    if ($("hubSheet")) return;
    const scrim = el("div", "hub-scrim"); scrim.id = "hubScrim";
    const sheet = el("div", "hub-sheet"); sheet.id = "hubSheet"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    const close = el("button", "hub-sheet-close", "×"); close.type = "button"; close.setAttribute("aria-label", "Close");
    const body = el("div"); body.id = "hubSheetBody";
    sheet.append(close, body); document.body.append(scrim, sheet);
    scrim.onclick = closeSheet; close.onclick = closeSheet;
  }
  function openSheet(build) {
    ensureSheet(); const body = $("hubSheetBody"); body.innerHTML = ""; build(body);
    $("hubScrim").classList.add("open"); $("hubSheet").classList.add("open"); $("hubSheet").scrollTop = 0;
  }
  function closeSheet() { $("hubScrim")?.classList.remove("open"); $("hubSheet")?.classList.remove("open"); }
  const sheetOpen = () => Boolean($("hubSheet")?.classList.contains("open"));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetOpen()) closeSheet(); });

  // API: JSON or text in, { ok, status, data } out; a 401 anywhere shows the sign-in panel
  let onSignedOut = () => {};
  async function api(path, options = {}) {
    const init = { cache: "no-store", credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } };
    if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
    let response;
    try { response = await fetch(path, init); } catch { return { ok: false, status: 0, data: { error: "Homebase is not reachable. Check your connection." } }; }
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json().catch(() => ({})) : { text: await response.text().catch(() => "") };
    if (response.status === 401 && data.code === "login_required") onSignedOut(data.error);
    return { ok: response.ok, status: response.status, data };
  }
  const errorText = (result, fallback) => result.data?.error || result.data?.reply || result.data?.text || fallback;

  // sign-in panel: <section id="hubGate"> with the same form fields as the rest of Homebase
  function gate({ onReady, message = "Sign in to continue." }) {
    const panel = $("hubGate"), form = $("hubLoginForm"), note = $("hubGateMessage"), content = $("hubContent");
    const show = text => { panel.hidden = false; content.hidden = true; note.textContent = text || message; };
    const hide = () => { panel.hidden = true; content.hidden = false; };
    onSignedOut = text => show(text || "Your Homebase sign-in expired. Sign in again to continue.");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; note.textContent = "Signing in…";
      const result = await api("/api/downloads/login", { method: "POST", body: { username: $("hubUsername").value, password: $("hubPassword").value, remember: $("hubRemember").checked } });
      button.disabled = false;
      if (!result.ok) { note.textContent = result.status === 401 ? "Username or password is incorrect." : errorText(result, "Could not sign in. Try again."); return; }
      $("hubPassword").value = ""; hide(); onReady();
    });
    $("hubSignOut")?.addEventListener("click", async () => { await api("/api/downloads/logout", { method: "POST" }); show("Signed out."); });
    api("/api/downloads/session").then(result => {
      if (result.status === 503) show("The Homebase sign-in is not configured in Cloudflare Pages yet.");
      else if (result.data?.authenticated) { hide(); onReady(); }
      else show(message);
    });
  }

  const TVS = { "living room": "Living Room TV", "mum": "Mum's TV", "daniels tv": "Daniel's TV" };
  const TV_SUFFIX = { "living room": " in the living room", "mum": " on mum's tv", "daniels tv": " on daniel's tv" };
  return { $, el, store, toast, openSheet, closeSheet, sheetOpen, api, errorText, gate, TVS, TV_SUFFIX };
})();

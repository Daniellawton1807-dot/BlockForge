/* The Jarvis dashboard. Talks only to /api/jarvis/*. Everything from the server is shown with textContent, never as HTML. */
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* still works, it just asks again */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nothing kept */ } }
  };
  let session = store.get("jarvis.session") || "";
  let status = {}, log = [], live = false, pendingTool = null, sheetKind = null, panelTimer = null, pollTimer = null, abort = null;
  const cpuHistory = [], netHistory = [];
  const TOOL_NAMES = { jellyfin_play: "Play", jellyfin_pause: "Pause", jellyfin_resume: "Resume", jellyfin_stop: "Stop playback", tv_volume: "Volume", tv_power: "TV power", tv_mute: "Mute", minecraft_start: "Start Minecraft", minecraft_stop: "Stop Minecraft", minecraft_restart: "Restart Minecraft" };
  const label = tool => TOOL_NAMES[tool] || String(tool || "").replace(/_/g, " ");

  async function api(path, body) {
    const headers = { "x-jarvis-session": session };
    if (body) headers["content-type"] = "application/json";
    let res;
    try { res = await fetch("/api/jarvis/" + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { return { ok: false, status: 0, data: { error: "Connection lost." } }; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) signedOut(data.code);
    return { ok: res.ok, status: res.status, data };
  }

  function signedOut(code) {
    stopLive();
    if (code === "login_required") return showGate("login", "Sign in with your Homebase account.");
    session = ""; store.del("jarvis.session");
    showGate("pin", "Enter your PIN.");
  }

  function showGate(kind, note) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gateNote").textContent = note;
    $("loginFields").hidden = kind !== "login"; $("pinFields").hidden = kind !== "pin";
    $("gateForm").dataset.kind = kind;
    $(kind === "login" ? "user" : "pin").focus();
  }

  $("gateForm").addEventListener("submit", async e => {
    e.preventDefault();
    const go = $("gateGo"); go.disabled = true;
    if ($("gateForm").dataset.kind === "login") {
      let res = null;
      try { res = await fetch("/api/downloads/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: $("user").value, password: $("pass").value, remember: true }) }); } catch { /* shown below */ }
      go.disabled = false;
      if (!res || !res.ok) { $("gateNote").textContent = res && res.status === 401 ? "Username or password is incorrect." : "Could not sign in."; return; }
      $("pass").value = "";
      return boot();
    }
    const r = await api("pin", { pin: $("pin").value });
    go.disabled = false; $("pin").value = "";
    if (!r.ok) { $("gateNote").textContent = r.data.error || "That didn't work."; return; }
    session = r.data.session; store.set("jarvis.session", session);
    boot();
  });

  async function boot() {
    const r = await api("state");
    if (!r.ok) { if (r.status !== 401) showGate(session ? "pin" : "login", r.data.error || "Jarvis isn't reachable."); return; }
    $("gate").hidden = true; $("app").hidden = false;
    applyView(r.data);
    connect();
  }

  function applyView(v) {
    if (v.status) setStatus(v.status);
    if (v.log) { log = v.log; if (sheetKind === "log") renderSheet(); }
    setMode(v.mode || "idle");
    setPending(v.pending);
  }

  function stopLive() { if (abort) abort.abort(); abort = null; clearInterval(pollTimer); pollTimer = null; setLink(false); }

  /* Live events over a streamed fetch (EventSource can't send the session header). If the stream can't hold, poll instead. */
  async function connect() {
    stopLive();
    const controller = abort = new AbortController();
    let got = false;
    try {
      const res = await fetch("/api/jarvis/events", { headers: { "x-jarvis-session": session, accept: "text/event-stream" }, signal: controller.signal });
      if (res.status === 401) return signedOut((await res.json().catch(() => ({}))).code);
      if (!res.ok || !res.body) throw new Error("no stream");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          if (!chunk.startsWith("data: ")) continue;
          if (!got) { got = true; streamFails = 0; clearInterval(pollTimer); pollTimer = null; setLink(true); }
          try { onEvent(JSON.parse(chunk.slice(6))); } catch { /* one bad event isn't fatal */ }
        }
      }
    } catch { if (controller.signal.aborted) return; }
    if (abort !== controller) return;
    setLink(false);
    streamFails += got ? 0 : 1;
    if (streamFails >= 2) startPolling();
    setTimeout(() => { if (abort === controller && !document.hidden) connect(); }, streamFails >= 2 ? 30000 : 2000);
  }
  let streamFails = 0;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      const r = await api("state");
      if (r.ok) { setLink(true, "POLLING"); applyView(r.data); }
    }, 5000);
  }

  function setLink(on, text) {
    live = on;
    $("linkText").textContent = on ? (text || "LIVE LINK / VAULT") : "LINK LOST / RECONNECTING";
    document.querySelector(".link").classList.toggle("off", !on);
  }

  function onEvent(e) {
    switch (e.type) {
      case "hello": applyView(e); break;
      case "status": setStatus(e.status); break;
      case "mode": setMode(e.mode); break;
      case "you": pushLog(e); $("said").textContent = ""; break;
      case "reply": pushLog(e); $("said").textContent = e.text; setPending(e.awaiting_confirmation ? { tool: e.tool, question: e.text } : null); break;
      case "action": pushLog(e); if (e.tier >= 2) openAction(e); break;
      case "step": pushLog(e); addStep(e.text); break;
      case "result": pushLog(e); if (e.tier >= 2 && !e.needs_confirmation) finishAction(e); break;
      case "timer": pushLog(e); $("said").textContent = e.text; break;
    }
  }
  function pushLog(e) { log.push(e); if (log.length > 100) log.shift(); if (sheetKind === "log") renderSheet(); }

  function setMode(mode) { document.body.dataset.mode = mode; $("modeLabel").textContent = mode === "thinking" ? "THINKING" : "COMPUTE ACTIVITY"; }

  function setPending(p) {
    pendingTool = p ? p.tool : null;
    $("confirm").hidden = !p;
    if (p) { $("confirmText").textContent = p.question || "Shall I proceed?"; $("confirmNo").focus(); }
  }
  async function answer(yes) {
    const tool = pendingTool; setPending(null);
    const r = await api("confirm", { tool, yes });
    if (!r.ok) $("said").textContent = r.data.error || "That didn't go through.";
  }
  $("confirmYes").addEventListener("click", () => answer(true));
  $("confirmNo").addEventListener("click", () => answer(false));

  /* readouts */
  const num = (v, d = 0) => v == null ? "--" : Number(v).toFixed(d);
  function ring(id, percent, text) {
    const r = $(id);
    r.querySelector(".v").style.strokeDasharray = Math.max(0, Math.min(100, percent || 0)) + " 100";
    r.querySelector("span").textContent = text;
  }
  function spark(id, values) {
    if (values.length < 2) return;
    const top = Math.max(...values, 1);
    $(id).querySelector("polyline").setAttribute("points", values.map((v, i) => (i / (60 - 1) * 200).toFixed(1) + "," + (42 - v / top * 38).toFixed(1)).join(" "));
  }
  function push(list, v) { list.push(v || 0); if (list.length > 60) list.shift(); }

  function setStatus(s) {
    if (!s) return;
    status = { ...status, ...s };
    const on = s.telemetry !== false && s.cpu != null;
    $("telemetry").textContent = on ? "LIVE TELEMETRY / ONLINE" : "TELEMETRY / UNAVAILABLE";
    if (on) {
      $("cpu").textContent = num(s.cpu, 1) + "%";
      $("coreCpu").textContent = num(s.cpu);
      $("loadArc").setAttribute("stroke-dasharray", Math.min(100, s.cpu).toFixed(1) + " 100");
      $("coreTemp").textContent = s.temp != null ? num(s.temp) + "°C / CPU" : "";
      push(cpuHistory, s.cpu); spark("cpuSpark", cpuHistory);
      if (s.memory) {
        ring("memRing", s.memory.percent, num(s.memory.percent) + "%");
        $("memUsed").textContent = s.memory.used_gb + " GiB"; $("memOf").textContent = "OF " + s.memory.total_gb + " GIB IN USE";
        $("coreSub").textContent = "Memory " + num(s.memory.percent, 1) + "%" + (s.storage ? "  ·  Disk " + num(s.storage.percent) + "%" : "");
      }
      if (s.storage) { ring("diskRing", s.storage.percent, num(s.storage.percent) + "%"); $("diskFree").textContent = s.storage.free_gb; }
      if (s.network) {
        $("netDown").textContent = "↓ " + num(s.network.down, s.network.down < 10 ? 1 : 0);
        $("netUp").textContent = "↑ " + num(s.network.up, 1) + " KiB/s"; $("netName").textContent = s.network.name || "";
        push(netHistory, s.network.down); spark("netSpark", netHistory);
      }
      $("uptime").textContent = s.uptime || "--";
    }
    const mc = status.minecraft;
    if (mc) {
      const players = mc.online || 0;
      ring("mcRing", mc.running && mc.max ? players / mc.max * 100 : 0, mc.running ? players + "/" + (mc.max || "?") : "OFF");
      $("mcState").textContent = mc.starting ? "STARTING" : mc.running ? "RUNNING" : "STOPPED";
      $("mcWho").textContent = mc.running && mc.players && mc.players.length ? mc.players.join(", ").toUpperCase() : mc.running ? "NOBODY ONLINE" : "MAIN WORLD";
    }
    const busy = (status.tvs || []).filter(t => t.playing);
    $("dockTv").textContent = busy.length ? busy.length + " playing" : "Nothing playing";
    if (sheetKind === "tvs" || sheetKind === "minecraft") renderSheet();
  }

  /* side sheet: status views and the live action panel */
  function openSheet(kind, title) {
    clearTimeout(panelTimer);
    sheetKind = kind; $("sheetTitle").textContent = title; $("sheet").hidden = false;
    if (kind !== "action") renderSheet();
  }
  function closeSheet() { clearTimeout(panelTimer); sheetKind = null; $("sheet").hidden = true; }
  $("sheetClose").addEventListener("click", closeSheet);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
  document.querySelectorAll("[data-sheet]").forEach(b => b.addEventListener("click", () => openSheet(b.dataset.sheet, { tvs: "TVS", minecraft: "MINECRAFT", log: "ACTIVITY" }[b.dataset.sheet])));

  function renderSheet() {
    const body = $("sheetBody"); body.replaceChildren();
    const row = (tag, title, sub, cls) => { const r = el("div", "item " + (cls || "")); if (tag) r.append(el("span", "tag", tag)); r.append(el("b", "", title)); if (sub) r.append(el("span", "", sub)); body.append(r); };
    if (sheetKind === "tvs") {
      (status.tvs || []).forEach(t => {
        const p = t.playing;
        row(t.label.toUpperCase(), p ? p.title : t.online == null ? "Unknown" : t.online ? "Nothing playing" : "Not connected", p ? [p.subtitle, p.paused ? "Paused" : "Playing"].filter(Boolean).join(" · ") : "");
      });
    } else if (sheetKind === "minecraft") {
      const m = status.minecraft;
      if (!m) return row("", "Status unavailable");
      row("SERVER", m.starting ? "Starting" : m.running ? "Running" : "Stopped", m.version || "");
      if (m.running) row("PLAYERS", (m.online || 0) + " of " + (m.max || "?"), (m.players || []).join(", ") || "Nobody online");
      body.append(el("p", "", "Ask Jarvis to start or stop it."));
    } else if (sheetKind === "log") {
      const rows = log.filter(e => e.type !== "step").slice(-60).reverse();
      if (!rows.length) return row("", "Nothing yet");
      rows.forEach(e => {
        const when = new Date((e.at || 0) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        if (e.type === "you") row(when + " / YOU", e.text);
        else if (e.type === "reply") row(when + " / JARVIS", e.text);
        else if (e.type === "action") row(when + " / ACTION", label(e.tool), Object.keys(e.params || {}).length ? JSON.stringify(e.params) : "");
        else if (e.type === "result") row(when + " / RESULT", e.needs_confirmation ? "Waiting for confirmation" : e.ok ? "Succeeded" : "Failed", e.text, e.needs_confirmation ? "" : e.ok ? "good" : "fail");
        else row(when, e.text || "");
      });
    }
  }

  function openAction(e) {
    openSheet("action", label(e.tool).toUpperCase());
    const body = $("sheetBody"); body.replaceChildren(el("ul", "steps"));
    body.dataset.tool = e.tool;
  }
  function addStep(text) { const list = $("sheetBody").querySelector(".steps"); if (sheetKind === "action" && list) list.append(el("li", "", text)); }
  async function finishAction(e) {
    if (sheetKind !== "action" || $("sheetBody").dataset.tool !== e.tool) return;
    const body = $("sheetBody"), d = e.details || {};
    if (d.image) {
      const img = el("img", "art"); img.alt = d.title || ""; body.append(img);
      const res = await fetch("/api/jarvis/img/" + encodeURIComponent(d.image), { headers: { "x-jarvis-session": session } }).catch(() => null);
      if (res && res.ok) img.src = URL.createObjectURL(await res.blob()); else img.remove();
    }
    body.append(el("div", "outcome " + (e.ok ? "good" : "bad"), e.text));
    if (e.ok) panelTimer = setTimeout(closeSheet, 7000);
  }

  $("commandForm").addEventListener("submit", async e => {
    e.preventDefault();
    const box = $("command"), text = box.value.trim();
    if (!text) return;
    box.value = "";
    const r = await api("chat", { text });
    if (!r.ok && r.status !== 401) $("said").textContent = r.data.error || "That didn't go through.";
    else if (r.ok && !live) { $("said").textContent = r.data.text; setPending(r.data.awaiting_confirmation ? { tool: r.data.tool, question: r.data.text } : null); }
  });
  $("signOut").addEventListener("click", () => { session = ""; store.del("jarvis.session"); stopLive(); closeSheet(); showGate("pin", "Locked. Enter your PIN."); });

  /* clock and static reactor ticks */
  function tick() {
    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    $("date").textContent = now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  }
  tick(); setInterval(tick, 10000);
  const ticks = $("ticks");
  for (let i = 0; i < 72; i++) {
    const a = i * 5 * Math.PI / 180, long = i % 6 === 0, r1 = long ? 186 : 180, r2 = 192;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", 200 + r1 * Math.cos(a)); line.setAttribute("y1", 200 + r1 * Math.sin(a));
    line.setAttribute("x2", 200 + r2 * Math.cos(a)); line.setAttribute("y2", 200 + r2 * Math.sin(a));
    ticks.append(line);
  }

  /* save the battery while the page is out of sight, and pick up again on return */
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("paused", document.hidden);
    if (document.hidden) { if (abort) { abort.abort(); abort = null; } }
    else if (session && !$("app").hidden) connect();
  });

  /* start: does Homebase know us, then does Jarvis */
  (async () => {
    let signedIn = false;
    try { signedIn = (await (await fetch("/api/downloads/session")).json()).authenticated; } catch { /* treated as signed out */ }
    if (!signedIn) return showGate("login", "Sign in with your Homebase account.");
    if (!session) return showGate("pin", "Enter your PIN.");
    boot();
  })();
})();

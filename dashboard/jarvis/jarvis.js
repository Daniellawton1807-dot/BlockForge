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
    setWake(wakeOn);
  }

  function applyView(v) {
    if (v.status) setStatus(v.status);
    if (v.log) { log = v.log; if (sheetKind === "log") renderSheet(); }
    if (v.address) address = v.address;
    loadAcks();
    setMode(v.mode || "idle");
    setPending(v.pending);
    if (v.view && !$("stage").childElementCount) renderView(v.view);
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
    live = on && !text;  // polling connects, but delivers no replies: those come from the command's own response
    $("linkText").textContent = on ? (text || "LIVE LINK / VAULT") : "LINK LOST / RECONNECTING";
    document.querySelector(".link").classList.toggle("off", !on);
  }

  function onEvent(e) {
    switch (e.type) {
      case "hello": applyView(e); break;
      case "status": setStatus(e.status); break;
      case "mode": setMode(e.mode); break;
      case "you": pushLog(e); $("said").textContent = ""; break;
      case "reply": pushLog(e); showReply(e); setPending(e.awaiting_confirmation ? { tool: e.tool, question: e.text } : null); break;
      case "action":
        pushLog(e);
        if (e.tier >= 2) openAction(e);
        // only the device that gave the command speaks, and it speaks before the action happens
        if (e.tier >= 2 && turnOpen) acknowledge();
        break;
      case "step": pushLog(e); addStep(e.text); break;
      case "result": pushLog(e); break;
      case "wait": if (turnOpen) say("One moment, " + address + "."); break;
      case "timer": pushLog(e); $("said").textContent = e.text; say(e.text); break;
    }
  }
  function showReply(r) {
    const type = r.view && r.view.type;
    $("said").textContent = type === "notice" || type === "error" ? "" : r.text;
    renderView(r.view);
  }
  function pushLog(e) { log.push(e); if (log.length > 100) log.shift(); if (sheetKind === "log") renderSheet(); }

  let serverMode = "idle", hearing = false, transcribing = false;
  function setMode(mode) { serverMode = mode; showMode(); }
  function showMode() {
    const mode = hearing ? "listening" : (transcribing || serverMode === "thinking") ? "thinking" : speaking ? "speaking" : "idle";
    document.body.dataset.mode = mode;
    $("modeLabel").textContent = { listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING", idle: "COMPUTE ACTIVITY" }[mode];
  }

  /* Speech. One audio element is unlocked by the first tap or key, because browsers block sound started any other way.
     It plays ElevenLabs as the audio arrives; if that fails, the browser's own voice takes over and the page says so. */
  const SILENCE = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const player = new Audio();
  let speaking = false, voiceOn = store.get("jarvis.voice") !== "off", unlocked = false, speechQueue = [], speechToken = 0;
  let askedBack = false, address = "sir", turnOpen = false, acked = false, ackClips = [], ackNext = 0, ackLoading = false;
  const ACK_LINES = ["Right away", "Certainly", "At once"];
  /* Clips fetched ahead, so the acknowledgement plays with no trip to the server. They're cached there, so this costs nothing after the first time. */
  async function loadAcks() {
    if (ackLoading || ackClips.length || !voiceOn) return;
    ackLoading = true;
    for (const line of ACK_LINES) {
      const r = await api("tts", { text: line + ", " + address + "." });
      if (!r.ok) return;
      const audio = await fetch("/api/jarvis/tts/" + r.data.id).catch(() => null);
      if (audio && audio.ok) ackClips.push(URL.createObjectURL(await audio.blob()));
    }
  }
  function acknowledge() {
    if (acked || !voiceOn || !ackClips.length) return;
    acked = true;
    speechQueue.unshift({ clip: ackClips[ackNext++ % ackClips.length] });
    if (!speaking) nextSpeech();
  }
  function unlockAudio() {
    if (unlocked || speaking) return;
    unlocked = true;
    player.src = SILENCE;
    player.play().catch(e => { if (e.name === "NotAllowedError") unlocked = false; });
  }
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("keydown", unlockAudio);
  function setSpeaking(on) { speaking = on; showMode(); }
  function warnVoice(text) { $("voiceWarn").hidden = !text; $("voiceWarn").textContent = text || ""; }
  function say(text) {
    if (!voiceOn || !text) return;
    speechQueue.push(text);
    if (!speaking) nextSpeech();
  }
  function stopSpeech() {
    askedBack = false;
    speechToken++; speechQueue = [];
    player.pause(); player.removeAttribute("src");
    if (window.speechSynthesis) speechSynthesis.cancel();
    setSpeaking(false);
  }
  async function nextSpeech() {
    const item = speechQueue.shift();
    const text = item && item.clip ? null : item;
    if (!item) {
      setSpeaking(false);
      // a spoken command that ends in a question gets a spoken answer: listen by itself
      if (spokeLast && (askedBack || pendingTool)) { askedBack = false; startListening(); }
      return;
    }
    setSpeaking(true);
    const token = ++speechToken;
    if (item.clip) {
      player.onended = player.onerror = () => { if (token === speechToken) nextSpeech(); };
      player.src = item.clip;
      player.play().catch(() => { if (token === speechToken) nextSpeech(); });
      return;
    }
    const r = await api("tts", { text });
    if (token !== speechToken) return;
    if (!r.ok) return browserVoice(text, token, r.data.error);
    const failed = () => { if (token === speechToken) { speechToken++; browserVoice(text, speechToken, "ElevenLabs failed"); } };
    player.onended = () => { if (token === speechToken) nextSpeech(); };
    player.onerror = failed;
    player.src = "/api/jarvis/tts/" + r.data.id;
    player.play().then(() => warnVoice("")).catch(e => { if (e.name === "NotAllowedError") { setSpeaking(false); speechQueue = []; warnVoice("TAP THE PAGE ONCE TO ALLOW SOUND"); } else failed(); });
  }
  function browserVoice(text, token, why) {
    warnVoice("USING THE BROWSER'S VOICE" + (why ? " / " + String(why).toUpperCase() : ""));
    if (!window.speechSynthesis) return nextSpeech();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => /en-GB/i.test(v.lang) && /male|daniel|arthur|george/i.test(v.name)) || voices.find(v => /en-GB/i.test(v.lang)) || null;
    u.lang = "en-GB";
    u.onend = u.onerror = () => { if (token === speechToken) nextSpeech(); };
    speechSynthesis.speak(u);
  }
  function setVoice(on) {
    voiceOn = on; store.set("jarvis.voice", on ? "on" : "off");
    $("voiceToggle").setAttribute("aria-pressed", String(on)); $("voiceState").textContent = on ? "On" : "Off";
    if (!on) { stopSpeech(); warnVoice(""); }
  }
  $("voiceToggle").addEventListener("click", () => setVoice(!voiceOn));
  setVoice(voiceOn);

  function setPending(p) {
    pendingTool = p ? p.tool : null;
    $("confirm").hidden = !p;
    if (p) { $("confirmText").textContent = p.question || "Shall I proceed?"; $("confirmNo").focus(); }
  }
  async function answer(yes) {
    const tool = pendingTool; setPending(null);
    stopListening(); stopSpeech(); openTurn();
    const r = await api("confirm", { tool, yes });
    closeTurn();
    if (r.ok) { if (!live) showReply(r.data); speakReply(r.data); }
    else $("said").textContent = r.data.error || "That didn't go through.";
  }
  function openTurn() { turnOpen = true; acked = false; }
  function closeTurn() { turnOpen = false; }
  // after "Right away, sir", a success needs no follow-up; failures and answers are still spoken
  function speakReply(data) {
    askedBack = /\?\s*$/.test(data.text || "");
    if (data.quiet && acked) return;
    say(data.text);
    if (!voiceOn && spokeLast && (askedBack || pendingTool || data.awaiting_confirmation)) { askedBack = false; startListening(); }
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

  /* The response stage: each reply says what it wants shown, and this draws it. Text only, never HTML from data. */
  let noticeTimer = null;
  function clearStage() {
    clearTimeout(noticeTimer);
    const stage = $("stage");
    stage.hidden = true; stage.replaceChildren(); stage.className = "stage";
    document.body.classList.remove("staged");
  }
  function openStage(title, kind) {
    clearStage();
    const stage = $("stage");
    stage.hidden = false; document.body.classList.add("staged");
    if (kind) stage.classList.add("is-" + kind);
    if (title !== null) stage.append(stageHead(title));
    return stage;
  }
  function stageHead(title) {
    const head = el("div", "stage-head");
    head.append(el("h3", "", title));
    const close = el("button", "stage-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close"); close.addEventListener("click", clearStage);
    head.append(close);
    return head;
  }
  async function loadImage(img, id) {
    const res = await fetch("/api/jarvis/img/" + encodeURIComponent(id), { headers: { "x-jarvis-session": session } }).catch(() => null);
    if (res && res.ok) img.src = URL.createObjectURL(await res.blob()); else img.remove();
  }
  const poster = (id, alt) => { const img = el("img"); img.alt = alt || ""; loadImage(img, id); return img; };
  const STATES = { good: ["✓", "Healthy"], warn: ["!", "Watch"], bad: ["✕", "Problem"] };

  function drawTile(c, i) {
    const t = el("div", "tile " + (c.state || ""));
    t.style.animationDelay = i * 40 + "ms";
    t.append(el("small", "", c.label), el("b", "", c.value));
    if (c.detail) t.append(el("span", "more", c.detail));
    if (typeof c.percent === "number") { const m = el("div", "meter"), f = el("i"); f.style.width = Math.max(0, Math.min(100, c.percent)) + "%"; m.append(f); t.append(m); }
    if (STATES[c.state] && c.state !== "good") { const p = el("span", "pill " + c.state); p.textContent = STATES[c.state][0] + " " + STATES[c.state][1]; t.append(p); }
    return t;
  }
  function drawFigures(chart) {
    const d = el("details", "figures");
    d.append(el("summary", "", "Show figures"));
    const scroll = el("div", "scrollx"), table = el("table", "compare"), row = (cells, tag) => { const tr = el("tr"); cells.forEach(x => tr.append(el(tag, "", x))); return tr; };
    table.append(row(["", chart.title], "th"));
    chart.labels.forEach((l, i) => table.append(row([l, chart.values[i] + (chart.unit || "")], "td")));
    scroll.append(table); d.append(scroll);
    return d;
  }
  function drawLine(chart) {
    const W = 600, H = 150, L = 34, R = 8, T = 10, B = 20, NS = "http://www.w3.org/2000/svg", vals = chart.values;
    let lo = chart.floor ?? Math.floor(Math.min(...vals) - 1), hi = chart.ceiling ?? Math.ceil(Math.max(...vals) + 1);
    if (hi <= lo) hi = lo + 1;
    const x = i => L + i / Math.max(1, vals.length - 1) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const svg = document.createElementNS(NS, "svg"), make = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text != null) n.textContent = text; svg.append(n); return n; };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${chart.title}, from ${Math.min(...vals)} to ${Math.max(...vals)} ${chart.unit || ""}`);
    [lo, (lo + hi) / 2, hi].forEach(v => { make("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }); make("text", { class: "axis", x: L - 6, y: y(v) + 3, "text-anchor": "end" }, Math.round(v) + (chart.unit || "")); });
    chart.labels.forEach((l, i) => { if (i % 6 === 0) make("text", { class: "axis", x: x(i), y: H - 5, "text-anchor": "middle" }, l + ":00"); });
    const pts = vals.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
    make("polygon", { class: "area", points: `${x(0)},${y(lo)} ${pts} ${x(vals.length - 1)},${y(lo)}` });
    make("polyline", { class: "line", points: pts });
    const cross = make("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
    const dot = make("circle", { class: "dot", r: 5, cx: x(chart.now ?? 0), cy: y(vals[chart.now ?? 0]), visibility: chart.now == null ? "hidden" : "visible" });
    const plot = el("div", "plot"), tip = el("div", "tip"); tip.hidden = true;
    plot.append(svg, tip);
    const show = i => {
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(vals[i])); dot.setAttribute("visibility", "visible");
      tip.hidden = false; tip.textContent = chart.labels[i] + ":00  ·  " + vals[i] + (chart.unit || "");
      tip.style.left = Math.max(12, Math.min(88, x(i) / W * 100)) + "%";
    };
    plot.addEventListener("pointermove", e => { const box = svg.getBoundingClientRect(), at = (e.clientX - box.left) / box.width * W; show(Math.max(0, Math.min(vals.length - 1, Math.round((at - L) / (W - L - R) * (vals.length - 1))))); });
    plot.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); if (chart.now != null) { dot.setAttribute("cx", x(chart.now)); dot.setAttribute("cy", y(vals[chart.now])); } else dot.setAttribute("visibility", "hidden"); });
    return plot;
  }
  function drawBars(chart) {
    const wrap = el("div", "bars"), top = Math.max(...chart.values.map(Math.abs), 1);
    chart.labels.forEach((l, i) => {
      const row = el("div", "bar"), track = el("div"), fill = el("i");
      fill.style.width = Math.abs(chart.values[i]) / top * 100 + "%"; track.append(fill);
      row.append(el("span", "", l), track, el("b", "", chart.values[i] + (chart.unit || "")));
      row.title = l + ": " + chart.values[i] + (chart.unit || "");
      wrap.append(row);
    });
    return wrap;
  }
  function drawChart(chart) {
    const box = el("div", "chart");
    if (chart.title) box.append(el("h4", "", chart.title.toUpperCase()));
    box.append(chart.kind === "line" ? drawLine(chart) : drawBars(chart));
    if (chart.kind === "line") box.append(drawFigures(chart));
    return box;
  }

  function renderView(v) {
    if (!v) return clearStage();
    const clock = s => { const m = Math.floor((s || 0) / 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
    if (v.type === "report") {
      const stage = openStage(v.title);
      if (v.cards && v.cards.length) { const g = el("div", "cards"); v.cards.forEach((c, i) => g.append(drawTile(c, i))); stage.append(g); }
      (v.charts || []).forEach(c => stage.append(drawChart(c)));
    } else if (v.type === "media") {
      const stage = openStage("Now playing");
      v.items.forEach(m => {
        const row = el("div", "mediarow"), txt = el("div", "txt");
        if (m.image) row.append(poster(m.image, m.title));
        txt.append(el("small", "", String(m.tv || "").toUpperCase()), el("b", "", m.title));
        if (m.subtitle) txt.append(el("span", "", m.subtitle));
        if (m.runtime) { const bar = el("div", "meter"), f = el("i"); f.style.width = Math.min(100, (m.position || 0) / m.runtime * 100) + "%"; bar.append(f); txt.append(bar, el("span", "", (m.paused ? "Paused · " : "") + clock(m.position) + " of " + clock(m.runtime))); }
        row.append(txt); stage.append(row);
      });
    } else if (v.type === "options") {
      const stage = openStage(v.title), grid = el("div", "optgrid");
      v.items.forEach((o, i) => {
        const b = el("button", "opt"); b.type = "button"; b.style.animationDelay = i * 50 + "ms";
        const txt = el("span", "txt"), name = el("b", "", o.label);
        txt.append(name); if (o.detail) txt.append(el("small", "", o.detail));
        if (o.progress) { const bar = el("span", "meter"), f = el("i"); bar.style.display = "block"; f.style.width = o.progress + "%"; bar.append(f); txt.append(bar); }
        b.append(el("span", "num", String(i + 1)));
        if (o.image) b.append(poster(o.image, ""));
        b.append(txt);
        b.addEventListener("click", () => { spokeLast = false; sendCommand(o.label, { option_set: v.id, option: i }); });
        grid.append(b);
      });
      stage.append(grid, el("p", "hint", 'Tap one, or say "the second one".'));
    } else if (v.type === "notice") {
      const stage = openStage(null, "notice"), n = el("div", "notice"), p = el("p", "", v.title || v.text);
      n.append(el("span", "tick", "✓"));
      if (v.image) n.append(poster(v.image, ""));
      if (v.subtitle) p.append(el("span", "", v.subtitle));
      n.append(p); stage.append(n);
      noticeTimer = setTimeout(clearStage, 6000);
    } else if (v.type === "error") {
      const stage = openStage(null, "error"), head = el("div", "errhead"), close = stageHead("").querySelector("button");
      head.append(el("i", "", "!"), el("h3", "", v.title), close);
      stage.append(head);
      const part = (label, text) => { const d = el("p", "diag"); d.append(el("small", "", label), document.createTextNode(text)); stage.append(d); };
      part("WHAT HAPPENED", v.what);
      if (v.why) part("LIKELY CAUSE", v.why);
      if (v.tips && v.tips.length) { const u = el("ul", "tips"); v.tips.forEach(t => u.append(el("li", "", t))); stage.append(el("small", "", "WHAT TO TRY"), u); }
      const again = el("button", "act", "TRY AGAIN"); again.type = "button";
      again.addEventListener("click", () => { spokeLast = false; sendCommand("try again"); });
      stage.append(again);
    } else if (v.type === "table") {
      const stage = openStage(v.title), scroll = el("div", "scrollx"), table = el("table", "compare");
      if (v.columns && v.columns.length) { const tr = el("tr"); v.columns.forEach(c => tr.append(el("th", "", c))); table.append(tr); }
      v.rows.forEach(r => { const tr = el("tr"); r.forEach(c => tr.append(el("td", "", c))); table.append(tr); });
      scroll.append(table); stage.append(scroll);
      if (v.verdict) stage.append(el("p", "verdict", v.verdict));
    } else if (v.type === "sections") {
      const stage = openStage(v.title);
      v.sections.forEach((s, i) => { const d = el("details", "part"); d.open = i === 0; d.append(el("summary", "", s.heading), el("p", "", s.body)); stage.append(d); });
    } else if (v.type === "suggestions") {
      const stage = openStage(v.title), list = el("div", "sugg");
      v.items.forEach((s, i) => {
        const c = el("div", "sug"); c.style.animationDelay = i * 50 + "ms"; c.append(el("b", "", s.title));
        if (s.detail) c.append(el("span", "", s.detail));
        if (s.command) { const go = el("button", "act", "DO THIS"); go.type = "button"; go.addEventListener("click", () => { spokeLast = false; sendCommand(s.command); }); c.append(go); }
        list.append(c);
      });
      stage.append(list);
    } else clearStage();
  }

  /* Live steps while an action runs */
  function openAction(e) {
    const stage = openStage(label(e.tool)), work = el("div", "work"), track = el("div", "track");
    track.append(el("i")); work.append(track, el("ul", "steps")); stage.append(work);
  }
  function addStep(text) {
    const list = $("stage").querySelector(".steps");
    if (!list) return;
    list.querySelectorAll("li").forEach(li => { li.className = "past"; });
    list.append(el("li", "current", text));
  }
    /* The microphone. One 16 kHz capture feeds both the "Hey Jarvis" worker and command recording, so it works in any browser.
     The wake word models run on this device. Audio only leaves it as a recorded command, after the wake word or a tap on the mic.
     Browsers stop the mic when the tab is hidden or the phone locks, so hands-free needs the page open and the screen on. */
  // In 80 ms blocks. Detection lags the words, so about two seconds before it are kept, or "Hey Jarvis, what's the weather" would lose its start.
  const PREROLL_BLOCKS = 28, REARM_BLOCKS = 6, QUICK_BLOCKS = 12, END_SILENCE_BLOCKS = 8, NO_SPEECH_BLOCKS = 62, MAX_BLOCKS = 150, MIN_SPEECH_BLOCKS = 3;
  const WAKE_COOLDOWN_MS = 2500, SPEECH_FLOOR = 0.012, SPEECH_OVER_NOISE = 3, NOISE_CAP = 0.05;
  const WAKE_WORD = /\b(?:j[ae]rv[iu]s|javis)\b[\s,.!?:;-]*/ig;
  const JUST_STOP = /^(stop|be quiet|quiet|shut up|never mind|nevermind|cancel)\W*$/i;
  let wakeOn = store.get("jarvis.wake") === "on", mic = null, worker = null, wakeReady = false, recording = null;
  let guardTimer = null, preroll = [], noise = 0.003, wakeLock = null, lastWake = 0, chimeCtx = null, spokeLast = false;

  function wakeStatus(text, warn) {
    $("wakeState").hidden = !text; $("wakeState").textContent = text || "";
    $("wakeState").classList.toggle("warn", Boolean(warn));
  }
  function chime() {
    try {
      chimeCtx = chimeCtx || new AudioContext();
      chimeCtx.resume();
      [[660, 0], [880, 0.09]].forEach(([freq, at]) => {
        const osc = chimeCtx.createOscillator(), gain = chimeCtx.createGain(), start = chimeCtx.currentTime + at;
        osc.frequency.value = freq; osc.connect(gain); gain.connect(chimeCtx.destination);
        gain.gain.setValueAtTime(0.12, start); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
        osc.start(start); osc.stop(start + 0.13);
      });
    } catch { /* the chime is a nicety */ }
  }
  async function holdScreen() {
    try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } }
    catch { /* the screen may sleep; listening still works until it does */ }
  }
  function releaseScreen() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }

  async function openMic() {
    if (mic) return true;
    if (!navigator.mediaDevices || !window.AudioWorkletNode) { $("said").textContent = "This browser can't use the microphone here. Type your command instead."; return false; }
    let stream, ctx;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule("wake-capture.js?v=1");
      const node = new AudioWorkletNode(ctx, "wake-capture", { numberOfOutputs: 0 });
      ctx.createMediaStreamSource(stream).connect(node);
      node.port.onmessage = e => onBlock(e.data);
      mic = { stream, ctx, node };
      ctx.resume().catch(() => {});
      return true;
    } catch (error) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
      $("said").textContent = error && error.name === "NotAllowedError" ? "Microphone access is blocked for this site." : "I couldn't start the microphone.";
      return false;
    }
  }
  function closeMic() {
    if (!mic) return;
    mic.stream.getTracks().forEach(t => t.stop());
    mic.ctx.close().catch(() => {});
    mic = null; preroll = [];
  }

  function onBlock(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const level = Math.sqrt(sum / block.length);
    if (recording) return recordBlock(block, level);
    // follows the quiet between words: drops quickly, rises slowly, so speech never counts as background noise
    noise = Math.min(NOISE_CAP, level < noise ? noise * 0.7 + level * 0.3 : noise * 0.998 + level * 0.002);
    preroll.push(block);
    if (preroll.length > PREROLL_BLOCKS) preroll.shift();
    if (worker && wakeReady && !document.hidden) { const copy = block.slice(); worker.postMessage(copy, [copy.buffer]); }
  }
  function recordBlock(block, level) {
    const r = recording;
    r.blocks.push(block); r.total++;
    if (level > Math.max(SPEECH_FLOOR, noise * SPEECH_OVER_NOISE)) { r.speech++; r.silent = 0; }
    else r.silent++;
    const finished = (r.speech >= MIN_SPEECH_BLOCKS && r.silent >= END_SILENCE_BLOCKS) || r.total >= MAX_BLOCKS;
    // after the wake word, a short quiet means check what's already been said rather than wait
    if (finished || (r.afterWake && !r.speech && r.total >= QUICK_BLOCKS) || (!r.speech && r.total >= NO_SPEECH_BLOCKS)) finishRecording();
  }
  function setHearing(on) { hearing = on; $("mic").setAttribute("aria-pressed", String(on)); showMode(); }

  function startListening(fromWake) {
    const earlier = fromWake === true ? preroll.slice() : [];
    stopSpeech(); stopListening();
    recording = { blocks: earlier, afterWake: fromWake === true, total: 0, speech: 0, silent: 0 };
    armGuard();
    setHearing(true); $("said").textContent = "";
    openMic().then(ok => { if (!ok) { recording = null; setHearing(false); } });
  }
  function armGuard() {  // in case the mic goes quiet for good and blocks stop arriving
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => { if (recording) finishRecording(); }, (MAX_BLOCKS * 80) + 2000);
  }
  function stopListening() {
    clearTimeout(guardTimer);
    recording = null; setHearing(false);
    afterRecording();
  }
  function afterRecording() {
    if (worker) worker.postMessage({ type: "reset" });
    preroll = [];
    if (!wakeOn) closeMic();
  }
  function wavFrom(blocks) {
    const samples = blocks.length * 1280, out = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at, s) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
    text(0, "RIFF"); out.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt "); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, 16000, true); out.setUint32(28, 32000, true);
    out.setUint16(32, 2, true); out.setUint16(34, 16, true); text(36, "data"); out.setUint32(40, samples * 2, true);
    let at = 44;
    blocks.forEach(block => { for (let i = 0; i < block.length; i++, at += 2) out.setInt16(at, Math.max(-1, Math.min(1, block[i])) * 32767, true); });
    return out.buffer;
  }
  async function finishRecording() {
    const r = recording;
    clearTimeout(guardTimer);
    recording = null; setHearing(false);
    afterRecording();
    if (r) console.debug("recorded", r.total, "blocks,", r.speech, "speech,", r.silent, "quiet, noise", noise.toFixed(4));
    if (!r || (!r.afterWake && r.speech < MIN_SPEECH_BLOCKS)) return;  // nothing said, and sending silence makes speech models invent words
    transcribing = true; showMode();
    let res = null, data = {};
    try {
      res = await fetch("/api/jarvis/stt", { method: "POST", headers: { "x-jarvis-session": session, "content-type": "audio/wav" }, body: wavFrom(r.blocks) });
      data = await res.json().catch(() => ({}));
    } catch { /* shown below */ }
    transcribing = false; showMode();
    if (res && res.status === 401) return signedOut(data.code);
    if (!res || !res.ok) { $("said").textContent = data.error || "I couldn't reach speech recognition just now."; return; }
    let heard = String(data.text || "").trim();
    if (r.afterWake) {
      // Whisper is the second opinion: no "Jarvis" in what it heard means the wake word fired on something else
      const words = [...heard.matchAll(WAKE_WORD)], last = words[words.length - 1];
      if (!last) { console.debug("false wake:", heard); return; }
      heard = heard.slice(last.index + last[0].length).trim();
      if (!heard) {  // said only "Hey Jarvis", so now wait for the command, keeping anything said during that check
        if (recording) return;
        recording = { blocks: preroll.slice(-REARM_BLOCKS), afterWake: false, total: 0, speech: 0, silent: 0 };
        armGuard(); setHearing(true);
        return;
      }
    } else {
      heard = heard.replace(/^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:j[ae]rv[iu]s|javis)\b[\s,.!?:;-]*/i, "").trim();
    }
    if (!heard) return;
    $("said").textContent = heard;
    if (!pendingTool && JUST_STOP.test(heard)) { $("said").textContent = ""; return; }  // a bare "stop" only silences Jarvis
    spokeLast = true;
    sendCommand(heard);
  }
  $("mic").addEventListener("click", () => {
    if (!hearing) return startListening();
    if (recording && recording.speech >= MIN_SPEECH_BLOCKS) finishRecording(); else stopListening();
  });

  /* "Hey Jarvis" */
  function stopCapture() {
    recording = null; if (hearing) setHearing(false);
    if (worker) worker.terminate();
    worker = null; wakeReady = false;
    closeMic(); releaseScreen();
  }
  async function startCapture() {
    if (worker || !wakeOn) return;
    wakeStatus("STARTING WAKE WORD");
    if (!await openMic() || !wakeOn) return wakeOn ? wakeStatus("WAKE WORD FAILED / USE THE MIC BUTTON", true) : undefined;
    if (worker) return;
    const failed = text => { stopCapture(); wakeStatus("WAKE WORD FAILED / USE THE MIC BUTTON", true); if (text) console.warn("wake word:", text); };
    worker = new Worker("wake-worker.js?v=1");
    worker.onerror = () => failed();
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "ready") {
        wakeReady = true;
        const running = mic && mic.ctx.state === "running";
        wakeStatus(running ? 'LISTENING FOR "HEY JARVIS"' : "TAP THE PAGE TO START LISTENING", !running);
        holdScreen();
      } else if (m.type === "failed") failed(m.error);
      else if (m.type === "stats") console.debug("wake stats", m.ms.toFixed(1) + " ms per block", "peak " + m.peak.toFixed(3));
      else if (m.type === "wake") onWake(m.score);
    };
  }
  function onWake(score) {
    const now = Date.now();
    console.debug("wake word heard", score.toFixed(3));
    if (recording || now - lastWake < WAKE_COOLDOWN_MS) return;
    lastWake = now;
    chime();
    startListening(true);
  }
  function setWake(on) {
    wakeOn = on; store.set("jarvis.wake", on ? "on" : "off");
    $("wakeToggle").setAttribute("aria-pressed", String(on)); $("wakeLabel").textContent = on ? "Hey Jarvis" : "Off";
    if (on) startCapture(); else { stopCapture(); wakeStatus(""); }
  }
  $("wakeToggle").addEventListener("click", () => setWake(!wakeOn));
  document.addEventListener("pointerdown", () => {
    if (mic && mic.ctx.state !== "running") mic.ctx.resume().then(() => { if (wakeReady) wakeStatus('LISTENING FOR "HEY JARVIS"'); }).catch(() => {});
    else if (wakeOn && !worker && !$("app").hidden) startCapture();
  });

  $("commandForm").addEventListener("submit", e => {
    e.preventDefault();
    const box = $("command"), text = box.value.trim();
    if (!text) return;
    box.value = "";
    spokeLast = false;
    sendCommand(text);
  });
  async function sendCommand(text, extra) {
    stopListening(); stopSpeech(); openTurn(); clearStage();
    const r = await api("chat", { text, ...extra });
    closeTurn();
    if (r.ok) speakReply(r.data);
    if (!r.ok && r.status !== 401) $("said").textContent = r.data.error || "That didn't go through.";
    else if (r.ok && !live) { showReply(r.data); setPending(r.data.awaiting_confirmation ? { tool: r.data.tool, question: r.data.text } : null); }
  }
  $("signOut").addEventListener("click", () => { stopListening(); stopSpeech(); stopCapture(); wakeStatus(""); session = ""; store.del("jarvis.session"); stopLive(); closeSheet(); showGate("pin", "Locked. Enter your PIN."); });

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
    if (document.hidden) { if (abort) { abort.abort(); abort = null; } stopCapture(); }
    else if (session && !$("app").hidden) { connect(); startCapture(); }
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

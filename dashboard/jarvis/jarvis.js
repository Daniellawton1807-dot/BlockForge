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
  let status = {}, log = [], live = false, pendingTool = null, pendingQuestion = "", sheetKind = null, panelTimer = null, pollTimer = null, abort = null;
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
    // only a view this page hasn't seen, or closing one would have it come back on the next reconnect
    if (v.view && v.view_at !== seenView) { seenView = v.view_at; renderView(v.view); }
  }

  let seenView = null;
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
      case "web": webLive(e); break;
      case "wait": if (turnOpen) say("One moment, " + address + "."); break;
      case "timer": pushLog(e); $("said").textContent = e.text; say(e.text); break;
    }
  }
  function showReply(r) {
    const type = r.view && r.view.type;
    seenView = r.view_at || seenView;
    $("said").textContent = ["notice", "error", "web", "media", "home"].includes(type) ? "" : r.text;
    $("stage").classList.remove("stale");
    if (type !== "notice") hideToast();
    if (!r.view && r.awaiting_confirmation) return;  // a question stays over whatever's on screen
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

  /* Speech. One audio element is unlocked by the first command, because browsers block sound started any other way.
     It plays ElevenLabs as the audio arrives; if that fails, the browser's own voice takes over and the page says so. */
  const SILENCE = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const player = new Audio();
  let voiceRefused = false, speaking = false, voiceOn = store.get("jarvis.voice") !== "off", unlocked = false, speechQueue = [], speechToken = 0;
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
    unlocked = true; voiceRefused = false;
    player.src = SILENCE;
    player.play().catch(e => { if (e.name === "NotAllowedError") unlocked = false; });
  }
  // not on any touch: starting even silence wakes the speakers, which you can hear. A command's own tap is enough, and while
  // the mic is open browsers allow sound anyway, so a touch only counts once sound has actually been refused.
  document.addEventListener("click", e => { if (e.target.closest("button")) unlockAudio(); });
  document.addEventListener("pointerdown", () => { if (voiceRefused) unlockAudio(); });
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
    const text = item && item.clip ? null : item && item.text ? item.text : item;
    if (item && item.before) item.before();
    if (!item) {
      setSpeaking(false);
      // a spoken command that ends in a question gets a spoken answer: listen by itself
      if ((spokeLast && askedBack) || pendingTool) { askedBack = false; startListening(); }
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
    player.play().then(() => warnVoice("")).catch(e => { if (e.name === "NotAllowedError") { voiceRefused = true; unlocked = false; setSpeaking(false); speechQueue = []; warnVoice("TAP THE PAGE ONCE TO ALLOW SOUND"); } else failed(); });
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
    pendingQuestion = p ? p.question || "Shall I proceed?" : "";
    if (p) $("said").textContent = pendingQuestion;
  }
  function openTurn() { turnOpen = true; acked = false; }
  function closeTurn() { turnOpen = false; }
  // after "Right away, sir", a success needs no follow-up; failures and answers are still spoken
  function speakReply(data) {
    askedBack = /\?\s*$/.test(data.text || "");
    if (data.quiet && acked) return;
    say(data.text);
    if (data.view && data.view.type === "web" && data.view.mode === "walk" && voiceOn) {
      data.view.points.forEach((p, i) => { speechQueue.push({ text: p.text, before: () => showPoint(i) }); });
      if (!speaking) nextSpeech();
    }
    // a question for permission is answered out loud, however the command was given
    if (!voiceOn && ((spokeLast && askedBack) || pendingTool || data.awaiting_confirmation)) { askedBack = false; startListening(); }
  }

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
      if (s.memory && s.storage) $("mini").textContent = "CPU " + num(s.cpu) + "%   MEM " + num(s.memory.percent) + "%   DISK " + num(s.storage.percent) + "%";
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

  /* Scenes. Each reply says what it wants shown, and the whole page rearranges for it: the side panels slide out, the reactor flies to
     wherever that scene leaves room, and the content takes the page. Text only, never HTML from data. */
  const SCENES = { report: "report", weather: "weather", media: "cinema", options: "wall", table: "reading", sections: "reading", suggestions: "reading", error: "alert", web: "web", race: "race" };
  const CALM = window.matchMedia("(prefers-reduced-motion: reduce)");
  const HOME_AFTER_MS = 300000;
  let noticeTimer = null, sceneTimer = null, cineTimer = null, webState = null, walkTimer = null, ambientKey = "";

  function setScene(name) {
    const body = document.body, was = body.dataset.scene || "";
    if (was === (name || "")) return;
    const reactor = document.querySelector(".reactor"), from = reactor.getBoundingClientRect();
    if (name) body.dataset.scene = name; else delete body.dataset.scene;
    const to = reactor.getBoundingClientRect();
    if (CALM.matches || !from.width || !to.width) return;
    // the reactor really travels: from where it was to wherever this scene puts it
    reactor.animate([{ transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width})` }, { transform: "none" }], { duration: 800, easing: "cubic-bezier(.2,.9,.25,1)" });
    $("sweep").animate([{ top: "0", opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0.7, offset: 0.8 }, { top: "100%", opacity: 0 }], { duration: 800, easing: "ease-in-out" });
  }
  function keepScene() {
    clearTimeout(sceneTimer);
    if (document.body.dataset.scene) sceneTimer = setTimeout(() => { if (speaking || recording) keepScene(); else goHome(); }, HOME_AFTER_MS);
  }
  document.addEventListener("pointerdown", () => keepScene());
  function emptyStage() {
    clearInterval(cineTimer); clearInterval(walkTimer);
    webState = null;
    const stage = $("stage");
    stage.hidden = true; stage.replaceChildren(); stage.className = "stage";
  }
  function goHome() {
    emptyStage(); setAmbient(); setScene(null);
    clearTimeout(sceneTimer);
  }
  function openStage(title, scene) {
    emptyStage();
    const stage = $("stage");
    stage.hidden = false;
    setScene(scene);
    if (title !== null) stage.append(stageHead(title));
    keepScene();
    return stage;
  }
  function stageHead(title) {
    const head = el("div", "stage-head");
    head.append(el("h3", "", title));
    const close = el("button", "stage-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close"); close.addEventListener("click", () => { $("said").textContent = ""; goHome(); });
    head.append(close);
    return head;
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("sheet").hidden) goHome(); });

  /* What's behind the page: a title's backdrop, or the sky */
  function setAmbient(kind, key) {
    const box = $("ambient");
    if (ambientKey === (key || "") && key) return;
    ambientKey = key || "";
    if (!kind) { box.className = "ambient"; setTimeout(() => { if (!ambientKey) box.replaceChildren(); }, 700); return; }
    box.className = "ambient on " + kind;
    return box;
  }
  async function setBackdrop(id) {
    if (!id) return;
    const key = "B" + id;
    const box = setAmbient("backdrop", key);
    if (!box) return;
    const res = await fetch("/api/jarvis/img/" + encodeURIComponent(key), { headers: { "x-jarvis-session": session } }).catch(() => null);
    if (!res || !res.ok || ambientKey !== key) return;
    const layer = el("div", "backdrop");
    layer.style.backgroundImage = `url(${URL.createObjectURL(await res.blob())})`;
    while (box.childElementCount > 1) box.firstElementChild.remove();
    box.append(layer);
  }
  function setSky(kind, night) {
    const box = setAmbient("sky k-" + kind + (night ? " night" : ""), "sky-" + kind + night);
    if (box) { box.replaceChildren(); ["cloud c1", "cloud c2", "cloud c3", "fall"].forEach(c => box.append(el("i", c))); }
  }

  async function loadImage(img, id) {
    const res = await fetch("/api/jarvis/img/" + encodeURIComponent(id), { headers: { "x-jarvis-session": session } }).catch(() => null);
    if (res && res.ok) img.src = URL.createObjectURL(await res.blob()); else img.remove();
  }
  const poster = (id, alt) => { const img = el("img"); img.alt = alt || ""; loadImage(img, id); return img; };
  const STATES = { good: ["✓", "Healthy"], warn: ["!", "Watch"], bad: ["✕", "Problem"] };
  const RING = '<svg viewBox="0 0 60 60" aria-hidden="true"><circle class="t" cx="30" cy="30" r="25"/><circle class="v" cx="30" cy="30" r="25" pathLength="100"/></svg>';

  function drawTile(c, i) {
    const t = el("div", "tile " + (c.state || ""));
    t.style.animationDelay = i * 45 + "ms";
    const words = el("div", "words");
    words.append(el("small", "", c.label), el("b", "", c.value));
    if (c.detail) words.append(el("span", "more", c.detail));
    if (STATES[c.state] && c.state !== "good") { const p = el("span", "pill " + c.state); p.textContent = STATES[c.state][0] + " " + STATES[c.state][1]; words.append(p); }
    t.append(words);
    if (typeof c.percent === "number") {
      const ring = el("div", "gauge");
      ring.innerHTML = RING;
      const value = Math.max(0, Math.min(100, c.percent));
      requestAnimationFrame(() => { ring.querySelector(".v").style.strokeDasharray = value + " 100"; });
      t.append(ring);
    }
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
    chart.labels.forEach((l, i) => { if (i % 6 === 0) make("text", { class: "axis", x: Math.max(L + 14, x(i)), y: H - 5, "text-anchor": "middle" }, l + ":00"); });
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

  /* Weather across the whole page, under its own sky */
  const SKY_ICONS = {
    clear: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3 7 7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7"/>',
    moon: '<path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z"/>',
    part: '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1"/><path d="M8 19h9a3.6 3.6 0 0 0 .4-7.2A5 5 0 0 0 8 12.5 3.3 3.3 0 0 0 8 19z"/>',
    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .5-8A5.6 5.6 0 0 0 6.7 11 3.8 3.8 0 0 0 7 18.5z"/>',
    fog: '<path d="M7 13h10a3.6 3.6 0 0 0 .4-7.2A5 5 0 0 0 7.7 7 3.1 3.1 0 0 0 7 13zM4 16.5h16M6.5 20h11"/>',
    rain: '<path d="M7 14.5h10a3.8 3.8 0 0 0 .4-7.6A5.3 5.3 0 0 0 7.2 8 3.3 3.3 0 0 0 7 14.5zM8.5 17.5l-1 3M12.5 17.5l-1 3M16.5 17.5l-1 3"/>',
    snow: '<path d="M7 14.5h10a3.8 3.8 0 0 0 .4-7.6A5.3 5.3 0 0 0 7.2 8 3.3 3.3 0 0 0 7 14.5z"/><path d="M8 18.5h.01M12 20.5h.01M16 18.5h.01" stroke-width="2.4"/>',
    storm: '<path d="M7 13.5h10a3.8 3.8 0 0 0 .4-7.6A5.3 5.3 0 0 0 7.2 7 3.3 3.3 0 0 0 7 13.5zM13 13l-2.5 4h3L11 21.5"/>'
  };
  function skyIcon(kind, night) {
    const icon = el("span", "skyicon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ((night && kind === "clear" ? SKY_ICONS.moon : SKY_ICONS[kind]) || SKY_ICONS.cloud) + "</svg>";
    return icon;
  }
  function renderWeather(v, stage) {
    setSky(v.now.kind, v.now.night);
    const hero = el("div", "wx-hero"), big = el("div", "wx-now"), head = el("div", "wx-place");
    big.append(skyIcon(v.now.kind, v.now.night), el("b", "", v.now.temp + "°"));
    head.append(el("h3", "", v.place + (v.label ? "  /  " + v.label : "")), el("p", "", v.now.sky + "  ·  " + (v.label ? "low of " + v.now.low + "°" : "feels like " + v.now.feels + "°")));
    const tiles = el("div", "wx-tiles");
    const shown = v.days[v.focus || 0];
    [["High", shown.high + "°"], ["Low", shown.low + "°"], ["Rain", shown.rain + "%"], ["Wind", v.now.wind + " mph"], v.now.humidity != null ? ["Humidity", v.now.humidity + "%"] : ["Day", new Date(shown.date + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })], ["Sun", v.sunrise + " – " + v.sunset]]
      .forEach(([a, b], i) => { const t = el("div", "wx-tile"); t.style.animationDelay = 120 + i * 40 + "ms"; t.append(el("small", "", a), el("b", "", b)); tiles.append(t); });
    hero.append(big, head, tiles);
    const close = stageHead("").querySelector("button"); close.classList.add("floating");
    const hours = el("div", "wx-hours");
    v.hours.forEach((h, i) => {
      const isNow = i === 0 && !v.label;
      const c = el("div", "wx-hour" + (isNow ? " now" : "")); c.style.animationDelay = 200 + i * 18 + "ms";
      c.append(el("small", "", isNow ? "NOW" : h.hour + ":00"), skyIcon(h.kind, h.night), el("b", "", h.temp + "°"));
      c.append(el("span", "wet", h.rain != null ? h.rain + "%" : " "));
      hours.append(c);
    });
    const lower = el("div", "wx-lower"), charts = el("div", "wx-charts"), days = el("div", "wx-days");
    v.charts.forEach(c => charts.append(drawChart(c)));
    const floor = Math.min(...v.days.map(d => d.low)), span = Math.max(1, Math.max(...v.days.map(d => d.high)) - floor);
    days.append(el("h4", "", "SEVEN DAYS"));
    v.days.forEach((d, i) => {
      const r = el("div", "wx-day" + (v.label && i === v.focus ? " on" : "")), bar = el("div", "range"), fill = el("i");
      fill.style.left = (d.low - floor) / span * 100 + "%"; fill.style.width = Math.max(4, (d.high - d.low) / span * 100) + "%";
      bar.append(fill);
      const name = i === 0 ? "Today" : new Date(d.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short" });
      r.append(el("span", "day", name), skyIcon(d.kind), el("span", "wet", d.rain != null ? d.rain + "%" : ""), el("span", "lo", d.low + "°"), bar, el("span", "hi", d.high + "°"));
      days.append(r);
    });
    lower.append(charts, days);
    stage.append(close, hero, hours, lower);
  }

  /* Formula 1: the next race, a countdown, its weekend and the rest of the season */
  function renderRace(v, stage) {
    const close = stageHead("").querySelector("button"); close.classList.add("floating");
    const hero = el("div", "gp"), name = el("div", "gp-name"), count = el("div", "gp-count");
    name.append(el("small", "", "ROUND " + v.round + "  /  " + v.season), el("h2", "", v.name), el("p", "", v.circuit + "  ·  " + v.place), el("p", "gp-when", v.day + (v.time ? "  ·  " + v.time : "")));
    hero.append(name);
    if (v.at) {
      const units = [["DAYS", 86400], ["HRS", 3600], ["MIN", 60]].map(([label, size]) => { const u = el("div", "unit"), b = el("b"); u.append(b, el("small", "", label)); count.append(u); return [b, size]; });
      const draw = () => {
        let left = Math.max(0, (new Date(v.at) - Date.now()) / 1000);
        units.forEach(([b, size]) => { const n = Math.floor(left / size); left -= n * size; b.textContent = String(n).padStart(2, "0"); });
      };
      draw(); cineTimer = setInterval(draw, 30000);
      hero.append(count);
    }
    const lower = el("div", "gp-lower"), part = (title, build) => { const box = el("section", "gp-part"); box.append(el("h4", "", title)); build(box); lower.append(box); };
    part("RACE WEEKEND", box => v.sessions.forEach(s => {
      const r = el("div", "gp-row" + (s.name === "Race" ? " main" : "") + (s.at && new Date(s.at) < Date.now() ? " past" : ""));
      r.append(el("span", "", s.name), el("span", "dim", s.day), el("b", "", s.time || "TBC")); box.append(r);
    }));
    if (v.standings.length) part("DRIVERS' STANDINGS", box => v.standings.forEach(d => {
      const r = el("div", "gp-row");
      r.append(el("span", "pos", d.position), el("span", "", d.name), el("b", "", d.points)); box.append(r);
    }));
    if (v.next.length) part("AFTER THAT", box => v.next.forEach(r => {
      const row = el("div", "gp-row");
      row.append(el("span", "", r.name), el("span", "dim", r.day)); box.append(row);
    }));
    stage.append(close, hero, lower);
  }

  /* A title on screen: cinema, with its backdrop behind the whole page */
  function renderCinema(v, stage) {
    const [main, ...others] = v.items, clock = s => { const m = Math.floor((s || 0) / 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
    setBackdrop(main.backdrop || main.image);
    const hero = el("div", "cine"), txt = el("div", "cine-text");
    if (main.image) hero.append(poster(main.image, main.title));
    txt.append(el("small", "", (main.paused ? "PAUSED ON " : "NOW PLAYING ON ") + String(main.tv || "").toUpperCase()), el("h2", "", main.title));
    if (main.subtitle) txt.append(el("p", "cine-sub", main.subtitle));
    if (main.overview) txt.append(el("p", "cine-over", main.overview));
    if (main.runtime) {
      const bar = el("div", "meter big"), fill = el("i"), when = el("span", "cine-time");
      let at = main.position || 0;
      const draw = () => { fill.style.width = Math.min(100, at / main.runtime * 100) + "%"; when.textContent = clock(at) + " of " + clock(main.runtime); };
      draw(); bar.append(fill); txt.append(bar, when);
      if (!main.paused) cineTimer = setInterval(() => { at += 15; draw(); }, 15000);
    }
    hero.append(txt);
    stage.append(hero);
    others.forEach(m => {
      const row = el("div", "mediarow"), t = el("div", "txt");
      if (m.image) row.append(poster(m.image, m.title));
      t.append(el("small", "", String(m.tv || "").toUpperCase()), el("b", "", m.title));
      if (m.subtitle) t.append(el("span", "", m.subtitle));
      row.append(t); stage.append(row);
    });
  }

  /* Options as a wall of posters; whichever you're on lights the page behind it */
  function renderWall(v, stage) {
    const grid = el("div", "wall");
    const lead = v.items.find(o => o.image);
    if (lead) setBackdrop(lead.image); else setAmbient();
    v.items.forEach((o, i) => {
      const b = el("button", "opt" + (o.image ? " art" : "")); b.type = "button"; b.style.animationDelay = Math.min(i, 12) * 70 + "ms";
      const txt = el("span", "txt");
      txt.append(el("b", "", o.label));
      if (o.detail) txt.append(el("small", "", o.detail));
      if (o.progress) { const bar = el("span", "meter"), f = el("i"); bar.style.display = "block"; f.style.width = o.progress + "%"; bar.append(f); txt.append(bar); }
      if (o.image) b.append(poster(o.image, ""));
      b.append(el("span", "num", String(i + 1)), txt);
      if (o.image) { const lit = () => setBackdrop(o.image); b.addEventListener("pointerenter", lit); b.addEventListener("focus", lit); }
      b.addEventListener("click", () => { spokeLast = false; sendCommand(o.label, { option_set: v.id, option: i }); });
      grid.append(b);
    });
    stage.append(grid, el("p", "hint", 'Tap one, or say "the second one".'));
  }

  function renderView(v) {
    if (!v || v.type === "home") return goHome();
    if (v.type === "notice") return showNotice(v);
    const scene = SCENES[v.type];
    if (!scene) return;
    setAmbient();
    if (v.type === "report") {
      const stage = openStage(v.title, scene);
      if (v.cards && v.cards.length) { const g = el("div", "cards"); v.cards.forEach((c, i) => g.append(drawTile(c, i))); stage.append(g); }
      if (v.charts && v.charts.length) { const g = el("div", "chartgrid"); v.charts.forEach(c => g.append(drawChart(c))); stage.append(g); }
    } else if (v.type === "weather") renderWeather(v, openStage(null, scene));
    else if (v.type === "race") renderRace(v, openStage(null, scene));
    else if (v.type === "media") {
      const stage = openStage(null, scene), close = stageHead("").querySelector("button");
      close.classList.add("floating"); stage.append(close);
      renderCinema(v, stage);
    } else if (v.type === "options") renderWall(v, openStage(v.title, scene));
    else if (v.type === "error") {
      const stage = openStage(null, scene), box = el("div", "alertbox"), head = el("div", "errhead"), close = stageHead("").querySelector("button");
      head.append(el("i", "", "!"), el("h3", "", v.title), close);
      box.append(head);
      const part = (label, text) => { const d = el("p", "diag"); d.append(el("small", "", label), document.createTextNode(text)); box.append(d); };
      part("WHAT HAPPENED", v.what);
      if (v.why) part("LIKELY CAUSE", v.why);
      if (v.tips && v.tips.length) { const u = el("ul", "tips"); v.tips.forEach(t => u.append(el("li", "", t))); box.append(el("small", "", "WHAT TO TRY"), u); }
      const again = el("button", "act", "TRY AGAIN"); again.type = "button";
      again.addEventListener("click", () => { spokeLast = false; sendCommand("try again"); });
      box.append(again); stage.append(box);
    } else if (v.type === "table") {
      const stage = openStage(v.title, scene), scroll = el("div", "scrollx"), table = el("table", "compare");
      if (v.columns && v.columns.length) { const tr = el("tr"); v.columns.forEach(c => tr.append(el("th", "", c))); table.append(tr); }
      v.rows.forEach(r => { const tr = el("tr"); r.forEach(c => tr.append(el("td", "", c))); table.append(tr); });
      scroll.append(table); stage.append(scroll);
      if (v.verdict) stage.append(el("p", "verdict", v.verdict));
    } else if (v.type === "sections") {
      const stage = openStage(v.title, scene), wide = window.innerWidth > 1000;
      v.sections.forEach((s, i) => { const d = el("details", "part"); d.open = wide || i === 0; d.style.animationDelay = i * 70 + "ms"; d.append(el("summary", "", s.heading), el("p", "", s.body)); stage.append(d); });
    } else if (v.type === "suggestions") {
      const stage = openStage(v.title, scene), list = el("div", "sugg");
      v.items.forEach((s, i) => {
        const c = el("div", "sug"); c.style.animationDelay = i * 70 + "ms"; c.append(el("b", "", s.title));
        if (s.detail) c.append(el("span", "", s.detail));
        if (s.command) { const go = el("button", "act", "DO THIS"); go.type = "button"; go.addEventListener("click", () => { spokeLast = false; sendCommand(s.command); }); c.append(go); }
        list.append(c);
      });
      stage.append(list);
    } else if (v.type === "web") {
      webState = null;
      webLive({ ...v, stage: "done", status: "" });
    }
  }

  /* The web: a browser you can watch, beside what Jarvis makes of it */
  let trailOpen = false;
  const WEB_FIELDS = ["trail", "summary", "standing", "standing_text", "hide_page", "query", "status", "url", "site", "frame", "hero", "results", "answer", "facts", "points", "read", "mode", "stage"];
  function webLive(e) {
    const starting = e.stage === "searching" || !webState;
    if (starting) { emptyStage(); $("said").textContent = ""; hideToast(); setAmbient(); webState = { results: [], points: [], facts: [], answer: "", index: 0 }; }
    WEB_FIELDS.forEach(k => { if (e[k] !== undefined) webState[k] = e[k]; });
    webState.live = e.stage !== "done";
    if (e.stage === "searching" && turnOpen) acknowledge();
    drawWeb();
    if (e.stage === "done" && webState.mode === "walk" && webState.points.length) startWalk();
  }
  function webCommand(text) { spokeLast = false; sendCommand(text, { keep: true }); }
  function drawWeb() {
    const w = webState, stage = $("stage");
    let root = stage.querySelector(".web");
    if (!root) {
      stage.hidden = false; stage.replaceChildren();
      setScene("web"); keepScene();
      stage.append(stageHead(""));
      root = el("div", "web");
      const browser = el("div", "browser"), bar = el("div", "bar"), view = el("div", "view");
      bar.append(el("span", "lamp"), el("span", "addr"));
      [["▲", "Scroll up", "scroll up"], ["▼", "Scroll down", "scroll down"], ["←", "Go back", "go back"]].forEach(([t, name, cmd]) => {
        const b = el("button", "ctl", t); b.type = "button"; b.setAttribute("aria-label", name); b.addEventListener("click", () => webCommand(cmd)); bar.append(b);
      });
      const out = el("a", "ctl out", "↗"); out.target = "_blank"; out.rel = "noopener noreferrer"; out.setAttribute("aria-label", "Open this page in a new tab"); bar.append(out);
      view.append(el("div", "scan"), el("p", "caption"));
      browser.append(bar, view);
      root.append(browser, el("div", "side"));
      stage.append(root);
    }
    stage.querySelector(".stage-head h3").textContent = w.query ? "WEB  /  " + w.query : "WEB";
    root.dataset.mode = w.live ? "live" : w.mode || "answer";
    root.classList.toggle("busy", w.live);
    root.querySelector(".addr").textContent = w.live && w.status ? w.status : w.url ? w.url.replace(/^https?:\/\/(www\.)?/, "") : "";
    const out = root.querySelector(".out");
    if (/^https?:\/\//.test(w.url || "")) { out.href = w.url; out.hidden = false; } else out.hidden = true;
    const noPage = w.hide_page || (!w.frame && !w.live);
    root.querySelector(".browser").hidden = noPage;
    root.classList.toggle("solo", noPage);
    setFrame(w.mode === "walk" && w.points[w.index] && !w.live ? w.points[w.index].frame || w.frame : w.frame);
    drawWebSide(root.querySelector(".side"));
    setCaption();
  }
  function setCaption() {
    const w = webState, c = $("stage").querySelector(".caption");
    if (!c) return;
    const text = !w.live && w.mode === "walk" && w.points[w.index] ? w.points[w.index].text : "";
    c.textContent = text; c.hidden = !text;
  }
  async function setFrame(id) {
    const view = $("stage").querySelector(".view");
    if (!view || !id || view.dataset.frame === id) return;
    view.dataset.frame = id;
    const res = await fetch("/api/jarvis/img/" + encodeURIComponent(id), { headers: { "x-jarvis-session": session } }).catch(() => null);
    if (!res || !res.ok || view.dataset.frame !== id) return;
    const img = el("img", "frame");
    img.alt = "What the browser sees";
    img.src = URL.createObjectURL(await res.blob());
    img.onload = () => { view.querySelectorAll("img.frame").forEach(o => { if (o !== img) setTimeout(() => { URL.revokeObjectURL(o.src); o.remove(); }, 400); }); };
    view.prepend(img);
    img.style.zIndex = view.querySelectorAll("img.frame").length;
  }
  /* Sources are only ever those the server found: a [2] in an answer becomes a link to source 2, and anything else stays plain text */
  function citedText(text, results, cls) {
    const p = el("p", cls);
    String(text || "").split(/(\[\d+\])/).forEach(part => {
      const n = /^\[(\d+)\]$/.exec(part), source = n && results[Number(n[1]) - 1];
      if (!source || !/^https?:\/\//.test(source.url)) { if (!n) p.append(document.createTextNode(part)); return; }
      const a = el("a", "cite", n[1]);
      a.href = source.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = source.title; a.setAttribute("aria-label", "Source " + n[1] + ": " + source.title);
      p.append(a);
    });
    return p;
  }
  function sourceCard(r, i, w) {
    const card = el("div", "src" + (i === w.read ? " on" : "")), txt = el("div", "txt"), head = el("div", "srchead");
    card.style.animationDelay = i * 60 + "ms";
    if (/^https:\/\//.test(r.favicon || "")) {
      const icon = el("img", "fav"); icon.alt = ""; icon.loading = "lazy"; icon.referrerPolicy = "no-referrer"; icon.onerror = () => icon.remove(); icon.src = r.favicon;
      head.append(icon);
    }
    head.append(el("small", "", r.site));
    const title = el(/^https?:\/\//.test(r.url) ? "a" : "b", "srctitle", r.title);
    if (title.tagName === "A") { title.href = r.url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
    txt.append(head, title);
    if (r.snippet && w.mode !== "walk") txt.append(el("span", "snip", r.snippet));
    const here = el("button", "here", "VIEW HERE"); here.type = "button"; here.setAttribute("aria-label", "Open " + r.site + " here");
    here.addEventListener("click", () => webCommand("open result " + (i + 1)));
    card.append(el("span", "num", String(i + 1)), txt, here);
    return card;
  }
  function drawTrail(w, side) {
    if (!w.trail || !w.trail.length) return;
    const d = el("details", "trail"), list = el("ol");
    d.open = Boolean(w.live || trailOpen);
    d.addEventListener("toggle", () => { if (!w.live) trailOpen = d.open; });
    d.append(el("summary", "", w.live ? "RESEARCH" : "RESEARCH  /  " + (w.summary || "")));
    w.trail.forEach(t => { const li = el("li", t.kind); li.append(el("span", "", t.text)); list.append(li); });
    d.append(list); side.append(d);
  }
  function drawWebSide(side) {
    const w = webState;
    side.replaceChildren();
    if (w.live) {
      const panel = el("div", "research"), track = el("div", "track");
      track.append(el("i"));
      panel.append(el("p", "status", w.status || "Searching the web"));
      if (w.query) panel.append(el("p", "asking", w.query));
      panel.append(track);
      side.append(panel);
    }
    if (!w.live && w.answer) {
      if (w.hero && w.mode !== "walk") side.append(poster(w.hero, ""));
      side.append(citedText(w.answer, w.results, "answer"));
      if (w.standing_text) side.append(el("span", "standing " + (w.standing || ""), ({ confirmed: "✓ ", disputed: "! ", unclear: "? " }[w.standing] || "") + w.standing_text));
    }
    if (!w.live && w.facts.length) {
      const g = el("div", "facts");
      w.facts.forEach((f, i) => { const t = el("div", "fact"); t.style.animationDelay = i * 60 + "ms"; t.append(el("small", "", f.label), el("b", "", f.value)); g.append(t); });
      side.append(g);
    }
    if (!w.live && w.mode === "walk" && w.points.length) {
      const list = el("ol", "points");
      w.points.forEach((p, i) => {
        const li = el("li"), b = el("button", "pt" + (i === w.index ? " on" : ""), p.text);
        b.type = "button"; b.setAttribute("aria-current", String(i === w.index));
        b.addEventListener("click", () => { clearInterval(walkTimer); stopSpeech(); showPoint(i); say(p.text); });
        li.append(b); list.append(li);
      });
      side.append(list);
    }
    if (!w.live && w.mode === "answer" && w.results.length && !w.frameless) {
      const go = el("button", "act", w.hide_page ? "SHOW THE PAGE" : "GO THROUGH THE PAGE"); go.type = "button"; go.addEventListener("click", () => webCommand("go through it")); side.append(go);
    }
    if (w.results.length) {
      side.append(el("h4", "", "SOURCES"));
      const list = el("div", "sources");
      w.results.forEach((r, i) => list.append(sourceCard(r, i, w)));
      side.append(list);
    }
    drawTrail(w, side);
  }
  function showPoint(i) {
    if (!webState || !webState.points[i]) return;
    webState.index = i;
    setFrame(webState.points[i].frame || webState.frame);
    setCaption();
    if (window.innerWidth <= 1000) $("stage").scrollTo({ top: 0, behavior: "smooth" });  // on a phone the browser sits above the list
    $("stage").querySelectorAll(".pt").forEach((b, n) => { b.classList.toggle("on", n === i); b.setAttribute("aria-current", String(n === i)); if (n === i && window.innerWidth > 1000) b.scrollIntoView({ block: "nearest" }); });
  }
  function startWalk() {
    clearInterval(walkTimer);
    showPoint(0);
    if (voiceOn) return;  // with the voice on, each point appears as it's spoken
    let at = 0;
    walkTimer = setInterval(() => { if (!webState || ++at >= webState.points.length) return clearInterval(walkTimer); showPoint(at); }, 7000);
  }

  /* Small news, over whatever's showing: a live action and its steps, or a tick */
  const toast = () => $("toast");
  function hideToast() { clearTimeout(noticeTimer); toast().hidden = true; toast().replaceChildren(); toast().className = "toast"; }
  function showNotice(v) {
    hideToast();
    const n = el("div", "notice"), p = el("p", "", v.title || v.text);
    n.append(el("span", "tick", "✓"));
    if (v.image) n.append(poster(v.image, ""));
    if (v.subtitle) p.append(el("span", "", v.subtitle));
    n.append(p); toast().append(n); toast().hidden = false; toast().classList.add("is-notice");
    noticeTimer = setTimeout(hideToast, 6000);
  }
  function openAction(e) {
    hideToast();
    const work = el("div", "work"), track = el("div", "track");
    track.append(el("i"));
    work.append(el("h3", "", label(e.tool)), track, el("ul", "steps"));
    toast().append(work); toast().hidden = false;
  }
  function addStep(text) {
    const list = toast().querySelector(".steps");
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
      ctx = new AudioContext();  // the device's own rate: forcing 16 kHz can restart its audio hardware, which you can hear
      await ctx.audioWorklet.addModule("wake-capture.js?v=2");
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
    setHearing(true); $("said").textContent = pendingQuestion;  // the question stays up while it waits for the answer
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
    if (!heard) { $("said").textContent = pendingQuestion; return; }
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
  $("stopAll").addEventListener("click", () => { spokeLast = false; sendCommand("stop everything", { keep: true }); });
  async function sendCommand(text, extra) {
    const { keep, ...more } = extra || {};
    stopListening(); stopSpeech(); openTurn(); hideToast();
    if (!spokeLast) unlockAudio();  // typed: Enter is a gesture too, but not a button click
    clearInterval(walkTimer);
    // what's on screen stays, dimmed, until there's something to replace it, so the page never jumps home and back
    if (!keep) $("stage").classList.add("stale");
    const r = await api("chat", { text, scene: document.body.dataset.scene || "", narrow: window.innerWidth < 700, ...more });
    closeTurn();
    if (r.ok && r.data.stopped) return;  // the stop's own reply says so
    if (r.ok) speakReply(r.data);
    if (!r.ok) $("stage").classList.remove("stale");
    if (!r.ok && r.status !== 401) $("said").textContent = r.data.error || "That didn't go through.";
    else if (r.ok && !live) { showReply(r.data); setPending(r.data.awaiting_confirmation ? { tool: r.data.tool, question: r.data.text } : null); }
  }
  $("signOut").addEventListener("click", () => { stopListening(); stopSpeech(); stopCapture(); wakeStatus(""); session = ""; store.del("jarvis.session"); stopLive(); closeSheet(); goHome(); showGate("pin", "Locked. Enter your PIN."); });

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

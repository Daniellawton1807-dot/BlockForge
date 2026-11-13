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
    if (r.data.renewed && r.data.renewed.session) { session = r.data.renewed.session; store.set("jarvis.session", session); }  // stays signed in: a year from each visit
    window.dispatchEvent(new CustomEvent("jarvis:ready", { detail: { api } }));  // the brain (brain.js) asks for its map with the same session
    $("gate").hidden = true; $("app").hidden = false;
    applyView(r.data);
    connect();
    setWake(wakeOn);
    fetchToday(true);
    api("settings").then(r => { if (r.ok && Array.isArray(r.data.vocab)) vocabTerms = r.data.vocab; });  // names and titles for the device's recogniser
    spawnWorker();  // speech detection ready for the first command, not only from the second
  }

  function applyView(v) {
    if (v.status) setStatus(v.status);
    if (v.log) { log = v.log; if (sheetKind === "log") renderSheet(); }
    if (v.address) { serverAddress = v.address; address = store.get("jarvis.name") || serverAddress; }
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

  let linkOn = false, linkLostAt = 0;
  function setLink(on, text) {
    live = on && !text;  // polling connects, but delivers no replies: those come from the command's own response
    linkOn = on;
    linkLostAt = on ? 0 : linkLostAt || Date.now();
    // a moment's reconnect isn't news: the dot only turns amber if it lasts
    setTimeout(() => { if (!linkOn) $("linkDot").className = "off"; }, 4000);
    if (on) $("linkDot").className = "";
    drawStrip();
  }

  function onEvent(e) {
    switch (e.type) {
      case "hello": applyView(e); break;
      case "status": setStatus(e.status); break;
      case "mode": setMode(e.mode); break;
      case "you": pushLog(e); lastSaid = e.text || lastSaid; $("said").textContent = ""; break;
      case "reply": if (e.text) pushLog(e); showReply(e); break;
      case "action":
        pushLog(e);
        window.dispatchEvent(new CustomEvent("jarvis:tool", { detail: e.tool }));  // lights the tool up in the brain
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
  /* History (Daniel, 2026-11-06): the last answers, each one tappable to bring back, so nothing's lost when it's closed */
  const SCENE_NAMES = { weather: "WEATHER", report: "REPORT", media: "PLAYING", options: "CHOICES", table: "TABLE", sections: "EXPLAINED", suggestions: "IDEAS", error: "PROBLEM", web: "WEB", race: "F1", route: "MAP", flights: "FLIGHTS" };
  let history = [], lastSaid = "", pendingReplyDisplay = null;
  try { history = JSON.parse(sessionStorage.getItem("jarvis.history") || "[]"); } catch { history = []; }
  function remember(r) {
    if (!r.text && !(r.view && SCENES[r.view.type])) return;
    history.push({ at: Date.now(), said: lastSaid, text: r.text || "", view: r.view && SCENES[r.view.type] ? r.view : null });
    lastSaid = "";
    if (history.length > 25) history.shift();
    try {
      let saved = JSON.stringify(history);
      if (saved.length > 400000) saved = JSON.stringify(history.map((h, i) => i < history.length - 5 ? { ...h, view: null } : h));  // keep the newest views, drop the rest
      sessionStorage.setItem("jarvis.history", saved);
    } catch { /* it still works for this visit */ }
    if (sheetKind === "history") renderSheet();
  }
  function showReply(r) {
    if (r.overheard) {  // the TV or the room, not him: nothing to show, and the screen stays as it was
      $("said").textContent = "THAT DIDN'T SOUND LIKE IT WAS FOR ME";
      $("stage").classList.remove("stale");
      return;
    }
    remember(r);
    // Keep the new answer and its view together until audio playback actually begins.
    if (voiceOn && r.text && !(r.quiet && acked)) { pendingReplyDisplay = r; return; }
    revealReply(r);
  }
  function revealPendingReply(fallback) {
    const r = pendingReplyDisplay || fallback;
    pendingReplyDisplay = null;
    if (r) revealReply(r);
  }
  function revealReply(r) {
    const type = r.view && r.view.type;
    const plainAnswer = !r.view && r.text && !r.awaiting_confirmation;
    const autoDismiss = Boolean((plainAnswer || (r.view && !keepResultUntilClosed(r.view, r.text))) && voiceOn && r.text);
    clearTimeout(resultDismissTimer); resultAutoDismiss = false;
    seenView = r.view_at || seenView;
    $("said").textContent = plainAnswer || ["notice", "error", "web", "media", "home"].includes(type) ? "" : r.text;
    $("stage").classList.remove("stale");
    if (type !== "notice") hideToast();
    setPending(r.awaiting_confirmation ? { tool: r.tool, question: r.text } : null);
    if (!r.view && r.awaiting_confirmation) return;  // a question stays over whatever's on screen
    if (plainAnswer) {
      const stage = openStage("JARVIS · ANSWER", "answer"), card = el("div", "answer-card plain-answer");
      card.append(el("small", "answer-kicker", "RESPONSE"));
      appendReadableText(card, r.text, "readable-copy"); stage.append(card);
    } else renderView(r.view);
    resultAutoDismiss = autoDismiss;
  }
  function pushLog(e) { log.push(e); if (log.length > 100) log.shift(); if (sheetKind === "log") renderSheet(); }

  let serverMode = "idle", hearing = false, transcribing = false;
  function setMode(mode) { serverMode = mode; showMode(); }
  /* The reactor is Jarvis's face (Daniel, 2026-11-06): it shows what he's doing, not the server's CPU. Listening follows your voice,
     thinking spins amber, speaking pulses. */
  function showMode() {
    const mode = hearing ? "listening" : (transcribing || serverMode === "thinking") ? "thinking" : speaking ? "speaking" : "idle";
    document.body.dataset.mode = mode;
    $("modeLabel").textContent = { listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING", idle: "READY" }[mode];
    if (mode !== "listening") setLevel(0);
    showHint();
  }
  function showHint() {
    const mode = document.body.dataset.mode;
    $("hintLine").textContent = mode === "listening" ? "GO AHEAD" : mode === "thinking" ? "WORKING ON IT" : mode === "speaking" ? "TALK OVER ME TO STOP" :
      store.get("jarvis.wake") === "on" ? 'SAY "HEY JARVIS"' : "TAP THE MIC OR TYPE";
  }
  const reactorEl = document.querySelector(".reactor");
  function setLevel(v) { reactorEl.style.setProperty("--lvl", Math.max(0, Math.min(1, v)).toFixed(3)); }

  /* Speech. One audio element is unlocked by the first command, because browsers block sound started any other way.
     It plays ElevenLabs as the audio arrives; if that fails, the browser's own voice takes over and the page says so. */
  const SILENCE = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const player = new Audio();
  let paused = null;  // his reply, paused while someone talks over him
  let voiceRefused = false, speaking = false, voiceOn = store.get("jarvis.voice") !== "off", unlocked = false, speechQueue = [], speechToken = 0;
  let followUps = 0;  // times it's opened the mic by itself since he last started a command
  let askedBack = false, serverAddress = "sir", address = store.get("jarvis.name") || serverAddress, turnOpen = false, acked = false, ackClips = [], ackNext = 0, ackLoading = false;
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
  function say(text, onStart) {
    if (!voiceOn || !text) { if (onStart) onStart(); return; }
    speechQueue.push(onStart ? { text, onStart } : text);
    if (!speaking) nextSpeech();
  }
  function stopSpeech() {
    revealPendingReply();
    askedBack = false; paused = null;
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
      if (((spokeLast && askedBack) || pendingTool) && followUps < 2) { askedBack = false; followUps++; startListening(); }
      scheduleResultDismiss();
      return;
    }
    setSpeaking(true);
    const token = ++speechToken;
    let started = false;
    const onStart = () => { if (!started && token === speechToken) { started = true; if (item.onStart) item.onStart(); } };
    if (item.clip) {
      player.onplaying = onStart;
      player.onended = player.onerror = () => { if (token === speechToken) nextSpeech(); };
      player.src = item.clip;
      player.play().catch(() => { if (token === speechToken) nextSpeech(); });
      return;
    }
    const r = await api("tts", { text });
    if (token !== speechToken) return;
    if (!r.ok) return browserVoice(text, token, r.data.error, onStart);
    const failed = () => { if (token === speechToken) browserVoice(text, token, "ElevenLabs failed", onStart); };
    player.onplaying = onStart;
    player.onended = () => { if (token === speechToken) nextSpeech(); };
    player.onerror = failed;
    player.src = "/api/jarvis/tts/" + r.data.id;
    player.play().then(() => { warnVoice(""); onStart(); }).catch(e => { if (e.name === "NotAllowedError") { onStart(); voiceRefused = true; unlocked = false; setSpeaking(false); speechQueue = []; warnVoice("TAP THE PAGE ONCE TO ALLOW SOUND"); } else failed(); });
  }
  function browserVoice(text, token, why, onStart) {
    warnVoice("USING THE BROWSER'S VOICE" + (why ? " / " + String(why).toUpperCase() : ""));
    if (!window.speechSynthesis) { if (onStart) onStart(); return nextSpeech(); }
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => /en-GB/i.test(v.lang) && /male|daniel|arthur|george/i.test(v.name)) || voices.find(v => /en-GB/i.test(v.lang)) || null;
    u.lang = "en-GB";
    u.onstart = () => { if (onStart) onStart(); };
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
    if (data.overheard) { askedBack = false; return; }  // said nothing, so nothing to answer
    askedBack = /\?\s*$/.test(data.text || "");
    if (data.quiet && acked) { if (pendingReplyDisplay) revealPendingReply(); return; }
    if (voiceOn && data.text) say(data.text, () => revealPendingReply(data));
    else if (!data.text && pendingReplyDisplay) revealPendingReply();
    if (data.view && data.view.type === "web" && data.view.mode === "walk" && voiceOn) {
      data.view.points.forEach((p, i) => { speechQueue.push({ text: p.text, before: () => showPoint(i) }); });
      if (!speaking) nextSpeech();
    }
    // a question for permission is answered out loud, however the command was given
    if (!voiceOn && ((spokeLast && askedBack) || pendingTool || data.awaiting_confirmation) && followUps < 2) { askedBack = false; followUps++; startListening(); }
  }

  /* The server, on one line under the reactor: tap it for the details */
  const num = (v, d = 0) => v == null ? "--" : Number(v).toFixed(d);
  function drawStrip() {
    const s = status, parts = [];
    if (!linkOn && linkLostAt && Date.now() - linkLostAt > 4000) parts.push("RECONNECTING");
    if (s.cpu != null) parts.push("CPU " + num(s.cpu) + "%");
    if (s.memory) parts.push("MEM " + num(s.memory.percent) + "%");
    if (s.storage) parts.push("DISK " + num(s.storage.percent) + "%");
    if (s.minecraft) parts.push("MINECRAFT " + (s.minecraft.starting ? "STARTING" : s.minecraft.running ? (s.minecraft.online || 0) + " ON" : "OFF"));
    if (s.uptime) parts.push("UP " + s.uptime);
    $("stripText").textContent = "SERVER  /  " + (parts.join("  ·  ") || "CONNECTING");
  }
  function setStatus(s) {
    if (!s) return;
    status = { ...status, ...s };
    drawStrip();
    drawMinecraft();
    if (status.memory && status.storage) $("mini").textContent = "CPU " + num(status.cpu) + "%   MEM " + num(status.memory.percent) + "%   DISK " + num(status.storage.percent) + "%";
    drawNowBar();
    if (sheetKind === "server") renderSheet();
  }
  $("serverStrip").addEventListener("click", () => openSheet("server", "SERVER"));
  function drawMinecraft() {
    const m = status.minecraft;
    card("cardMinecraft", !!m);
    if (!m) return;
    $("cardMinecraft").classList.toggle("on", !!m.running);
    fill("mcList", [li(m.starting ? "Starting up" : m.running ? "Running" : "Off", m.running ? ((m.online || 0) + " of " + (m.max || "?") + " playing" + (m.players && m.players.length ? ": " + m.players.join(", ") : "")) : "Ask Jarvis to start it", m.running ? "live-mc" : "")]);
  }

  /* Now playing: every TV that has something on, with the buttons you'd reach for. They go straight to the TV: no model, nothing spoken. */
  const ICONS = {
    back: "M11 17l-5-5 5-5M18 17l-5-5 5-5", forward: "M13 7l5 5-5 5M6 7l5 5-5 5", pause: "M8 5v14M16 5v14", resume: "M7 4l12 8-12 8z",
    next: "M6 5l9 7-9 7zM18 5v14", quieter: "M4 9v6h4l5 4V5L8 9zM16 12h5", louder: "M4 9v6h4l5 4V5L8 9zM16 12h5M18.5 9.5v5"
  };
  const icon = d => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); svg.append(p); return svg; };
  const npClock = {};  // tv -> {position, at, paused, runtime}, so the bar's progress moves between status updates
  function drawNowBar() {
    const bar = $("nowbar"), playing = (status.tvs || []).filter(t => t.playing);
    document.body.classList.toggle("has-now", playing.length > 0);
    bar.hidden = !playing.length;
    if (!playing.length) return bar.replaceChildren();
    const keep = new Set(playing.map(t => t.key));
    bar.querySelectorAll(".np").forEach(n => { if (!keep.has(n.dataset.tv)) n.remove(); });
    playing.slice(0, 2).forEach(t => {
      const p = t.playing;
      npClock[t.key] = { position: p.position || 0, runtime: p.runtime || 0, paused: !!p.paused, at: Date.now() };
      let row = bar.querySelector(`.np[data-tv="${CSS.escape(t.key)}"]`);
      if (!row || row.dataset.thumb !== String(p.thumb)) {
        const fresh = el("div", "np"); fresh.dataset.tv = t.key; fresh.dataset.thumb = String(p.thumb);
        const art = el("img"); art.alt = ""; if (p.thumb) loadImage(art, p.thumb);
        const txt = el("div", "np-txt");
        txt.append(el("small", "", t.label.toUpperCase()), el("b", ""), el("span", ""));
        const prog = el("div", "np-prog"); prog.append(el("i")); txt.append(prog);
        const btns = el("div", "np-btns");
        [["back", "Back 30 seconds"], ["toggle", "Pause or play"], ["forward", "Forward 30 seconds"], ["next", "Next episode"], ["quieter", "Volume down"], ["louder", "Volume up"]].forEach(([a, name]) => {
          const b = el("button", "np-" + a); b.type = "button"; b.dataset.action = a; b.setAttribute("aria-label", name); b.title = name;
          b.append(icon(ICONS[a === "toggle" ? "pause" : a])); b.addEventListener("click", () => npPress(t.key, a, b)); btns.append(b);
        });
        fresh.append(art, txt, btns);
        if (row) row.replaceWith(fresh); else bar.append(fresh);
        row = fresh;
      }
      row.querySelector("b").textContent = p.title || "";
      row.querySelector(".np-txt span").textContent = [p.subtitle, p.paused ? "Paused" : ""].filter(Boolean).join(" · ");
      row.classList.toggle("paused", !!p.paused);
      const t2 = row.querySelector(".np-toggle"); t2.replaceChildren(icon(ICONS[p.paused ? "resume" : "pause"])); t2.dataset.paused = p.paused ? "1" : "";
      row.querySelector(".np-next").hidden = !/\bE\d/.test(p.subtitle || "");
    });
    tickNowBar();
  }
  function tickNowBar() {
    document.querySelectorAll("#nowbar .np").forEach(row => {
      const c = npClock[row.dataset.tv]; if (!c || !c.runtime) return;
      const at = c.position + (c.paused ? 0 : (Date.now() - c.at) / 1000);
      row.querySelector(".np-prog i").style.width = Math.min(100, at / c.runtime * 100).toFixed(2) + "%";
    });
  }
  setInterval(() => { if (!document.hidden) tickNowBar(); }, 1000);
  async function npPress(tv, action, button) {
    if (action === "toggle") action = button.dataset.paused ? "resume" : "pause";
    button.disabled = true;
    const r = await api("control", { action, tv });
    button.disabled = false;
    if (!r.ok || !r.data.ok) showNotice({ title: (r.data && (r.data.text || r.data.error)) || "That didn't work." });
    else if (action === "pause" || action === "resume") { const c = npClock[tv]; if (c) { c.position += c.paused ? 0 : (Date.now() - c.at) / 1000; c.at = Date.now(); c.paused = action === "pause"; } button.dataset.paused = action === "pause" ? "1" : ""; button.replaceChildren(icon(ICONS[action === "pause" ? "resume" : "pause"])); }
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
  document.querySelectorAll("[data-sheet]").forEach(b => b.addEventListener("click", () => openSheet(b.dataset.sheet, { log: "ACTIVITY", history: "HISTORY", settings: "SETTINGS" }[b.dataset.sheet])));

  function renderSheet() {
    const body = $("sheetBody"); body.replaceChildren();
    const row = (tag, title, sub, cls) => { const r = el("div", "item " + (cls || "")); if (tag) r.append(el("span", "tag", tag)); r.append(el("b", "", title)); if (sub) r.append(el("span", "", sub)); body.append(r); };
    if (sheetKind === "server") {
      const s = status;
      if (s.cpu != null) row("PROCESSOR", num(s.cpu, 1) + "%", s.temp != null ? num(s.temp) + "°C" : "");
      if (s.memory) row("MEMORY", s.memory.used_gb + " of " + s.memory.total_gb + " GiB", num(s.memory.percent) + "% in use");
      if (s.storage) row("SYSTEM DISK", s.storage.free_gb + " GiB free", num(s.storage.percent) + "% used");
      if (s.network) row("NETWORK", "↓ " + num(s.network.down, 1) + "  ↑ " + num(s.network.up, 1) + " KiB/s", s.network.name || "");
      if (s.uptime) row("UPTIME", s.uptime);
      const m = s.minecraft;
      if (m) row("MINECRAFT", m.starting ? "Starting" : m.running ? "Running, " + (m.online || 0) + " of " + (m.max || "?") + " on" : "Stopped", m.running ? (m.players || []).join(", ") || "Nobody online" : "");
      (s.tvs || []).forEach(t => { const p = t.playing; row(t.label.toUpperCase(), p ? p.title : t.online == null ? "Unknown" : t.online ? "Nothing playing" : "Not connected", p ? [p.subtitle, p.paused ? "Paused" : "Playing"].filter(Boolean).join(" · ") : ""); });
      const more = el("button", "act", "FULL SYSTEMS CHECK"); more.type = "button"; more.addEventListener("click", () => { closeSheet(); spokeLast = false; sendCommand("how's the server"); }); body.append(more);
    } else if (sheetKind === "history") {
      if (!history.length) return row("", "Nothing yet", "Your questions and his answers appear here.");
      history.slice().reverse().forEach(h => {
        const r = el("div", "item hist");
        r.append(el("span", "tag", new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (h.view ? " / " + (SCENE_NAMES[h.view.type] || "ANSWER") : "")));
        if (h.said) r.append(el("b", "", h.said));
        if (h.text) r.append(el("span", "", h.text));
        const acts = el("div", "hist-acts");
        if (h.view && SCENES[h.view.type]) { const show = el("button", "act", "SHOW IT"); show.type = "button"; show.addEventListener("click", () => { closeSheet(); $("said").textContent = h.text || ""; renderView(h.view); }); acts.append(show); }
        if (h.said) { const again = el("button", "act", "ASK AGAIN"); again.type = "button"; again.addEventListener("click", () => { closeSheet(); spokeLast = false; sendCommand(h.said); }); acts.append(again); }
        if (acts.children.length) r.append(acts);
        body.append(r);
      });
    } else if (sheetKind === "settings") {
      renderSettings(body);
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
  const SCENES = { answer: "reading", report: "report", weather: "weather", media: "cinema", options: "wall", table: "reading", sections: "reading", suggestions: "reading", error: "alert", web: "web", race: "race", route: "map", flights: "reading" };
  const CALM = window.matchMedia("(prefers-reduced-motion: reduce)");
  const HOME_AFTER_MS = 300000;
  let noticeTimer = null, sceneTimer = null, cineTimer = null, webState = null, walkTimer = null, ambientKey = "", resultAutoDismiss = false, resultDismissTimer = null;

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
    clearInterval(cineTimer); clearInterval(walkTimer); clearTimeout(resultDismissTimer);
    webState = null; resultAutoDismiss = false;
    const stage = $("stage");
    stage.hidden = true; stage.replaceChildren(); stage.className = "stage";
    const core = document.querySelector(".core");
    if (core && stage.parentElement !== core) core.append(stage);
    $("resultScrim").hidden = true;
  }
  function goHome() {
    emptyStage(); setAmbient(); setScene(null);
    clearTimeout(sceneTimer);
  }
  function openStage(title, scene) {
    emptyStage();
    if (document.body.dataset.scene) setScene(null);
    const stage = $("stage");
    stage.hidden = false; stage.className = "stage result-window";
    $("app").append(stage);
    $("resultScrim").hidden = false; $("resultScrim").classList.remove("is-closing");
    stage.append(stageHead(title || String(scene || "JARVIS").toUpperCase()));
    return stage;
  }
  function dismissResultWindow(restoreFocus = true) {
    const stage = $("stage");
    if (!stage || !stage.classList.contains("result-window") || stage.classList.contains("is-closing")) return;
    stage.classList.add("is-closing"); $("resultScrim").classList.add("is-closing");
    setTimeout(() => {
      $("resultScrim").classList.remove("is-closing"); goHome();
      if (restoreFocus) requestAnimationFrame(() => $("command")?.focus({ preventScroll: true }));
    }, 260);
  }
  function scheduleResultDismiss() {
    if (!resultAutoDismiss || speaking || hearing || recording || askedBack || pendingTool) return;
    clearTimeout(resultDismissTimer);
    resultDismissTimer = setTimeout(dismissResultWindow, 2400);
  }
  function keepResultUntilClosed(v, spokenText = "") {
    const details = (JSON.stringify(v || {}) + " " + spokenText).toLowerCase();
    if (/\b(flights?|airfare|boarding pass|cinema|movie times|showtimes|tickets?)\b/.test(details)) return true;
    if (!v) return false;
    if (["flights", "media", "route", "weather", "race", "options", "table", "sections", "suggestions", "report", "error"].includes(v.type)) return true;
    if (v.type === "web") return Boolean(v.facts?.length || v.points?.length || v.hero || v.mode === "walk");
    if (v.type === "answer") return Boolean(v.points?.length);
    return false;
  }
  function appendReadableText(container, text, className) {
    let source = String(text || "").replace(/\r/g, "").trim();
    const context = source.match(/^(.{8,140}?\b(?:answer is unchanged|result is|here(?:'s| is) what i found)\s*:)\s*([\s\S]+)$/i);
    if (context) {
      container.append(el("small", "answer-context", context[1].replace(/:$/, "")));
      source = context[2].trim();
    }
    const lines = source.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const addParagraph = value => container.append(el("p", className || "readable-copy", value));
    const addDetails = value => {
      const clauses = value.split(/(?<!\d),\s+/).map(part => part.trim()).filter(Boolean);
      if (value.length > 105 && clauses.length >= 4) {
        addParagraph(clauses.shift());
        const list = el("ul", "readable-list result-details");
        clauses.forEach(part => list.append(el("li", "", part)));
        container.append(list);
      } else addParagraph(value);
    };
    for (const line of lines) {
      if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) {
        let list = container.lastElementChild;
        if (!list || !list.classList.contains("readable-list")) { list = el("ul", "readable-list"); container.append(list); }
        list.append(el("li", "", line.replace(/^(?:[-*•]|\d+[.)])\s+/, "")));
        continue;
      }
      const sentences = line.length > 145 ? line.split(/(?<=[.!?])\s+/).filter(Boolean) : [line];
      sentences.forEach(addDetails);
    }
  }
  function stageHead(title) {
    const head = el("div", "stage-head");
    head.append(el("h3", "", title));
    const close = el("button", "stage-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close result"); close.addEventListener("click", () => { $("said").textContent = ""; dismissResultWindow(); });
    head.append(close);
    return head;
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !$("sheet").hidden) return;
    const stage = $("stage");
    if (stage?.classList.contains("result-window")) { e.preventDefault(); dismissResultWindow(true); }
    else goHome();
  });

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
    stage.append(hero, hours, lower);
  }

  /* Formula 1: the next race, a countdown, its weekend and the rest of the season */
  function renderRace(v, stage) {
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
    stage.append(hero, lower);
  }

  /* A title on screen: cinema, with its backdrop behind the whole page */
  function renderCinema(v, stage) {
    const [main, ...others] = v.items, clock = s => { const m = Math.floor((s || 0) / 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
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
    } else if (v.type === "weather") renderWeather(v, openStage((v.place || "Local") + " WEATHER", scene));
    else if (v.type === "race") renderRace(v, openStage(v.name || "FORMULA 1", scene));
    else if (v.type === "route") renderRoute(v, openStage(v.title, scene));
    else if (v.type === "flights") renderFlights(v, openStage(v.title, scene));
    else if (v.type === "media") {
      const stage = openStage(v.items?.[0]?.title || "NOW PLAYING", scene);
      renderCinema(v, stage);
    } else if (v.type === "options") renderWall(v, openStage(v.title, scene));
    else if (v.type === "error") {
      const stage = openStage(v.title || "JARVIS NEEDS ATTENTION", scene), box = el("div", "alertbox"), head = el("div", "errhead");
      head.append(el("i", "", "!"), el("h3", "", v.title));
      box.append(head);
      const part = (label, text) => { const d = el("p", "diag"); d.append(el("small", "", label), document.createTextNode(text)); box.append(d); };
      part("WHAT HAPPENED", v.what);
      if (v.why) part("LIKELY CAUSE", v.why);
      if (v.tips && v.tips.length) { const u = el("ul", "tips"); v.tips.forEach(t => u.append(el("li", "", t))); box.append(el("small", "", "WHAT TO TRY"), u); }
      const again = el("button", "act", "TRY AGAIN"); again.type = "button";
      again.addEventListener("click", () => { spokeLast = false; sendCommand("try again"); });
      box.append(again); stage.append(box);
    } else if (v.type === "answer") {  // A clear answer, with optional structured points.
      const stage = openStage(v.title || "JARVIS ANSWER", scene), card = el("div", "answer-card");
      appendReadableText(card, v.say, "readable-copy");
      stage.append(card);
      if (v.points && v.points.length) { const u = el("ul", "points"); v.points.forEach((t, i) => { const li = el("li", "", t); li.style.animationDelay = i * 60 + "ms"; u.append(li); }); stage.append(u); }
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

  /* A journey: every way of going beside Google's map, with live traffic on the roads. The map's key comes from the server and only works on this site. */
  function routePalette() {
    const css = getComputedStyle(document.documentElement);
    const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return { bg: get("--bg", "#07080a"), surface: get("--surface", "#111317"), edge: get("--edge", "#23262c"), text: get("--dim", "#8c929a"), accent: get("--cy", "#8fb8a8"), accent2: get("--cy2", "#b9d3c8") };
  }
  function mapStyleForTheme() {
    const c = routePalette();
    return [
      { elementType: "geometry", stylers: [{ color: c.bg }] }, { elementType: "labels.text.fill", stylers: [{ color: c.text }] }, { elementType: "labels.text.stroke", stylers: [{ color: c.bg }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: c.edge }] }, { featureType: "road.highway", elementType: "geometry", stylers: [{ color: c.surface }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: c.surface }] }, { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: c.edge }] }
    ];
  }
  let mapsReady = null;
  function loadMaps(key) {
    if (!mapsReady) mapsReady = new Promise((done, failed) => {
      window.jarvisMapsLoaded = done;
      window.gm_authFailure = () => { failed(); document.querySelectorAll(".route-map").forEach(noMap); };
      const s = document.createElement("script");
      s.async = true; s.onerror = failed;
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&libraries=geometry&loading=async&callback=jarvisMapsLoaded";
      document.head.append(s);
    });
    return mapsReady;
  }
  function noMap(box) { box.replaceChildren(el("p", "route-nomap", "The map isn't available, but the route is all here.")); }
  function renderRoute(v, stage) {
    const wrap = el("div", "route"), side = el("div", "route-side"), box = el("div", "route-map"), summary = el("div"), lines = [];
    const overview = el("section", "route-summarybar"), pathline = el("div", "route-pathline"), stats = el("div", "route-summary-stats");
    const point = (label, value) => { const node = el("div", "route-point"); node.append(el("small", "", label), el("b", "", value || "—")); return node; };
    const origin = point("FROM", v.from || "Your location"), destination = point("TO", v.to || v.address || "Destination");
    pathline.append(origin, el("span", "route-path-arrow", "→"), destination);
    const stat = label => { const node = el("div", "route-summary-stat"); const value = el("b", "", "—"); node.append(el("small", "", label), value); stats.append(node); return value; };
    const etaValue = stat("TRAVEL TIME"), distanceValue = stat("DISTANCE"), modeValue = stat("MODE");
    overview.append(pathline, stats);
    const go = el("a", "act route-open", "OPEN IN GOOGLE MAPS");
    if (/^https:\/\/www\.google\.com\/maps\//.test(v.link || "")) { go.href = v.link; go.target = "_blank"; go.rel = "noopener"; } else go.hidden = true;
    let chosen = 0;
    const pick = i => {
      chosen = i;
      const r = v.routes[i], facts = el("div", "route-facts"), list = el("ol", "route-steps");
      etaValue.textContent = r.duration || "—"; distanceValue.textContent = r.miles ? r.miles + " mi" : "—"; modeValue.textContent = [v.how, r.via].filter(Boolean).join(" · ") || "Route";
      [["Leave", r.leave], ["Arrive", r.arrive], ["Distance", r.miles + " mi"], r.traffic_text && ["Traffic", "+" + r.traffic_text]].filter(Boolean).forEach(([a, b]) => { const f = el("div"); f.append(el("small", "", a), el("b", "", b)); facts.append(f); });
      const parts = [el("div", "route-time", r.duration), el("p", "route-to", [v.how, r.via].filter(Boolean).join(" · ")), el("p", "route-address", v.address || v.to), facts];
      (r.warnings || []).forEach(w => parts.push(el("p", "route-warn", w)));
      if (i === 0 && v.stops && v.stops.length) {
        const list = el("ol", "route-stops");
        v.stops.forEach(s => { const li = el("li"); li.append(el("b", "", s.name), el("small", "", s.duration + " · " + s.miles + " mi · arrive " + s.arrive)); list.append(li); });
        parts.push(list);
      }
      if (v.routes.length > 1) {
        const alts = el("div", "route-alts");
        v.routes.forEach((o, n) => {
          const b = el("button", "route-alt" + (n === i ? " on" : "")); b.type = "button";
          b.append(el("b", "", o.duration), el("span", "", (o.via || "Route " + (n + 1)) + " · " + o.miles + " mi"));
          b.addEventListener("click", () => { keepScene(); pick(n); });
          alts.append(b);
        });
        parts.push(alts);
      }
      r.steps.forEach(s => { const li = el("li", "is-" + s.kind); li.append(el("span", "", s.text)); if (s.detail) li.append(el("small", "", s.detail)); list.append(li); });
      parts.push(go, list);
      summary.replaceChildren(...parts);
      const colors = routePalette();
      lines.forEach((l, n) => l.setOptions(n === i ? { strokeColor: colors.accent, strokeOpacity: 1, strokeWeight: 6, zIndex: 2 } : { strokeColor: colors.text, strokeOpacity: 0.65, strokeWeight: 4, zIndex: 1 }));
    };
    side.append(summary); wrap.append(overview, box, side); stage.append(wrap);
    pick(0);
    if (!v.map_key) return noMap(box);
    loadMaps(v.map_key).then(() => {
      if (!box.isConnected) return;  // he's moved on: a map is only paid for once it's drawn
      const g = window.google.maps, bounds = new g.LatLngBounds();
      const colors = routePalette();
      const map = new g.Map(box, { styles: mapStyleForTheme(), backgroundColor: colors.bg, disableDefaultUI: true, zoomControl: true, zoomControlOptions: { position: g.ControlPosition.RIGHT_BOTTOM } });
      v.routes.forEach((r, n) => {
        const path = g.geometry.encoding.decodePath(r.polyline);
        path.forEach(p => bounds.extend(p));
        const line = new g.Polyline({ path, map, clickable: true });
        line.addListener("click", () => { keepScene(); pick(n); });
        lines.push(line);
      });
      const path = g.geometry.encoding.decodePath(v.routes[0].polyline);
      [[path[0], colors.accent2], [path[path.length - 1], colors.accent]].forEach(([position, fillColor]) => new g.Marker({ position, map, zIndex: 3, icon: { path: g.SymbolPath.CIRCLE, scale: 7, fillColor, fillOpacity: 1, strokeColor: colors.bg, strokeWeight: 2 } }));
      (v.stops || []).filter(s => s.lat != null).forEach(s => new g.Marker({ position: { lat: s.lat, lng: s.lng }, map, zIndex: 3, title: s.name, icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: colors.accent2, fillOpacity: 1, strokeColor: colors.bg, strokeWeight: 2 } }));
      if (v.mode === "drive") new g.TrafficLayer().setMap(map);
      map.fitBounds(bounds, 48);
      pick(chosen);
    }).catch(() => { if (box.isConnected) noMap(box); });
  }

  /* Flights: the cheapest first, and the way home with it on a return */
  function renderFlights(v, stage) {
    const head = el("div", "fl-head");
    head.append(el("b", "", v.when), el("span", "", v.kind));
    if (v.total) head.append(el("b", "fl-total", v.total + " total"));
    if (v.level) head.append(el("span", "fl-level is-" + v.level, v.level + " price" + (v.usual ? " · usually " + v.usual : "")));
    stage.append(head);
    const row = (o, i) => {
      const c = el("div", "fl"), times = el("div", "fl-times"), who = el("div", "fl-who");
      c.style.animationDelay = i * 50 + "ms";
      c.append(el("b", "fl-price", o.price_text));
      times.append(el("b", "", o.leaves + " to " + o.lands), el("small", "", o.from + " " + o.leaves_day + " · " + o.to + " " + o.lands_day));
      who.append(el("span", "", o.airlines.join(", ")), el("small", "", o.numbers.join(", ")));
      const how = el("div", "fl-how");
      how.append(el("span", "", o.stops_text), el("small", "", o.duration));
      c.append(times, who, how);
      return c;
    };
    v.options.forEach((o, i) => stage.append(row(o, i)));
    if (v.back) {
      stage.append(el("p", "fl-label", v.back_priced ? "COMING BACK" : "COMING BACK, WITH THE CHEAPEST"));
      const home = row(v.back, 0);
      if (!v.back_priced) home.querySelector(".fl-price").textContent = "Included";
      stage.append(home);
    }
    if (/^https:\/\/www\.google\.com\/travel\/flights/.test(v.link || "")) {
      const go = el("a", "act fl-open", "BOOK ON GOOGLE FLIGHTS");
      go.href = v.link; go.target = "_blank"; go.rel = "noopener";
      stage.append(go);
    }
  }

  /* The web: a browser you can watch, beside what Jarvis makes of it */
  let trailOpen = false;
  const WEB_FIELDS = ["trail", "summary", "standing", "standing_text", "hide_page", "query", "status", "url", "site", "frame", "hero", "results", "answer", "facts", "points", "read", "mode", "stage"];
  function webLive(e) {
    const starting = !webState || (e.stage === "searching" && !webState.live);
    if (starting) { goHome(); $("said").textContent = ""; hideToast(); webState = { results: [], points: [], facts: [], answer: "", index: 0, previewOpen: false }; }
    WEB_FIELDS.forEach(k => { if (e[k] !== undefined) webState[k] = e[k]; });
    webState.live = e.stage !== "done";
    if (e.stage === "searching" && turnOpen) acknowledge();
    $("webSearchPeek").hidden = true;
    drawWeb();
    if (e.stage === "done" && webState.mode === "walk" && webState.points.length) startWalk();
  }
  function updateWebSearchPeek() {
    const w = webState, peek = $("webSearchPeek");
    if (!peek) return;
    peek.hidden = false;
    $("webSearchQuery").textContent = w.query || "Finding the information you asked for";
    $("webSearchStatus").textContent = w.status || "Searching the web";
  }
  $("resultScrim").addEventListener("click", dismissResultWindow);
  $("webSearchToggle").addEventListener("click", () => {
    const button = $("webSearchToggle"), detail = $("webSearchDetail"), expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    detail.hidden = !expanded;
  });
  function webCommand(text) { spokeLast = false; sendCommand(text, { keep: true }); }
  function drawWeb() {
    const w = webState, stage = $("stage");
    let root = stage.querySelector(".web");
    if (!root) {
      clearInterval(cineTimer); clearInterval(walkTimer);
      if (document.body.dataset.scene) setScene(null);
      stage.hidden = false; stage.className = "stage result-window";
      $("app").append(stage);
      $("resultScrim").hidden = false;
      stage.replaceChildren(stageHead("WEB ANSWER"));
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
    let progress = stage.querySelector(".web-stage-progress");
    if (!progress) {
      progress = el("div", "web-stage-progress");
      const label = el("span", "web-stage-status"), track = el("span", "web-stage-track"); track.append(el("i"));
      progress.append(el("i", "web-stage-pulse"), label, track);
      stage.querySelector(".stage-head").after(progress);
    }
    progress.classList.toggle("is-complete", !w.live);
    progress.querySelector(".web-stage-status").textContent = w.live ? (w.status || "Searching the web") : "Results ready";
    progress.setAttribute("aria-live", "polite");
    root.dataset.mode = w.live ? "live" : w.mode || "answer";
    root.classList.toggle("busy", w.live);
    root.querySelector(".addr").textContent = w.live && w.status ? w.status : w.url ? w.url.replace(/^https?:\/\/(www\.)?/, "") : "";
    const out = root.querySelector(".out");
    if (/^https?:\/\//.test(w.url || "")) { out.href = w.url; out.hidden = false; } else out.hidden = true;
    const previewAvailable = Boolean(w.frame);
    const previewVisible = w.live ? !w.hide_page : Boolean(w.previewOpen && previewAvailable);
    root.querySelector(".browser").hidden = !previewVisible;
    root.classList.toggle("solo", !previewVisible);
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
      panel.append(el("small", "research-kicker", "JARVIS · LIVE SEARCH"));
      panel.append(el("p", "status", w.status || "Searching the web"));
      if (w.query) panel.append(el("p", "asking", w.query));
      panel.append(track);
      side.append(panel);
    }
    if (!w.live && w.answer) {
      if (w.hero && w.mode !== "walk") side.append(poster(w.hero, ""));
      const answerCard = el("section", "answer-card");
      answerCard.append(el("small", "answer-kicker", "JARVIS · ANSWER"));
      answerCard.append(el("p", "answer", String(w.answer || "").replace(/\s*\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim()));
      appendReadableText(answerCard, String(w.answer || "").replace(/\s*\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim(), "answer");
      side.append(answerCard);
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
    if (!w.live && w.frame) {
      const preview = el("button", "preview-toggle", w.previewOpen ? "HIDE PAGE PREVIEW" : "VIEW PAGE PREVIEW");
      preview.type = "button";
      preview.setAttribute("aria-expanded", String(Boolean(w.previewOpen)));
      preview.addEventListener("click", () => { w.previewOpen = !w.previewOpen; drawWeb(); });
      side.append(preview);
    } else if (!w.live && w.url && /^https?:\/\//.test(w.url)) {
      const open = el("a", "preview-toggle", "OPEN PAGE ↗");
      open.href = w.url; open.target = "_blank"; open.rel = "noopener noreferrer";
      side.append(open);
    }
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
  const PREROLL_BLOCKS = 28, REARM_BLOCKS = 6, QUICK_BLOCKS = 12, NO_SPEECH_BLOCKS = 62, MAX_BLOCKS = 750, MIN_SPEECH_BLOCKS = window.jarvisSpeech.MIN_SPEECH_BLOCKS;
  const WAKE_COOLDOWN_MS = 2500, NOISE_CAP = 0.05;
  const WAKE_WORD = /\b(?:j[ae]rv[iu]s|javis)\b[\s,.!?:;-]*/ig;
  const JUST_STOP = /^(stop|be quiet|quiet|shut up|never mind|nevermind|cancel)\W*$/i;
  const ENOUGH = /^(?:(?:ok|okay|alright|right|yeah|yes)[\s,]*)?(stop|be quiet|quiet|shut up|never mind|nevermind|cancel|ok|okay|that's enough|enough|thanks|thank you|got it|cheers)\W*$/i;
  /* Talking over him (Daniel, 2026-11-06): while he speaks, a voice that's clearly louder than the room for about half a second pauses him and
     records. "Stop" ends his reply, a new request replaces it, and nothing intelligible (the TV, a cough) lets him carry on where he paused.
     Echo cancellation keeps most of his own voice out. The two numbers are guesses until tried in the real room. */
  const BARGE_BLOCKS = 6, BARGE_FLOOR = 0.02, BARGE_RATIOS = { off: 0, low: 12, normal: 8, high: 5 };
  let bargeRatio = BARGE_RATIOS[store.get("jarvis.talkover") || "normal"] ?? 8;
  const WAKE_LEVELS = { low: 0.65, normal: 0.5, high: 0.35 };
  let wakeOn = store.get("jarvis.wake") === "on", mic = null, worker = null, wakeReady = false, recording = null;
  let guardTimer = null, preroll = [], noise = 0.003, wakeLock = null, lastWake = 0, chimeCtx = null, spokeLast = false, loudFor = 0;
  let vadReady = false, workerWake = false;  // Silero loaded in the worker; the worker is listening for the wake word (not only detecting speech)
  /* The device's own speech recognition (Daniel, 2026-11-12): on his iPhone that's Apple's, which already hears him through the noise; in
     Chrome it's Google's. Used when he taps the mic or Jarvis is waiting for an answer, alongside the recording, which goes to the server
     if the device's recogniser fails or hears nothing. After "Hey Jarvis" it isn't used: it would miss the words said straight after. */
  const DeviceSR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const deviceOn = () => Boolean(DeviceSR) && (store.get("jarvis.recogniser") || "jarvis") === "device";
  let vocabTerms = [];
  /* The TV near this device goes quiet while he talks (TV Bot mutes it, and unmutes it after 30 seconds whatever happens) */
  let hushed = "", unhushTimer = null;
  function hushTv() {
    const tv = store.get("jarvis.hush") || "off";
    clearTimeout(unhushTimer);
    if (tv === "off" || hushed) return;
    hushed = tv;
    api("control", { action: "hush", tv }).then(r => console.debug("hush:", r.data && r.data.text)).catch(() => {});
  }
  function unhushTv() {  // a moment later, so a quick answer to his question doesn't make the TV flicker on and off
    clearTimeout(unhushTimer);
    if (!hushed) return;
    unhushTimer = setTimeout(() => { const tv = hushed; hushed = ""; api("control", { action: "unhush", tv }).catch(() => {}); }, 2500);
  }

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

  // iOS asks permission every time the mic is opened, and a Home Screen app has no "always allow". Stopping and starting it is also
  // what you hear, so there the mic stays open once allowed, and is only ever sent anywhere while listening for a command or the wake word.
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function micAlive() { return mic && mic.stream.getAudioTracks().some(t => t.readyState === "live"); }
  async function openMic() {
    if (micAlive()) return true;
    closeMic();
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
    loudFor = speaking && bargeRatio && level > Math.max(noise * bargeRatio, BARGE_FLOOR) ? loudFor + 1 : 0;
    if (loudFor >= BARGE_BLOCKS) { loudFor = 0; preroll.push(block); return bargeIn(); }
    // follows the quiet between words: drops quickly, rises slowly, so speech never counts as background noise
    noise = Math.min(NOISE_CAP, level < noise ? noise * 0.7 + level * 0.3 : noise * 0.998 + level * 0.002);
    preroll.push(block);
    if (preroll.length > PREROLL_BLOCKS) preroll.shift();
    if (worker && wakeReady && !document.hidden) { const copy = block.slice(); worker.postMessage(copy, [copy.buffer]); }
  }
  function newRecording(blocks, extra) {
    recording = { blocks, base: blocks.length, total: 0, judged: 0, speech: 0, silent: 0, afterWake: false, waiting: [], vad: vadReady && wakeReady && Boolean(worker) && store.get("jarvis.vad") !== "off", ...extra };
    setWorkerMode();
    return recording;
  }
  function recordBlock(block, level) {
    setLevel(level / 0.06);
    const r = recording;
    r.blocks.push(block); r.total++;
    if (r.total >= MAX_BLOCKS) return finishRecording();
    if (r.vad && worker && wakeReady) {  // Silero's verdict on this block comes back in a few milliseconds (onVad)
      r.waiting.push(level);
      const copy = block.slice(); worker.postMessage(copy, [copy.buffer]);
      if (r.waiting.length > 10) { r.vad = false; console.debug("speech detection fell behind: going by loudness"); r.waiting.splice(0).forEach(l => judge(r, -1, l)); }
      return;
    }
    judge(r, -1, level);
  }
  function judge(r, p, level) {  // p: Silero's speech probability, or -1 to go by loudness alone
    if (recording !== r) return;
    r.judged++;
    const finished = p < 0 ? window.jarvisSpeech.heard(r, level, noise) : window.jarvisSpeech.heardVad(r, p, level, noise);
    // after the wake word, a short quiet means check what's already been said rather than wait
    if (finished || (r.afterWake && !r.speech && r.judged >= QUICK_BLOCKS) || (!r.speech && r.judged >= NO_SPEECH_BLOCKS)) finishRecording();
  }
  function onVad(p) {
    const r = recording;
    if (!r || !r.vad || !r.waiting.length) return;
    judge(r, p, r.waiting.shift());
  }
  function bargeIn() {
    paused = { token: speechToken };
    player.pause();
    if (window.speechSynthesis && speechSynthesis.speaking) speechSynthesis.pause();
    newRecording(preroll.slice(-(BARGE_BLOCKS + 4)), { speech: BARGE_BLOCKS, barge: true });
    armGuard(); setHearing(true);
  }
  function carryOn() {  // talked over by something that wasn't for him
    const p = paused; paused = null;
    if (!p || p.token !== speechToken) return;
    if (window.speechSynthesis && speechSynthesis.paused) speechSynthesis.resume();
    else if (player.src) player.play().catch(() => nextSpeech());
  }
  function setHearing(on) { hearing = on; $("mic").setAttribute("aria-pressed", String(on)); showMode(); }

  let phrasesWork = true;  // Chrome has the setting for words to expect, but refuses it unless it's recognising on the device itself
  function startDevice(r) {
    if (!deviceOn()) return;
    let rec;
    try { rec = new DeviceSR(); } catch { return; }
    rec.lang = "en-GB"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    try {
      if (phrasesWork && vocabTerms.length && window.SpeechRecognitionPhrase && "phrases" in rec) rec.phrases = vocabTerms.slice(0, 100).map(t => new window.SpeechRecognitionPhrase(t, 5));
    } catch { /* not every browser takes phrases */ }
    const d = r.device = { rec, text: "", final: false, ended: false, failed: "", waiters: [] };
    rec.onresult = e => {
      let text = "";
      for (const res of e.results) text += res[0].transcript;
      d.text = text.trim(); d.final = e.results[e.results.length - 1].isFinal;
      if (recording === r && d.text) $("said").textContent = d.text;
    };
    rec.onerror = e => {
      if (e.error === "phrases-not-supported" && phrasesWork) { phrasesWork = false; d.restart = true; return; }  // once more, without them
      d.failed = e.error || "error"; console.debug("device recogniser failed:", d.failed);
    };
    rec.onend = () => {
      if (d.restart) { if (recording === r) startDevice(r); return; }
      d.ended = true; d.waiters.splice(0).forEach(f => f());
      if (recording === r && d.final && d.text) finishRecording();  // it heard him finish: no need to wait for the quiet
      if (IOS && wakeOn) setTimeout(() => { if (!micAlive() && !recording) { stopCapture(); startCapture(); } }, 400);  // iOS may take the mic for itself
    };
    try { rec.start(); } catch (error) { d.failed = String(error); d.ended = true; }
  }
  async function deviceHeard(r) {  // what the device's recogniser made of it, waiting a moment for its final words; "" to use the server
    const d = r.device;
    if (!d || d.failed) return "";
    if (!d.ended) {
      try { d.rec.stop(); } catch { /* already stopping */ }
      await new Promise(done => { d.waiters.push(done); setTimeout(done, 1500); });
    }
    return d.failed ? "" : d.text;
  }
  function startListening(fromWake) {
    const earlier = fromWake === true ? preroll.slice() : [];
    stopSpeech(); stopListening();
    const r = newRecording(earlier, { afterWake: fromWake === true });
    armGuard(); hushTv();
    if (fromWake !== true) startDevice(r);
    else if (!worker) spawnWorker();
    setHearing(true); $("said").textContent = pendingQuestion;  // the question stays up while it waits for the answer
    openMic().then(ok => { if (!ok) { recording = null; setHearing(false); } else if (!worker) spawnWorker(); });
  }
  function armGuard() {  // in case the mic goes quiet for good and blocks stop arriving
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => { if (recording) finishRecording(); }, (MAX_BLOCKS * 80) + 2000);
  }
  function stopListening() {
    clearTimeout(guardTimer);
    if (recording && recording.device && !recording.device.ended) { try { recording.device.rec.abort(); } catch { /* already gone */ } }
    recording = null; setHearing(false);
    afterRecording();
  }
  function afterRecording() {
    if (worker) worker.postMessage({ type: "reset" });
    setWorkerMode(); unhushTv();
    preroll = [];
    if (!wakeOn && !IOS) closeMic();
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
    if (r) console.debug("recorded", r.total, "blocks,", r.speech, "speech,", r.silent, "quiet, noise", noise.toFixed(4), r.vad ? "(Silero)" : "(loudness)");
    let heard = r ? await deviceHeard(r) : "";
    if (heard) console.debug("device recogniser:", heard);
    else {
      if (!r || (!r.afterWake && r.speech < MIN_SPEECH_BLOCKS)) return r && r.barge ? carryOn() : undefined;  // nothing said, and sending silence makes speech models invent words
      transcribing = true; showMode();
      let res = null, data = {};
      try {
        res = await fetch("/api/jarvis/stt", { method: "POST", headers: { "x-jarvis-session": session, "content-type": "audio/wav" }, body: wavFrom(window.jarvisSpeech.kept(r)) });
        data = await res.json().catch(() => ({}));
      } catch { /* shown below */ }
      transcribing = false; showMode();
      if (res && res.status === 401) return signedOut(data.code);
      if (!res || !res.ok) { if (r.barge) return carryOn(); $("said").textContent = data.error || "I couldn't reach speech recognition just now."; return; }
      heard = String(data.text || "").trim();
    }
    if (r.afterWake) {
      // Whisper is the second opinion: no "Jarvis" in what it heard means the wake word fired on something else
      const words = [...heard.matchAll(WAKE_WORD)], last = words[words.length - 1];
      if (!last) { console.debug("false wake:", heard); return; }
      heard = heard.slice(last.index + last[0].length).trim();
      if (!heard) {  // said only "Hey Jarvis", so now wait for the command, keeping anything said during that check
        if (recording) return;
        startDevice(newRecording(preroll.slice(-REARM_BLOCKS)));
        armGuard(); setHearing(true); hushTv();
        return;
      }
    } else {
      heard = heard.replace(/^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:j[ae]rv[iu]s|javis)\b[\s,.!?:;-]*/i, "").trim();
    }
    if (r.barge) {
      const p = paused; paused = null;
      const meant = heard.replace(/[^a-z]/gi, "").length >= 2;
      if (!meant) { paused = p; return carryOn(); }
      stopSpeech();
      if (ENOUGH.test(heard)) { $("said").textContent = ""; return; }
    }
    if (!heard) { $("said").textContent = pendingQuestion; return; }
    $("said").textContent = heard;
    if (!pendingTool && JUST_STOP.test(heard)) { $("said").textContent = ""; return; }  // a bare "stop" only silences Jarvis
    spokeLast = true;
    sendCommand(heard);
  }
  let micPress = null;
  $("mic").addEventListener("pointerdown", () => {
    followUps = 0;
    if (hearing) { micPress = null; return; }
    micPress = { at: Date.now() };
    startListening();
  });
  $("mic").addEventListener("click", () => {
    if (micPress) { micPress = null; return; }  // its press already started (or finished) it
    if (!hearing) return startListening();
    if (recording && recording.speech >= MIN_SPEECH_BLOCKS) finishRecording(); else stopListening();
  });

  /* "Hey Jarvis" */
  function stopCapture() {
    recording = null; if (hearing) setHearing(false);
    if (worker) worker.terminate();
    worker = null; wakeReady = false; vadReady = false; workerWake = false;
    closeMic(); releaseScreen();
  }
  function spawnWorker() {
    if (worker) return;
    const failed = text => {
      if (workerWake) { stopCapture(); wakeStatus("WAKE WORD FAILED / USE THE MIC BUTTON", true); }
      else { if (worker) worker.terminate(); worker = null; wakeReady = false; vadReady = false; }
      if (text) console.warn("listening worker:", text);
    };
    worker = new Worker("wake-worker.js?v=3");
    worker.onerror = () => failed();
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "vad") onVad(m.p);
      else if (m.type === "ready") {
        wakeReady = true; vadReady = Boolean(m.vad);
        worker.postMessage({ type: "threshold", value: WAKE_LEVELS[store.get("jarvis.wakesens") || "normal"] || 0.5 });
        setWorkerMode();
        if (workerWake) wakeListening();
      } else if (m.type === "failed") failed(m.error);
      else if (m.type === "stats") console.debug("wake stats", m.ms.toFixed(1) + " ms per block", "peak " + m.peak.toFixed(3));
      else if (m.type === "wake") onWake(m.score);
    };
  }
  function wakeListening() {
    const running = mic && mic.ctx.state === "running";
    wakeStatus(running ? 'LISTENING FOR "HEY JARVIS"' : "TAP THE PAGE TO START LISTENING", !running);
    holdScreen();
  }
  function setWorkerMode() {  // the wake word while waiting; speech detection while recording a command
    if (worker && wakeReady) worker.postMessage({ type: "mode", wake: workerWake && !recording, vad: Boolean(recording) && vadReady });
  }
  async function startCapture() {
    if ((worker && workerWake) || !wakeOn) return;
    wakeStatus("STARTING WAKE WORD");
    if (!await openMic() || !wakeOn) return wakeOn ? wakeStatus("WAKE WORD FAILED / USE THE MIC BUTTON", true) : undefined;
    workerWake = true;
    if (worker) { setWorkerMode(); if (wakeReady) wakeListening(); return; }  // already running for speech detection
    spawnWorker();
  }
  function onWake(score) {
    const now = Date.now();
    followUps = 0;
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
    else if (wakeOn && !(worker && workerWake) && !$("app").hidden) startCapture();
  });

  $("commandForm").addEventListener("submit", e => {
    e.preventDefault();
    const box = $("command"), text = box.value.trim();
    if (!text) return;
    box.value = "";
    spokeLast = false; followUps = 0;
    sendCommand(text);
  });
  $("stopAll").addEventListener("click", () => { spokeLast = false; sendCommand("stop everything", { keep: true, silent: true }); });
  /* The model button: Haiku as usual; Sonnet or Opus for a harder question. It stays as picked until he changes it, or for
     10 minutes after his last request, then goes back to Haiku, so the dear one is never left on by accident. */
  const MODELS = ["haiku", "sonnet", "opus"], MODEL_KEEP_MS = 600000;
  const MODEL_HINT = { haiku: "Haiku: quick, under 1p a request", sonnet: "Sonnet: cleverer, about 5p a request", opus: "Opus: cleverest, about 10p a request" };
  function defaultModel() { const m = store.get("jarvis.defaultModel") || "haiku"; return MODELS.includes(m) ? m : "haiku"; }
  function pickedModel() {
    const fallback = defaultModel(), m = store.get("jarvis.model") || fallback, at = Number(store.get("jarvis.modelAt") || 0);
    if (m !== fallback && Date.now() - at > MODEL_KEEP_MS) { store.set("jarvis.model", fallback); showModel(fallback); return fallback; }
    return MODELS.includes(m) ? m : fallback;
  }
  function showModel(m) {
    const b = $("modelPick");
    b.dataset.model = m; b.textContent = m.toUpperCase(); b.title = MODEL_HINT[m];
    b.setAttribute("aria-label", "Claude model for your requests: " + MODEL_HINT[m] + ". Tap to change");
  }
  $("modelPick").addEventListener("click", () => {
    const next = MODELS[(MODELS.indexOf(pickedModel()) + 1) % MODELS.length];
    store.set("jarvis.model", next); store.set("jarvis.modelAt", String(Date.now())); showModel(next);
    $("said").textContent = MODEL_HINT[next];
  });
  showModel(pickedModel());
  async function sendCommand(text, extra) {
    const { keep, ...more } = extra || {};
    if (!more.silent) lastSaid = text;
    stopListening(); stopSpeech(); openTurn(); hideToast();
    if (!spokeLast) unlockAudio();  // typed: Enter is a gesture too, but not a button click
    clearInterval(walkTimer);
    // what's on screen stays, dimmed, until there's something to replace it, so the page never jumps home and back
    if (!keep) $("stage").classList.add("stale");
    const model = pickedModel();
    if (model !== "haiku") store.set("jarvis.modelAt", String(Date.now()));  // in use: the 10 minutes start again
    const r = await api("chat", { text, scene: document.body.dataset.scene || "", narrow: window.innerWidth < 700, ...(model !== "haiku" ? { model } : {}), ...more });
    closeTurn();
    if (r.ok && r.data.stopped) return;  // the stop's own reply says so
    if (r.ok && r.data.silent) { if (!live) { showReply(r.data); setPending(null); } return; }  // the stop button: everything stops, and he doesn't answer
    if (r.ok && !live) showReply(r.data);
    if (r.ok) speakReply(r.data);
    if (!r.ok) $("stage").classList.remove("stale");
    if (!r.ok && r.status !== 401) $("said").textContent = r.data.error || "That didn't go through.";
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
  let hiddenAt = 0;
  const FRESH_AFTER_MS = 60000;  // away longer than this, and he comes back to the dashboard, not to the last question
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("paused", document.hidden);
    if (!document.hidden && hiddenAt && Date.now() - hiddenAt > FRESH_AFTER_MS && !recording && !speaking) {
      goHome(); hideToast(); $("said").textContent = "";
    }
    hiddenAt = document.hidden ? Date.now() : 0;
    if (document.hidden) {
      if (abort) { abort.abort(); abort = null; }
      if (IOS) { recording = null; if (hearing) setHearing(false); releaseScreen(); }  // iOS pauses the mic by itself in the background
      else stopCapture();
    } else if (session && !$("app").hidden) {
      connect();
      fetchToday();
      if (IOS && mic && !micAlive()) stopCapture();  // iOS ended it after all, so it has to ask again
      if (IOS && mic) { mic.ctx.resume().catch(() => {}); if (worker) holdScreen(); else startCapture(); }
      else startCapture();
    }
  });

  /* Your day (Daniel, 2026-11-06): the home screen's cards, from /api/today. The server keeps each one a while, so this is cheap. */
  const TODAY_EVERY_MS = 60000;
  let todayAt = 0;
  const li = (title, sub, cls) => { const n = el("li", cls || ""); n.append(el("b", "", title)); if (sub) n.append(el("span", "", sub)); return n; };
  function fill(id, items) { $(id).replaceChildren(...items); }
  function card(id, on) { $(id).hidden = !on; }
  async function fetchToday(force) {
    if (!force && (Date.now() - todayAt < TODAY_EVERY_MS - 1000 || document.hidden || $("app").hidden)) return;
    todayAt = Date.now();
    const r = await api("today");
    if (r.ok) drawToday(r.data);
  }
  setInterval(() => fetchToday(), TODAY_EVERY_MS);
  const cap = t => t ? t[0].toUpperCase() + t.slice(1) : "";
  function drawToday(d) {
    const w = d.weather;
    card("cardWeather", !!w);
    if (w) {
      $("wxPlace").textContent = (w.place || "").toUpperCase();
      $("wxTemp").textContent = w.temp + "°";
      $("wxSky").textContent = cap(w.sky) + " · feels " + w.feels + "°";
      $("wxMore").textContent = `High ${w.high}° · low ${w.low}° · rain ${w.rain}%` + (w.sunset ? ` · sunset ${w.sunset}` : "");
    }
    const ev = d.calendar && d.calendar.events;
    card("cardCalendar", !!d.calendar);
    if (d.calendar) fill("calList", ev.length ? ev.map(e => li(e.title, cap(e.day) + " · " + e.time + (e.location ? " · " + e.location : ""))) : [li("Nothing in the diary", "Today or tomorrow")]);
    const teams = d.sport && d.sport.teams;
    card("cardSport", !!(teams && teams.length));
    if (teams) {
      $("cardSport").dataset.ask = "how did " + teams[0].team + " get on";
      fill("sportList", teams.flatMap(t => [li(t.team, t.live ? "LIVE · " + t.latest : t.latest || "", t.live ? "live" : ""), ...(t.next ? [li("Next", t.next, "sub")] : [])]));
    }
    const f = d.f1;
    card("cardF1", !!f);
    if (f) fill("f1List", [li(f.race || "Next race", (f.next ? f.next.name + " · " + f.next.day + " " + f.next.time : "Weekend under way") + (f.drivers.length ? " · following " + f.drivers.join(", ") : ""))]);
    const news = d.news && d.news.headlines;
    card("cardNews", !!(news && news.length));
    if (news) fill("newsList", news.slice(0, window.innerWidth < 700 ? 4 : 3).map(h => li(h)));
    const dl = d.downloads && d.downloads.items;
    card("cardHome", !!d.downloads);
    if (dl) fill("homeList", dl.length ? dl.map(x => li(x.title, [x.percent != null ? Math.round(x.percent) + "%" : "", x.left ? x.left + " left" : "", x.stage || ""].filter(Boolean).join(" · "))) : [li("Nothing downloading")]);
    const drive = d.drive;
    card("cardDrive", !!drive);
    if (drive) {
      $("driveFree").textContent = drive.free + " free";
      $("driveOf").textContent = "of " + drive.size + " · " + drive.percent + "% used";
      $("driveBar").style.width = drive.percent + "%";
      $("cardDrive").classList.toggle("warn", drive.percent > 80);
      $("driveNote").textContent = drive.full_in_days != null ? (drive.full_in_days > 730 ? "Filling slowly: years of space left" : "Full in about " + (drive.full_in_days > 60 ? Math.round(drive.full_in_days / 30) + " months" : drive.full_in_days + " days") + " at " + drive.per_day + " GB a day")
        : drive.per_day != null ? "Not filling up lately" : "Working out how fast it fills: give it a couple of days";
    }
  }
  document.querySelectorAll(".card[data-ask]").forEach(c => c.addEventListener("click", () => { spokeLast = false; sendCommand(c.dataset.ask); }));

  /* Settings are grouped by scope: personal and visual preferences stay on this device; home and alert settings sync through Jarvis. */
  function choice(labelText, key, options, current, onChange) {
    const wrap = el("label", "set"); wrap.append(el("span", "", labelText));
    const sel = el("select"); options.forEach(([v, t]) => { const o = el("option", "", t); o.value = v; sel.append(o); });
    sel.value = current; sel.addEventListener("change", () => onChange(sel.value)); wrap.append(sel); return wrap;
  }
  function toggle(labelText, on, onChange) {
    const wrap = el("label", "set"); wrap.append(el("span", "", labelText));
    const box = el("input"); box.type = "checkbox"; box.checked = on; box.className = "switch"; box.addEventListener("change", () => onChange(box.checked));
    wrap.append(box); return wrap;
  }
  function textInput(labelText, value, placeholder, onChange) {
    const wrap = el("label", "set"); wrap.append(el("span", "", labelText));
    const input = el("input"); input.type = "text"; input.value = value || ""; input.placeholder = placeholder || "";
    input.addEventListener("change", () => onChange(input.value.trim())); wrap.append(input); return wrap;
  }
  function section(title, open = false) {
    const details = el("details", "settings-section"); details.open = open;
    const summary = el("summary", "", title); details.append(summary);
    const content = el("div", "settings-content"); details.append(content); return { details, content };
  }
  const THEMES = {
    graphite: { label: "Graphite", vars: { "--bg":"#07080A", "--bg2":"#111317", "--cy":"#8FB8A8", "--cy2":"#B9D3C8", "--dim":"#8C929A", "--line":"#23262C", "--amber":"#D6A35C", "--green":"#7CC4A0", "--red":"#E07A6A", "--text":"#E8E9EB", "--surface":"rgba(17,19,23,.9)", "--surface2":"#15181D", "--edge":"#1E2126", "--edge2":"#2A2E35" } },
    ocean: { label: "Deep ocean", vars: { "--bg":"#061018", "--bg2":"#0B1D28", "--cy":"#43C8E2", "--cy2":"#89E4F3", "--dim":"#86A3AE", "--line":"#173744", "--amber":"#E7AD62", "--green":"#63D5A5", "--red":"#F07979", "--text":"#E5F2F5", "--surface":"rgba(11,29,40,.92)", "--surface2":"#10232D", "--edge":"#193542", "--edge2":"#28505E" } },
    violet: { label: "Violet night", vars: { "--bg":"#0B0913", "--bg2":"#171222", "--cy":"#B69AFF", "--cy2":"#D0BEFF", "--dim":"#9A91AB", "--line":"#302742", "--amber":"#E6AE72", "--green":"#71D2A5", "--red":"#F07A8A", "--text":"#F0EBF8", "--surface":"rgba(23,18,34,.92)", "--surface2":"#1B1727", "--edge":"#2A2438", "--edge2":"#403653" } },
    ember: { label: "Ember", vars: { "--bg":"#100B08", "--bg2":"#1D1410", "--cy":"#E8A66B", "--cy2":"#F3C69C", "--dim":"#A5978D", "--line":"#3B2A20", "--amber":"#F0B65E", "--green":"#82C69D", "--red":"#EB7770", "--text":"#F4ECE6", "--surface":"rgba(29,20,16,.93)", "--surface2":"#241913", "--edge":"#3A291F", "--edge2":"#523A2B" } }
  };
  function applyTheme(id) {
    const theme = THEMES[id] || THEMES.graphite;
    document.documentElement.dataset.theme = id in THEMES ? id : "graphite";
    Object.entries(theme.vars).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    const accent = store.get("jarvis.accent");
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) { document.documentElement.style.setProperty("--cy", accent); document.documentElement.style.setProperty("--cy2", accent); }
  }
  function setTextSize(v) { store.set("jarvis.text", v); document.body.classList.toggle("bigtext", v === "large"); }
  function setReducedMotion(on) { store.set("jarvis.reduceMotion", on ? "on" : "off"); document.body.classList.toggle("reduce-motion", on); }
  applyTheme(store.get("jarvis.theme") || "graphite");
  setTextSize(store.get("jarvis.text") || "normal");
  setReducedMotion(store.get("jarvis.reduceMotion") === "on");
  async function renderSettings(body) {
    const personal = section("PERSONAL PREFERENCES", true);
    const preferredName = textInput("How Jarvis addresses you", store.get("jarvis.name") || "", "Use your account default", value => {
      if (value) { store.set("jarvis.name", value); address = value; }
      else { store.del("jarvis.name"); address = serverAddress; }
      ackClips.forEach(url => URL.revokeObjectURL(url)); ackClips = []; ackNext = 0; ackLoading = false; loadAcks();
    });
    personal.content.append(preferredName);
    personal.content.append(choice("Default response model", "defaultModel", MODELS.map(m => [m, cap(m)]), defaultModel(), value => {
      store.set("jarvis.defaultModel", value); store.set("jarvis.model", value); store.set("jarvis.modelAt", String(Date.now())); showModel(value);
    }));
    personal.content.append(el("p", "hint", "The model button beside the message box can temporarily switch models; it returns to your default after 10 minutes."));
    body.append(personal.details);

    const voice = section("VOICE & LISTENING");
    voice.content.append(toggle("Jarvis's voice", voiceOn, v => setVoice(v)));
    voice.content.append(toggle('Listen for "Hey Jarvis"', wakeOn, v => setWake(v)));
    voice.content.append(choice("Wake word sensitivity", "wakesens", [["low", "Less sensitive (fewer false starts)"], ["normal", "Normal"], ["high", "High (hears you further away)"]], store.get("jarvis.wakesens") || "normal",
      v => { store.set("jarvis.wakesens", v); if (worker) worker.postMessage({ type: "threshold", value: WAKE_LEVELS[v] }); }));
    voice.content.append(choice("Talking over Jarvis", "talkover", [["off", "Off"], ["low", "Only when you're loud"], ["normal", "Normal"], ["high", "Stops easily"]], store.get("jarvis.talkover") || "normal",
      v => { store.set("jarvis.talkover", v); bargeRatio = BARGE_RATIOS[v] ?? 8; }));
    if (DeviceSR) voice.content.append(choice("Speech recognition", "recogniser", [["jarvis", "Jarvis's server (recommended)"], ["device", IOS ? "This iPhone's own (Apple)" : "This browser's own"]],
      store.get("jarvis.recogniser") || "jarvis", v => store.set("jarvis.recogniser", v)));
    voice.content.append(choice("Quieten a TV while listening", "hush", [["off", "Off"], ["living room", "Living Room TV (mutes it, then back)"]],
      store.get("jarvis.hush") || "off", v => store.set("jarvis.hush", v)));
    body.append(voice.details);

    const appearance = section("APPEARANCE");
    appearance.content.append(choice("Colour scheme", "theme", Object.entries(THEMES).map(([key, value]) => [key, value.label]), store.get("jarvis.theme") || "graphite", value => {
      store.set("jarvis.theme", value); applyTheme(value); accent.value = store.get("jarvis.accent") || THEMES[value].vars["--cy"];
    }));
    const accentLabel = el("label", "set"); accentLabel.append(el("span", "", "Custom accent colour"));
    const accent = el("input"); accent.type = "color"; accent.className = "color-input"; accent.value = store.get("jarvis.accent") || (THEMES[store.get("jarvis.theme") || "graphite"] || THEMES.graphite).vars["--cy"];
    accent.addEventListener("input", () => { store.set("jarvis.accent", accent.value); document.documentElement.style.setProperty("--cy", accent.value); document.documentElement.style.setProperty("--cy2", accent.value); }); accentLabel.append(accent); appearance.content.append(accentLabel);
    const resetAccent = el("button", "act", "USE SCHEME ACCENT"); resetAccent.type = "button"; resetAccent.addEventListener("click", () => { store.del("jarvis.accent"); applyTheme(store.get("jarvis.theme") || "graphite"); accent.value = THEMES[store.get("jarvis.theme") || "graphite"].vars["--cy"]; }); appearance.content.append(resetAccent);
    appearance.content.append(choice("Text size", "text", [["normal", "Normal"], ["large", "Large"]], store.get("jarvis.text") || "normal", setTextSize));
    appearance.content.append(toggle("Reduce animations", store.get("jarvis.reduceMotion") === "on", setReducedMotion));
    body.append(appearance.details);

    const home = section("HOME & ALERTS");
    const wait = el("p", "hint", "Loading shared settings…"); home.content.append(wait); body.append(home.details);
    const r = await api("settings");
    wait.remove();
    if (sheetKind !== "settings") return;
    if (!r.ok) return home.content.append(el("p", "hint", r.data.error || "Jarvis isn't reachable."));
    const s = r.data, [qFrom, qTo] = (s.quiet || "23:00-08:00").split("-");
    const tv = choice("Default TV", "tv", Object.entries(s.tvs || {}), s.default_tv, () => {});
    const from = el("input"); from.type = "time"; from.value = qFrom;
    const to = el("input"); to.type = "time"; to.value = qTo;
    const quiet = el("label", "set"); quiet.append(el("span", "", "Quiet hours for phone alerts")); const qrow = el("div", "set-row"); qrow.append(from, el("span", "", "to"), to); quiet.append(qrow);
    const teams = el("input"); teams.value = (s.follow_teams || []).join(", "); teams.placeholder = "e.g. Arsenal, Millwall";
    const drivers = el("input"); drivers.value = (s.follow_drivers || []).join(", "); drivers.placeholder = "e.g. Lando Norris";
    const tLabel = el("label", "set"); tLabel.append(el("span", "", "Football teams you follow"), teams);
    const dLabel = el("label", "set"); dLabel.append(el("span", "", "F1 drivers you follow"), drivers);
    const save = el("button", "act", "SAVE SHARED SETTINGS"); save.type = "button";
    const note = el("p", "hint", "These settings are shared with your other devices.");
    save.addEventListener("click", async () => {
      save.disabled = true;
      const list = v => v.split(",").map(x => x.trim()).filter(Boolean);
      const out = await api("settings", { default_tv: tv.querySelector("select").value, quiet: from.value + "-" + to.value, follow_teams: list(teams.value), follow_drivers: list(drivers.value) });
      save.disabled = false;
      note.textContent = out.ok ? "Saved." : out.data.error || "That didn't save.";
      if (out.ok) fetchToday(true);
    });
    home.content.append(tv, quiet, tLabel, dLabel, save, note);
  }

  /* start: does Homebase know us, then does Jarvis */
  (async () => {
    let signedIn = false;
    try { signedIn = (await (await fetch("/api/downloads/session")).json()).authenticated; } catch { /* treated as signed out */ }
    if (!signedIn) return showGate("login", "Sign in with your Homebase account.");
    if (!session) return showGate("pin", "Enter your PIN.");
    boot();
  })();
})();

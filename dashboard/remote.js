/* Homebase Remote: now playing, playback, voice/typed commands and the navigation pad.
   Everything goes to /api/tv/..., which forwards to tvbot through the private bridge. */
(() => {
  const { $, el, icon, store, toast, api, rail, errorText, gate, TVS, TV_SUFFIX } = Hub;
  let tv = store.get("jr_tv", "living room"); if (!TVS[tv]) tv = "living room";
  let status = null, statusAt = 0, dragging = false, dragPos = 0, poll = null;

  const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const img = (id, h, type = "Primary") => id ? `url("/api/tv/img/${encodeURIComponent(id)}?h=${h}&type=${type}")` : "";

  // ---------- TV picker ----------
  function setTv(key) {
    tv = key; store.set("jr_tv", key);
    document.querySelectorAll("#tvSeg button").forEach(b => b.classList.toggle("on", b.dataset.tv === key));
    $("npTvName").textContent = TVS[key].toUpperCase(); $("quickHint").textContent = "Tap to play on " + TVS[key];
    status = null; render(); refresh();
  }
  document.querySelectorAll("#tvSeg button").forEach(b => b.onclick = () => setTv(b.dataset.tv));

  // ---------- commands ----------
  async function cmd(text, onTv = tv) {
    const named = /\b(on|in) (the )?(mum|mom|mummy|living ?room|daniel|my room|bedroom)/i.test(text);
    const result = await api("/api/tv/cmd", { method: "POST", body: { text: text + (named ? "" : TV_SUFFIX[onTv] || "") } });
    toast(result.ok ? (result.data.text || "Done.") : errorText(result, "The TV didn't answer."));
    setTimeout(refresh, 700); setTimeout(refresh, 2600);
  }
  document.querySelectorAll("[data-cmd]").forEach(b => b.onclick = () => cmd(b.dataset.cmd));
  $("playPause").onclick = () => {
    const p = status?.playing; if (!p) { toast("Nothing's playing on " + TVS[tv] + "."); return; }
    p.paused = !p.paused; p.position += (Date.now() - statusAt) / 1000; statusAt = Date.now(); render();
    cmd(p.paused ? "pause" : "resume");
  };

  // ---------- now playing ----------
  async function refresh() {
    const result = await api("/api/tv/api/status?tv=" + encodeURIComponent(tv));
    if (!result.ok) { $("npStateText").textContent = result.status === 401 ? "Signed out" : "Can't reach the TVs"; $("tvConnectionLabel").textContent = errorText(result, "The remote is unavailable."); return; }
    status = result.data; statusAt = Date.now(); $("tvConnectionLabel").textContent = "Connected to tvbot"; dot(tv, status); render();
  }
  // a dot on each TV button: green playing, amber paused, grey on, faint off
  function dot(key, s) {
    const i = document.querySelector(`#tvSeg button[data-tv="${key}"] i`); if (!i) return;
    i.className = s?.playing ? (s.playing.paused ? "paused" : "playing") : s?.online ? "online" : "";
  }
  async function refreshOthers() {
    for (const key of Object.keys(TVS)) {
      if (key === tv) continue;
      const r = await api("/api/tv/api/status?tv=" + encodeURIComponent(key)); if (r.ok) dot(key, r.data);
    }
  }
  let lastThumb = null;
  function render() {
    const p = status?.playing, state = $("npState");
    $("np").classList.toggle("live", Boolean(p)); $("npMore").hidden = !p;
    if (!status) { state.className = "state"; $("npStateText").textContent = "Connecting…"; return; }
    if (!p) {
      state.className = "state"; $("npStateText").textContent = status.online ? "Jellyfin open" : "Idle";
      $("npTitle").textContent = "Nothing playing"; $("npSub").textContent = "Pick something in the Media hub, or say what to play below.";
      $("npThumb").style.backgroundImage = ""; $("npThumb").replaceChildren(icon("tv")); $("npBg").style.backgroundImage = "";
      $("npBar").style.width = "0"; $("npPos").textContent = ""; $("npLeft").textContent = ""; lastThumb = null; setPP(false); return;
    }
    state.className = "state " + (p.paused ? "paused" : "playing"); $("npStateText").textContent = p.paused ? "Paused" : "Now playing";
    $("npTitle").textContent = p.title; $("npSub").textContent = p.subtitle;
    if (lastThumb !== p.thumb) {
      $("npThumb").replaceChildren(); $("npThumb").style.backgroundImage = img(p.thumb, 360, "Primary");
      $("npBg").style.backgroundImage = img(p.backdrop, 480, "Backdrop"); lastThumb = p.thumb;
      $("npOverview").textContent = p.overview || ""; $("npOverview").classList.remove("open");
    }
    setPP(!p.paused); tick();
  }
  function showPos(pos, p) {
    const pct = p.runtime ? (100 * pos / p.runtime).toFixed(2) + "%" : "0";
    $("npBar").style.width = pct; $("npKnob").style.left = pct;
    $("npPos").textContent = fmt(pos); $("npLeft").textContent = p.runtime ? "-" + fmt(p.runtime - pos) : "";
  }
  function tick() {
    const p = status?.playing; if (!p || dragging) return;
    const pos = Math.min(p.runtime || Infinity, p.position + (p.paused ? 0 : (Date.now() - statusAt) / 1000));
    showPos(pos, p);
    const bits = [];
    if (p.runtime) bits.push("Ends " + new Date(Date.now() + (p.runtime - pos) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    if (p.season_left != null) bits.push(p.season_left ? `${p.season_left} more episode${p.season_left > 1 ? "s" : ""} this season` : "Last episode of the season");
    $("npEnds").textContent = bits.join(" · ");
  }
  function setPP(playing) { $("ppIcon").innerHTML = playing ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>'; }
  $("npOverview").onclick = () => $("npOverview").classList.toggle("open");

  // drag the bar to jump anywhere
  function dragAt(e) { const p = status.playing, r = $("seek").querySelector(".bar").getBoundingClientRect(); dragPos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * p.runtime; showPos(dragPos, p); }
  $("seek").addEventListener("pointerdown", e => { const p = status?.playing; if (!p?.runtime) return; dragging = true; $("seek").setPointerCapture(e.pointerId); dragAt(e); });
  $("seek").addEventListener("pointermove", e => { if (dragging) dragAt(e); });
  $("seek").addEventListener("pointerup", async () => {
    if (!dragging) return; dragging = false;
    const p = status.playing; p.position = dragPos; statusAt = Date.now();
    const result = await api("/api/tv/api/seek", { method: "POST", body: { tv, position: dragPos } });
    toast(result.ok ? result.data.reply : errorText(result, "Couldn't jump there.")); setTimeout(refresh, 1500);
  });
  $("seek").addEventListener("pointercancel", () => { dragging = false; tick(); });

  // ---------- say / type a command ----------
  function sendSay() { const q = $("say").value.trim(); if (!q) return; cmd(q); $("say").value = ""; $("say").blur(); $("sayHint").textContent = ""; }
  $("sayForm").addEventListener("submit", e => { e.preventDefault(); sendSay(); });
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, dictTimer = null, dictating = false;
  $("mic").onclick = () => {
    if (rec) { rec.stop(); return; }
    if (Speech && window.isSecureContext) {
      rec = new Speech(); rec.lang = "en-GB"; rec.interimResults = true;
      $("mic").classList.add("on"); $("say").value = ""; $("sayHint").textContent = "Listening…";
      rec.onresult = e => { $("say").value = Array.from(e.results).map(r => r[0].transcript).join(" "); };
      rec.onerror = e => { $("sayHint").textContent = e.error === "not-allowed" ? "Microphone access is blocked for this page." : ""; };
      rec.onend = () => { rec = null; $("mic").classList.remove("on"); if ($("say").value.trim()) sendSay(); else $("sayHint").textContent = ""; };
      rec.start(); return;
    }
    dictating = true; $("mic").classList.add("on"); $("say").value = "";
    $("sayHint").textContent = "Tap the 🎤 on your keyboard and say the command. It sends when you stop."; $("say").focus();
  };
  $("say").addEventListener("input", () => {
    if (!dictating) return; clearTimeout(dictTimer);
    dictTimer = setTimeout(() => { if ($("say").value.trim()) { dictating = false; $("mic").classList.remove("on"); sendSay(); } }, 1600);
  });

  // ---------- pad ----------
  let queue = Promise.resolve(), waiting = 0;
  function press(key, droppable = false) {
    if (droppable && waiting > 3) return;  // a fast swipe outrunning the TV: skip rather than pile up
    navigator.vibrate?.(8); waiting++;
    queue = queue.then(() => api("/api/tv/api/key", { method: "POST", body: { tv, key } }))
      .then(r => { if (!r.ok || (r.data.reply && r.data.reply !== "ok")) toast(errorText(r, "The TV didn't answer.")); })
      .finally(() => waiting--);
  }
  function setMode(mode) {
    store.set("jr_padmode", mode);
    document.querySelectorAll("#padMode button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
    $("touchpad").hidden = mode !== "swipe"; $("dpad").hidden = mode === "swipe";
  }
  document.querySelectorAll("#padMode button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  setMode(store.get("jr_padmode", "buttons"));
  const REPEAT = new Set(["up", "down", "left", "right", "voldown", "volup"]);
  document.querySelectorAll("[data-key]").forEach(b => {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; b.classList.remove("hit"); };
    b.addEventListener("pointerdown", e => {
      e.preventDefault(); b.classList.add("hit"); press(b.dataset.key);
      if (REPEAT.has(b.dataset.key)) timer = setTimeout(() => { timer = setInterval(() => press(b.dataset.key), 220); }, 450);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => b.addEventListener(ev, stop));
    b.addEventListener("contextmenu", e => e.preventDefault());
  });
  // touchpad: every STEP px of drag is one move in its main direction; a tap is OK
  const STEP = 55; let touch = null;
  const dir = (dx, dy) => Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  const moveDot = e => { const r = $("touchpad").getBoundingClientRect(); $("dot").style.left = (e.clientX - r.left) + "px"; $("dot").style.top = (e.clientY - r.top) + "px"; };
  $("touchpad").addEventListener("pointerdown", e => { e.preventDefault(); $("touchpad").setPointerCapture(e.pointerId); touch = { x: e.clientX, y: e.clientY, ax: e.clientX, ay: e.clientY, t: Date.now(), steps: 0 }; $("touchpad").classList.add("active"); moveDot(e); });
  $("touchpad").addEventListener("pointermove", e => {
    if (!touch) return; moveDot(e);
    const dx = e.clientX - touch.ax, dy = e.clientY - touch.ay; if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
    press(dir(dx, dy), true); touch.steps++; touch.ax = e.clientX; touch.ay = e.clientY;
  });
  $("touchpad").addEventListener("pointerup", e => {
    if (!touch) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y, dist = Math.hypot(dx, dy), quick = Date.now() - touch.t < 300;
    if (!touch.steps && dist < 10 && quick) press("ok"); else if (!touch.steps && dist >= 25 && quick) press(dir(dx, dy));
    touch = null; $("touchpad").classList.remove("active");
  });
  $("touchpad").addEventListener("pointercancel", () => { touch = null; $("touchpad").classList.remove("active"); });
  $("typeForm").addEventListener("submit", async e => {
    e.preventDefault(); const text = $("typeText").value; if (!text.trim()) return; $("typeText").blur();
    const r = await api("/api/tv/api/type", { method: "POST", body: { tv, text } }); toast(r.ok ? r.data.reply : errorText(r, "Couldn't type that."));
    if (r.ok) $("typeText").value = "";
  });
  const KEYMAP = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Escape: "back", h: "home", m: "menu", " ": "playpause", "+": "volup", "=": "volup", "-": "voldown" };
  document.addEventListener("keydown", e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || e.metaKey || e.ctrlKey || e.altKey || Hub.sheetOpen()) return;
    const key = KEYMAP[e.key]; if (!key) return; e.preventDefault(); press(key);
  });

  // ---------- play something new: the latest downloads, one tap to play ----------
  async function loadQuick() {
    const r = await api("/api/media/recent"); if (!r.ok) return;
    const seen = new Set(), items = (r.data.items || []).filter(i => !seen.has(i.title) && seen.add(i.title)).slice(0, 16);
    if (!items.length) return;
    $("quickRail").replaceChildren(rail(items.map((i, n) => {
      const t = el("button", "hub-tile"); t.type = "button"; t.style.setProperty("--i", n);
      const art = el("div", "art" + (i.posterUrl ? "" : " empty"), i.posterUrl ? null : i.title); if (i.posterUrl) art.style.backgroundImage = `url("${i.posterUrl.replace(/["\\]/g, "")}")`;
      t.append(art, el("div", "t", i.title), el("div", "s", i.episodeLabel || (i.mediaType === "movie" ? "Film" : "")));
      t.onclick = () => cmd("play " + i.title); return t;
    })));
    $("quickCard").hidden = false;
  }

  // ---------- start ----------
  gate({ message: "Sign in to use the TV remote.", onReady() {
    setTv(tv); clearInterval(poll); refreshOthers(); loadQuick();
    let n = 0;
    poll = setInterval(() => { if (document.hidden) return; refresh(); if (++n % 5 === 0) refreshOthers(); }, 4000);
  } });
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && status) refresh(); });
})();

/* Homebase Minecraft page: live status, players, start/stop/restart/backup and the console, all from Crafty
   Controller through tvbot (/api/tv/api/minecraft) over the private bridge. */
(() => {
  const { $, el, icon, toast, api, errorText, gate } = Hub;
  let state = null, poll = null, busyUntil = 0, lastLogKey = "";

  const gb = b => b ? (b / 1073741824).toFixed(1) + " GB" : "–";
  function uptime(started) {
    const t = Date.parse(String(started || "").replace(" ", "T") + "Z"); if (!t) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m} min`;
  }
  function stat(k, v, d) { const s = el("div", "hub-stat"); s.append(el("div", "k", k), el("div", "v", v), el("div", "d", d || "")); return s; }
  function button(label, cls, iconName, onClick) { const b = el("button", "hub-btn " + (cls || "")); b.type = "button"; if (iconName) b.append(icon(iconName)); b.append(el("span", null, label)); b.onclick = onClick; return b; }
  // stop and restart kick people off, so they ask twice
  function confirmButton(label, cls, iconName, warn, onConfirm) {
    let armed = null; const b = button(label, cls, iconName);
    b.onclick = () => {
      if (!armed) { b.classList.add("armed"); b.lastChild.textContent = warn(); armed = setTimeout(() => { armed = null; b.classList.remove("armed"); b.lastChild.textContent = label; }, 4000); return; }
      clearTimeout(armed); armed = null; b.classList.remove("armed"); b.lastChild.textContent = label; onConfirm();
    };
    return b;
  }

  async function refresh() {
    const r = await api("/api/tv/api/minecraft");
    if (!r.ok) { $("mcSideLabel").textContent = "Couldn't reach Crafty"; if (!state) { $("mcState").className = "mc-state"; $("mcState").lastChild.textContent = errorText(r, "Couldn't reach the server."); } return; }
    state = r.data; draw();
  }
  async function act(action, extra = {}) {
    const r = await api("/api/tv/api/minecraft", { method: "POST", body: { action, ...extra } });
    toast(r.ok ? r.data.reply || "Done." : errorText(r, "Crafty didn't accept that."), r.ok ? {} : "error");
    if (r.ok && action !== "command") busyUntil = Date.now() + 90000;
    setTimeout(refresh, 1500); setTimeout(refresh, 6000);
    return r.ok;
  }

  function draw() {
    const s = state, busy = s.starting || s.updating || (Date.now() < busyUntil && !s.running);
    const st = $("mcState"); st.className = "mc-state " + (s.running ? "on" : busy ? "busy" : "");
    st.lastChild.textContent = s.running ? "Online · up " + uptime(s.started) : busy ? "Starting…" : "Offline";
    $("mcName").textContent = s.name || "Minecraft";
    $("mcMotd").textContent = s.running ? [s.motd, s.version && "Minecraft " + s.version].filter(Boolean).join(" · ") : "The server is switched off. Start it to let players join.";
    $("mcSideLabel").textContent = s.running ? `Online · ${s.online} of ${s.max} playing` : "Offline";

    const acts = $("mcActions"); acts.replaceChildren();
    if (!s.running) acts.append(button(busy ? "Starting…" : "Start server", "primary", "play", () => act("start")));
    else {
      const who = () => s.online ? `Tap again: kicks ${s.online} player${s.online > 1 ? "s" : ""}` : "Tap again to confirm";
      acts.append(confirmButton("Restart", "", "restart", who, () => act("restart")),
        confirmButton("Stop", "danger", "pause", who, () => act("stop")),
        button("Back up now", "", "download", () => act("backup")));
    }
    if (busy && !s.running) acts.firstChild.disabled = true;

    $("mcStats").replaceChildren(
      stat("Players", s.running ? `${s.online} / ${s.max}` : "–", s.running ? (s.online ? "playing now" : "nobody on") : "offline"),
      stat("CPU", s.running && s.cpu != null ? Math.round(s.cpu) + "%" : "–", "of the server"),
      stat("Memory", s.running ? gb(s.memory) : "–", s.running && s.memoryPercent != null ? Math.round(s.memoryPercent) + "% of RAM" : ""),
      stat("World", s.worldSize || "–", "saved on disk"));

    $("mcPlayerCount").textContent = s.running ? `${s.online} of ${s.max}` : "";
    const pl = $("mcPlayers"); pl.replaceChildren();
    if (!s.running) pl.append(el("div", "hub-note", "Nobody can join while the server is off."));
    else if (!s.players.length) pl.append(el("div", "hub-note", s.online ? `${s.online} playing (names hidden by the server).` : "Nobody's on right now."));
    else {
      const box = el("div", "mc-players");
      for (const name of s.players) {
        const chip = el("div", "mc-player"), face = el("img"); face.alt = ""; face.loading = "lazy";
        face.src = "https://mc-heads.net/avatar/" + encodeURIComponent(name) + "/64";
        chip.append(face, el("span", null, name)); box.append(chip);
      }
      pl.append(box);
    }

    const key = (s.log || []).join("\n");
    if (key !== lastLogKey) {
      const log = $("mcLog"), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.textContent = key || (s.running ? "No recent output." : "The server is off.");
      if (atBottom || !lastLogKey) log.scrollTop = log.scrollHeight;
      lastLogKey = key;
    }
    $("mcCmd").disabled = !s.running;
  }

  $("mcCmdForm").addEventListener("submit", async e => {
    e.preventDefault(); const cmd = $("mcCmd").value.trim(); if (!cmd) return;
    if (await act("command", { command: cmd })) $("mcCmd").value = "";
  });

  gate({ message: "Sign in to manage the Minecraft server.", onReady() {
    refresh(); clearInterval(poll);
    poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  } });
  setInterval(() => { if (state?.running) draw(); }, 60000);  // keep the uptime ticking
})();

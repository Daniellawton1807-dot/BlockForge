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


  // ---- Mods: newest first, "new since your last download on this device", one-click jar or zip ----
  const SYNC_KEY = "homebase.mcModsSynced";
  let mods = null, showAll = false;
  const mb = b => b >= 1048576 ? (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  function ago(t) {
    const s = Date.now() / 1000 - t, d = Math.floor(s / 86400);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (d < 2) return "yesterday";
    if (d < 30) return d + " days ago";
    return new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function synced() { try { return Number(localStorage.getItem(SYNC_KEY)) || 0; } catch { return 0; } }
  function markSynced() { try { localStorage.setItem(SYNC_KEY, String(Math.floor(Date.now() / 1000))); } catch {} setTimeout(drawMods, 300); }
  const fileUrl = q => "/api/tv/api/minecraft/" + q;
  function link(label, cls, href, iconName, after) {
    const a = el("a", "hub-btn " + (cls || "")); a.href = href; a.setAttribute("download", "");
    if (iconName) a.append(icon(iconName)); if (label) a.append(el("span", null, label));
    if (after) a.addEventListener("click", after); return a;
  }
  const pretty = n => n.replace(/\.jar$/i, "");

  async function loadMods() {
    const r = await api("/api/tv/api/minecraft/mods");
    if (!r.ok) { $("mcModBar").replaceChildren(el("div", "txt", errorText(r, "Couldn't read the server's mods."))); return; }
    mods = r.data; drawMods();
  }
  function drawMods() {
    if (!mods) return;
    const since = synced(), base = since || Date.now() / 1000 - 7 * 86400;
    const fresh = mods.mods.filter(m => m.added > base);
    const gone = mods.removed.filter(r => r.at > base);
    $("mcModCount").textContent = `${mods.count} mods · ${mb(mods.size)}`;

    const txt = el("div", "txt");
    txt.append(el("b", null, fresh.length ? `${fresh.length} new mod${fresh.length > 1 ? "s" : ""} ${since ? "since your last download" : "this week"}` : since ? "You're up to date" : "No new mods this week"),
      el("small", null, since ? "Last downloaded on this device " + ago(since) + ". Downloading below marks you up to date." : "First visit on this device: showing mods added in the last 7 days."));
    const bar = $("mcModBar"); bar.replaceChildren(txt);
    if (fresh.length) bar.append(link(fresh.length > 1 ? `Download ${fresh.length} new (.zip)` : "Download the new mod", "primary", fresh.length > 1 ? fileUrl("modzip?ids=" + fresh.map(m => m.id).join(".")) : fileUrl("mod?id=" + fresh[0].id), "download", markSynced));
    bar.append(link(`All mods (${mb(mods.size)})`, "", fileUrl("modzip?all=1"), "download", markSynced));
    if (since && !fresh.length) { const b = el("button", "hub-btn"); b.type = "button"; b.textContent = "Reset"; b.title = "Forget the last download on this device"; b.onclick = () => { try { localStorage.removeItem(SYNC_KEY); } catch {} drawMods(); }; bar.append(b); }

    const rm = $("mcRemoved"); rm.hidden = !gone.length; rm.replaceChildren();
    if (gone.length) {
      const ul = el("ul"); for (const g of gone) ul.append(el("li", null, `${g.name} (removed ${ago(g.at)})`));
      rm.append(el("b", null, `Taken off the server: delete ${gone.length > 1 ? "these" : "this"} from your mods folder`), ul);
    }

    const q = $("mcModSearch").value.trim().toLowerCase();
    const list = q ? mods.mods.filter(m => m.name.toLowerCase().includes(q)) : mods.mods;
    const shown = q || showAll ? list : list.slice(0, 10);
    const ul = $("mcModList"); ul.replaceChildren();
    for (const m of shown) {
      const li = el("li", "mc-mod"), info = el("div", "info"), nm = el("div", "nm"), meta = el("div", "meta");
      if (m.added > base) nm.append(el("span", "tag", "NEW"));
      nm.append(document.createTextNode(pretty(m.name))); nm.title = m.name;
      meta.textContent = `Added ${ago(m.added)} · ${mb(m.size)}`;
      info.append(nm, meta);
      const a = link("", "", fileUrl("mod?id=" + m.id), "download"); a.setAttribute("aria-label", "Download " + m.name); a.title = "Download";
      li.append(info, a); ul.append(li);
    }
    if (!shown.length) ul.append(el("li", "mc-mod", q ? "No mods match that." : "No mods on the server."));
    const more = $("mcModMore"); more.hidden = !!q || list.length <= 10;
    more.textContent = showAll ? "Show fewer" : `Show all ${list.length}`;
  }
  $("mcModMore").onclick = () => { showAll = !showAll; drawMods(); };
  $("mcModSearch").addEventListener("input", drawMods);

  $("mcCmdForm").addEventListener("submit", async e => {
    e.preventDefault(); const cmd = $("mcCmd").value.trim(); if (!cmd) return;
    if (await act("command", { command: cmd })) $("mcCmd").value = "";
  });

  gate({ message: "Sign in to manage the Minecraft server.", onReady() {
    refresh(); loadMods(); clearInterval(poll);
    poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  } });
  setInterval(() => { if (state?.running) draw(); }, 60000);  // keep the uptime ticking
  setInterval(() => { if (!document.hidden && mods) loadMods(); }, 300000);  // pick up newly added mods
})();

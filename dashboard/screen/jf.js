/* Shared bits for the Screen Player: sign-in, Jellyfin calls, and what this browser can play. */
const JF = (() => {
  const BASE = (() => { try { return localStorage.getItem("wd.base") || ""; } catch { return ""; } })() || "https://jellyfin.danielvault.uk";   // wd.base only for testing
  const SK = "wd.jf";
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
  const deviceId = () => { let d = store.get("wd.dev"); if (!d) { d = "wdscreen-" + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("wd.dev", d); } return d; };
  const session = () => { try { return JSON.parse(store.get(SK)); } catch { return null; } };
  const header = token => `MediaBrowser Client="WebDisplays Screen", Device="Minecraft screen", DeviceId="${deviceId()}", Version="1.0"` + (token ? `, Token="${token}"` : "");
  async function api(path, opt = {}) {
    const s = session();
    const r = await fetch(BASE + path, { ...opt, headers: { "Authorization": header(s && s.token), "Content-Type": "application/json", ...(opt.headers || {}) } });
    if (r.status === 401) { store.del(SK); const e = new Error("You've been signed out."); e.code = 401; throw e; }
    if (!r.ok) throw new Error("Jellyfin answered " + r.status);
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  async function login(name, pw) {
    const r = await fetch(BASE + "/Users/AuthenticateByName", { method: "POST", headers: { "Authorization": header(), "Content-Type": "application/json" }, body: JSON.stringify({ Username: name, Pw: pw }) });
    if (r.status === 401 || r.status === 400) throw new Error("Wrong name or password.");
    if (!r.ok) throw new Error("Jellyfin answered " + r.status);
    const d = await r.json();
    store.set(SK, JSON.stringify({ token: d.AccessToken, userId: d.User.Id, name: d.User.Name }));
    return session();
  }
  const logout = () => store.del(SK);
  const img = (id, h = 420, type = "Primary") => `${BASE}/Items/${id}/Images/${type}?maxHeight=${h}&quality=80`;   // pictures need no sign-in
  // what this browser can play, so Jellyfin only sends formats it can show
  const hevcMse = c => !!(window.MediaSource && MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`));   // HEVC only where this PC's GPU/browser really decodes it
  function can() {
    const v = document.createElement("video"), ok = t => !!v.canPlayType(t);
    return { h264: ok('video/mp4; codecs="avc1.640028"'), hevc: ok('video/mp4; codecs="hvc1.1.6.L93.B0"') && hevcMse('hvc1.1.6.L93.B0'), hevc10: hevcMse('hvc1.2.4.L153.B0'), mkv: ok("video/x-matroska"), vp9: ok('video/webm; codecs="vp9"'), vp8: ok('video/webm; codecs="vp8"'), av1: ok('video/mp4; codecs="av01.0.05M.08"'),
      aac: ok('audio/mp4; codecs="mp4a.40.2"'), ac3: !!(window.MediaSource && MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"')), eac3: !!(window.MediaSource && MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')), mp3: ok("audio/mpeg"), opus: ok('audio/webm; codecs="opus"'), mse: !!window.MediaSource };
  }
  function deviceProfile(maxBitrate) {
    const c = can(), direct = [], codecs = [];
    const vc = [c.h264 && "h264", c.hevc && "hevc", c.vp9 && "vp9", c.av1 && "av1"].filter(Boolean), ac = [c.aac && "aac", c.mp3 && "mp3", c.opus && "opus"].filter(Boolean), dolby = [c.ac3 && "ac3", c.eac3 && "eac3"].filter(Boolean);   // Dolby only where this PC can really play it (then Jellyfin copies it instead of re-encoding)
    if (c.hevc && c.mkv) direct.push({ Container: "mkv", Type: "Video", VideoCodec: c.h264 ? "hevc,h264" : "hevc", AudioCodec: ac.filter(a => a !== "opus").join(",") || "aac" });
    if (c.hevc) direct.push({ Container: "mp4,m4v", Type: "Video", VideoCodec: c.h264 ? "hevc,h264" : "hevc", AudioCodec: ac.filter(a => a !== "opus").join(",") || "aac" });
    else if (c.h264) direct.push({ Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: ac.filter(a => a !== "opus").join(",") || "aac" });
    if (c.vp9 || c.vp8) direct.push({ Container: "webm", Type: "Video", VideoCodec: "vp8,vp9", AudioCodec: "opus,vorbis" });
    const trans = [];
    if (c.hevc && c.mse) trans.push({ Container: "mp4", Type: "Video", AudioCodec: ["aac", "mp3"].concat(dolby).join(","), VideoCodec: c.h264 ? "hevc,h264" : "hevc", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "2", MinSegments: "1", BreakOnNonKeyFrames: true });   // fMP4 HLS: Jellyfin copies HEVC instead of re-encoding it
    if (c.h264 && c.mse) trans.push({ Container: "ts", Type: "Video", AudioCodec: "aac,mp3", VideoCodec: "h264", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "2", MinSegments: "1", BreakOnNonKeyFrames: true });
    if (!trans.length) trans.push({ Container: "webm", Type: "Video", AudioCodec: "opus,vorbis", VideoCodec: "vp9,vp8", Context: "Streaming", Protocol: "http", MaxAudioChannels: "2" });
    return { Name: "WebDisplays Screen", MaxStreamingBitrate: maxBitrate, MaxStaticBitrate: maxBitrate, MusicStreamingTranscodingBitrate: 192000, DirectPlayProfiles: direct, TranscodingProfiles: trans,
      ContainerProfiles: [], CodecProfiles: [{ Type: "Video", Codec: "h264", Conditions: [{ Condition: "LessThanEqual", Property: "VideoLevel", Value: "51", IsRequired: false }] }].concat(c.hevc ? [{ Type: "Video", Codec: "hevc", Conditions: [{ Condition: "LessThanEqual", Property: "VideoBitDepth", Value: c.hevc10 ? "10" : "8", IsRequired: false }] }] : []),
      SubtitleProfiles: [{ Format: "vtt", Method: "External" }] };
  }
  const ticksToMin = t => Math.round((t || 0) / 600000000);
  /* Titles hidden from the Screen Player. They live in this account's own Jellyfin settings (display preferences, client "screenplayer"),
     so everyone signed in as the account, on any PC, sees the same list. */
  const prefPath = () => { const s = session(); return `/DisplayPreferences/screenplayer?userId=${s.userId}&client=screenplayer`; };
  let prefsCache = null;
  /* The account's Screen Player settings: the hidden titles and whether the Shows tab is hidden (films only). */
  async function prefs(force) {
    if (!prefsCache || force) prefsCache = (async () => { try { const d = await api(prefPath()), c = d.CustomPrefs || {}; return { hidden: new Set(String(c.hidden || "").split(",").filter(Boolean)), hideShows: c.hideShows === "1" }; } catch (e) { if (e.code === 401) throw e; return { hidden: new Set(), hideShows: false }; } })();
    return prefsCache;
  }
  async function savePrefs(p) {
    const d = await api(prefPath()); d.CustomPrefs = { ...(d.CustomPrefs || {}), hidden: [...p.hidden].join(","), hideShows: p.hideShows ? "1" : "0" }; d.Id = d.Id || "screenplayer"; d.Client = "screenplayer";
    await api(prefPath(), { method: "POST", body: JSON.stringify(d) }); prefsCache = Promise.resolve({ hidden: new Set(p.hidden), hideShows: !!p.hideShows });
  }
  const hiddenSet = async force => (await prefs(force)).hidden;
  const hiddenSave = async set => { const p = await prefs(); await savePrefs({ hidden: set, hideShows: p.hideShows }); };
  const isHidden = (item, hidden) => !!item && (hidden.has(item.Id) || (item.SeriesId && hidden.has(item.SeriesId)));
  const isShow = item => !!item && (item.Type === "Series" || item.Type === "Episode" || item.Type === "Season");
  /* Admin: the account's password again. Unlocked for 10 minutes in this browser tab only. */
  const adminUntil = () => +(sessionStorage.getItem("wd.admin") || 0);
  const isAdmin = () => { try { return adminUntil() > Date.now(); } catch { return false; } };
  async function adminUnlock(pw) {
    const s = session(); const r = await fetch(BASE + "/Users/AuthenticateByName", { method: "POST", headers: { "Authorization": header(), "Content-Type": "application/json" }, body: JSON.stringify({ Username: s.name, Pw: pw }) });
    if (r.status === 401 || r.status === 400) throw new Error("That isn't the password for " + s.name + ".");
    if (!r.ok) throw new Error("Jellyfin answered " + r.status);
    try { sessionStorage.setItem("wd.admin", String(Date.now() + 10 * 60000)); } catch {}
  }
  const adminLock = () => { try { sessionStorage.removeItem("wd.admin"); } catch {} };
  /* On a shared in-world screen everything typed is sent to everyone at it. The screen's page script (__wdLive) is how we tell. */
  const onSharedScreen = () => !!window.__wdLive;

  /* Remote control: this page registers with Jellyfin as a player that can be told what to do, like the TV apps, so Jarvis (or any Jellyfin remote)
     can say "play X" or "pause". It needs a signed-in session; every page of the Screen Player keeps the connection while it is open. */
  let rws = null, rka = null, rtry = 0;
  const here = () => location.pathname.replace(/[^/]*$/, "");
  async function playItem(itemId, startTicks) {
    const s = session(); if (!s) return;
    let it = await api(`/Users/${s.userId}/Items/${itemId}`);
    if (it.Type === "Series" || it.Type === "Season") {   // a show: carry on with the next episode, or the first
      const sid = it.Type === "Series" ? it.Id : it.SeriesId;
      it = ((await api(`/Shows/NextUp?UserId=${s.userId}&SeriesId=${sid}&Limit=1`)).Items || [])[0] || ((await api(`/Shows/${sid}/Episodes?UserId=${s.userId}&Limit=1`)).Items || [])[0];
    }
    if (!it) return;
    const cur = new URLSearchParams(location.search);
    if (/player\.html$/.test(location.pathname) && cur.get("id") === it.Id && startTicks == null) return;   // already on it
    location.href = `${here()}player.html?id=${it.Id}${startTicks != null ? "&t=" + Math.round(startTicks / 1e7) : ""}`;
  }
  function remote() {
    const s = session(); if (!s || rws) return;
    let w; try { w = rws = new WebSocket(BASE.replace(/^http/, "ws") + "/socket?ApiKey=" + encodeURIComponent(s.token) + "&deviceId=" + encodeURIComponent(deviceId())); } catch { rws = null; return; }
    w.onopen = () => { rtry = 0; clearInterval(rka); rka = setInterval(() => { try { w.send(JSON.stringify({ MessageType: "KeepAlive" })); } catch {} }, 25000);
      fetch(BASE + "/Sessions/Capabilities/Full", { method: "POST", headers: { "Authorization": header(s.token), "Content-Type": "application/json" }, body: JSON.stringify({ PlayableMediaTypes: ["Video"], SupportedCommands: [], SupportsMediaControl: true, SupportsPersistentIdentifier: false }) }).catch(() => {}); };
    w.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } const d = m.Data || {};
      if (m.MessageType === "ForceKeepAlive") w.send(JSON.stringify({ MessageType: "KeepAlive" }));
      else if (m.MessageType === "Play" && (!d.PlayCommand || d.PlayCommand === "PlayNow") && (d.ItemIds || [])[0]) playItem(d.ItemIds[0], d.StartPositionTicks > 0 || d.StartPositionTicks === 0 ? d.StartPositionTicks : null).catch(() => {});
      else if (m.MessageType === "Playstate" && JF.onState) JF.onState(d.Command, d.SeekPositionTicks); };
    w.onclose = () => { rws = null; clearInterval(rka); };
  }
  setInterval(() => { if (!rws && session()) remote(); }, 4000); setTimeout(remote, 0);
  const JF = { onState: null };
  return Object.assign(JF, { BASE, api, login, logout, session, img, can, deviceProfile, store, deviceId, ticksToMin, prefs, savePrefs, hiddenSet, hiddenSave, isHidden, isShow, isAdmin, adminUnlock, adminLock, onSharedScreen });
})();

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
  function can() {
    const v = document.createElement("video"), ok = t => !!v.canPlayType(t);
    return { h264: ok('video/mp4; codecs="avc1.640028"'), hevc: ok('video/mp4; codecs="hvc1.1.6.L93.B0"'), vp9: ok('video/webm; codecs="vp9"'), vp8: ok('video/webm; codecs="vp8"'), av1: ok('video/mp4; codecs="av01.0.05M.08"'),
      aac: ok('audio/mp4; codecs="mp4a.40.2"'), mp3: ok("audio/mpeg"), opus: ok('audio/webm; codecs="opus"'), mse: !!window.MediaSource };
  }
  function deviceProfile(maxBitrate) {
    const c = can(), direct = [], codecs = [];
    const vc = [c.h264 && "h264", c.hevc && "hevc", c.vp9 && "vp9", c.av1 && "av1"].filter(Boolean), ac = [c.aac && "aac", c.mp3 && "mp3", c.opus && "opus"].filter(Boolean);
    if (c.h264) direct.push({ Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: ac.filter(a => a !== "opus").join(",") || "aac" });
    if (c.vp9 || c.vp8) direct.push({ Container: "webm", Type: "Video", VideoCodec: "vp8,vp9", AudioCodec: "opus,vorbis" });
    const trans = [];
    if (c.h264 && c.mse) trans.push({ Container: "ts", Type: "Video", AudioCodec: "aac,mp3", VideoCodec: "h264", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "2", MinSegments: "1", BreakOnNonKeyFrames: true });
    if (!trans.length) trans.push({ Container: "webm", Type: "Video", AudioCodec: "opus,vorbis", VideoCodec: "vp9,vp8", Context: "Streaming", Protocol: "http", MaxAudioChannels: "2" });
    return { Name: "WebDisplays Screen", MaxStreamingBitrate: maxBitrate, MaxStaticBitrate: maxBitrate, MusicStreamingTranscodingBitrate: 192000, DirectPlayProfiles: direct, TranscodingProfiles: trans,
      ContainerProfiles: [], CodecProfiles: [{ Type: "Video", Codec: "h264", Conditions: [{ Condition: "LessThanEqual", Property: "VideoLevel", Value: "51", IsRequired: false }] }],
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
  return { BASE, api, login, logout, session, img, can, deviceProfile, store, deviceId, ticksToMin, prefs, savePrefs, hiddenSet, hiddenSave, isHidden, isShow, isAdmin, adminUnlock, adminLock, onSharedScreen };
})();

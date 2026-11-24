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
  return { BASE, api, login, logout, session, img, can, deviceProfile, store, deviceId, ticksToMin };
})();

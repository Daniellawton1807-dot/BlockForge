import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as healthRequest } from "../functions/api/health.js";
import { onRequest as manageRequest } from "../functions/api/media/manage.js";
import { sessionCookie } from "../functions/_utils/downloads-auth.js";
import { fixQueueItem } from "../functions/_utils/autopilot.js";

const jsonResponse = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), {
  status,
  headers: body == null ? {} : { "content-type": "application/json" }
});

const sessionEnv = {
  HOMEBASE_DOWNLOADS_USERNAME: "test-user",
  HOMEBASE_DOWNLOADS_PASSWORD: "test-password",
  HOMEBASE_DOWNLOADS_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
  SONARR_DANIEL_API_KEY: "test-sonarr-key",
  RADARR_API_KEY: "test-radarr-key"
};

async function healthStates() {
  const originalFetch = globalThis.fetch;
  const responses = [200, 302, 401, 403, 503];
  let call = 0;
  globalThis.fetch = async () => {
    const status = responses[call++];
    if (status == null) throw new Error("network down");
    return new Response(null, { status });
  };
  // the private bridge: Jarvis answers "enter your PIN", tvbot can't be reached, Pitwall serves its page, ARR is fine
  const bridge = async request => {
    const service = request.headers.get("x-homebase-service");
    if (service === "jarvis") return jsonResponse({ code: "pin_required" }, 401);
    if (service === "tvbot") return jsonResponse({ error: "unavailable" }, 503);
    if (service === "pitwall") return new Response("<html></html>", { status: 200 });
    return jsonResponse({ version: "4" });
  };
  try {
    const cookie = await sessionCookie(sessionEnv, false);
    const response = await healthRequest({
      request: new Request("https://homebase.test/api/health", { headers: { cookie } }),
      env: { ...sessionEnv, TVBOT_TOKEN: "test-tv-token", ARR_BRIDGE: { fetch: bridge } }
    });
    const { services } = await response.json();
    assert.equal(services.Seerr.state, "online");
    assert.equal(services.SABnzbd.state, "redirected");
    assert.equal(services.qBittorrent.state, "login_required");
    assert.equal(services.Jellyfin.state, "login_required");
    assert.equal(services.CasaOS.state, "degraded");
    assert.equal(services.Crafty.state, "unreachable");
    assert.equal(services.SABnzbd.reachable, true, "redirects remain reachable");
    assert.equal(services.qBittorrent.up, true, "legacy up field remains compatible");
    assert.equal(services.CasaOS.up, false);
    assert.equal(services.Crafty.status, 0);
    assert.equal(services.Jarvis.state, "online", "a PIN prompt from Jarvis means it's running");
    assert.equal(services.tvbot.state, "unreachable");
    assert.equal(services.Pitwall.state, "online");
    assert.equal(services.Sonarr.state, "online");
    assert.equal(services["Sonarr Mum"].state, "not_configured");
  } finally { globalThis.fetch = originalFetch; }
}

async function mediaRequest(body, bridge) {
  const cookie = await sessionCookie(sessionEnv, false);
  return manageRequest({
    request: new Request("https://homebase.test/api/media/manage", {
      method: "POST",
      headers: { origin: "https://homebase.test", "content-type": "application/json", cookie },
      body: JSON.stringify(body)
    }),
    env: { ...sessionEnv, ARR_BRIDGE: { fetch: bridge } }
  });
}

async function deletionConfirmation() {
  let calls = 0;
  const noCall = async () => { calls++; return jsonResponse({}); };
  for (const body of [
    { serviceKey: "radarr", id: 20, action: "removeMovie" },
    { serviceKey: "sonarr-daniel", id: 10, action: "removeSeries" },
    { serviceKey: "sonarr-daniel", id: 10, action: "removeEpisode", episodeId: 101, episodeFileEpisodeIds: [101] }
  ]) {
    const missing = await mediaRequest(body, noCall);
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "confirmation_required");
  }
  assert.equal(calls, 0, "unconfirmed deletion must never call Radarr");

  const staleEpisode = await mediaRequest({ serviceKey: "sonarr-daniel", id: 10, action: "removeEpisode", confirmed: true, episodeId: 101, episodeFileEpisodeIds: [101, 102] }, async request => {
    calls++;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/series/10")) return jsonResponse({ id: 10 });
    if (path.endsWith("/episode")) return jsonResponse([{ id: 101, seriesId: 10, episodeFileId: 33, hasFile: true }]);
    if (path.endsWith("/episodefile/33")) return jsonResponse({ id: 33, seriesId: 10, episodeIds: [101] });
    return jsonResponse({}, 404);
  });
  assert.equal(staleEpisode.status, 409);
  assert.equal((await staleEpisode.json()).code, "file_changed");
  assert.equal(calls, 3, "stale file confirmation must stop before DELETE");
}

async function exactEpisodeDeletion() {
  const requests = [];
  const response = await mediaRequest({ serviceKey: "sonarr-daniel", id: 10, action: "removeEpisode", confirmed: true, episodeId: 101, episodeFileEpisodeIds: [101] }, async request => {
    requests.push({ path: new URL(request.url).pathname, method: request.method });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/series/10")) return jsonResponse({ id: 10 });
    if (path.endsWith("/episode")) return jsonResponse([{ id: 101, seriesId: 10, episodeFileId: 33, hasFile: true }]);
    if (path.endsWith("/episodefile/33")) return jsonResponse({ id: 33, seriesId: 10, episodeIds: [101] });
    if (path.endsWith("/episodefile/33") && request.method === "DELETE") return jsonResponse(null, 204);
    return jsonResponse(null, 204);
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify((await response.json()).removedEpisodeIds), "[101]");
  assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
  assert.equal(requests.at(-1).path, "/api/v3/episodefile/33");
}

async function confirmedSeriesDeletion() {
  const deletes = [];
  const response = await mediaRequest({ serviceKey: "sonarr-daniel", id: 10, action: "removeSeries", confirmed: true }, async request => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/series/10")) return jsonResponse({ id: 10 });
    if (request.method === "GET" && url.pathname.endsWith("/episodefile")) return jsonResponse([{ id: 33, seriesId: 10 }]);
    if (request.method === "DELETE") { deletes.push(url.pathname + url.search); return jsonResponse(null, 204); }
    return jsonResponse({}, 404);
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(deletes), JSON.stringify(["/api/v3/series/10?deleteFiles=true&addImportListExclusion=false"]));
  assert.equal((await response.json()).removedFileCount, 1);
}

async function oneTapQueueFixes() {
  const calls = [];
  const bridge = async request => {
    const url = new URL(request.url), path = url.pathname + url.search;
    calls.push(request.method + " " + path);
    if (path.startsWith("/api/v3/queue?")) return jsonResponse({ records: [
      { id: 5, downloadId: "ABC", title: "Show.S01E01", seriesId: 1, episodeId: 11, episode: { seasonNumber: 1, episodeNumber: 1 }, series: { title: "Show" } },
      { id: 6, downloadId: "ABC", title: "Show.S01E02", seriesId: 1, episodeId: 12, episode: { seasonNumber: 1, episodeNumber: 2 }, series: { title: "Show" } }
    ] });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    return jsonResponse({});
  };
  const env = { ...sessionEnv, ARR_BRIDGE: { fetch: bridge } };
  await assert.rejects(fixQueueItem(env, "sonarr-daniel", 99, "remove"), /no longer in the queue/);
  assert.match(await fixQueueItem(env, "sonarr-daniel", 5, "remove"), /Removed Show S01E01/);
  assert.ok(calls.includes("DELETE /api/v3/queue/5?removeFromClient=true&blocklist=false&skipRedownload=true"));
  calls.length = 0;
  assert.match(await fixQueueItem(env, "sonarr-daniel", 5, "research"), /searched for 2 episodes/);
  assert.ok(calls.includes("DELETE /api/v3/queue/5?removeFromClient=true&blocklist=true&skipRedownload=true"), "blocklists without Sonarr's own redownload");
  assert.ok(calls.includes("POST /api/v3/command"), "searches the whole pack again");
}

async function takenDownReleasesDontUseUpRetries() {
  const failures = (missing, real) => [
    ...Array.from({ length: missing }, () => ({ eventType: "downloadFailed", date: new Date().toISOString(), data: { message: "Aborted, cannot be completed - https://sabnzbd.org/not-complete" } })),
    ...Array.from({ length: real }, () => ({ eventType: "downloadFailed", date: new Date().toISOString(), data: { message: "Unpacking failed, archive requires a password" } }))];
  const run = async history => {
    const searches = [];
    const bridge = async request => {
      const url = new URL(request.url), path = url.pathname + url.search;
      if (path.startsWith("/api/v3/queue?")) return jsonResponse({ records: [{ id: 7, downloadId: "X", title: "Show.S01E01", seriesId: 1, episodeId: 11, episode: { seasonNumber: 1, episodeNumber: 1 }, series: { title: "Show" } }] });
      if (path.startsWith("/api/v3/history")) return jsonResponse({ records: history });
      if (request.method === "POST") searches.push(path);
      return request.method === "DELETE" ? new Response(null, { status: 200 }) : jsonResponse({});
    };
    const message = await fixQueueItem({ ...sessionEnv, ARR_BRIDGE: { fetch: bridge } }, "sonarr-daniel", 7, "research");
    return { message, searched: searches.length > 0 };
  };
  let r = await run(failures(5, 1));
  assert.ok(r.searched, "five taken-down releases and one real failure still retry");
  assert.match(r.message, /attempt 2 of 3; 5 taken-down releases not counted/);
  r = await run(failures(0, 3));
  assert.equal(r.searched, false, "three real failures rest");
  r = await run(failures(10, 0));
  assert.equal(r.searched, false, "ten taken-down releases rest too");
}

export async function runMediaSafetyTests() {
  await takenDownReleasesDontUseUpRetries();
  await oneTapQueueFixes();
  await healthStates();
  await deletionConfirmation();
  await exactEpisodeDeletion();
  await confirmedSeriesDeletion();
  return "6 mocked integration tests passed";
}

test("media actions enforce confirmation and verify file identity before deletion", runMediaSafetyTests);

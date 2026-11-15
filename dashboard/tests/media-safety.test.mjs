import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as healthRequest } from "../functions/api/health.js";
import { onRequest as manageRequest } from "../functions/api/media/manage.js";
import { sessionCookie } from "../functions/_utils/downloads-auth.js";

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

export async function runMediaSafetyTests() {
  await healthStates();
  await deletionConfirmation();
  await exactEpisodeDeletion();
  await confirmedSeriesDeletion();
  return "4 mocked integration tests passed";
}

test("media actions enforce confirmation and verify file identity before deletion", runMediaSafetyTests);

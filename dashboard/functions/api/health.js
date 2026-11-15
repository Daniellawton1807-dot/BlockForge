// Check public apps through their published addresses. Sonarr/Radarr use Homebase's
// private bridge and configured API keys so a login page on their public web UI
// cannot be mistaken for a broken service.
import { arrCall, arrServiceStatus, arrServices } from "../_utils/arr.js";
import { json, loginConfigured, validSession } from "../_utils/downloads-auth.js";

const PUBLIC_SERVICES = {
  Seerr: "https://seerr.danielvault.uk",
  SABnzbd: "https://sab.danielvault.uk",
  qBittorrent: "https://qb.danielvault.uk",
  Jellyfin: "https://jellyfin.danielvault.uk",
  CasaOS: "https://casa.danielvault.uk",
  Crafty: "https://minecraft.danielvault.uk"
};

async function checkPublic(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "user-agent": "Homebase health check" } });
    const status = response.status;
    const state = status === 401 || status === 403 ? "login_required" : status >= 300 && status < 400 ? "redirected" : status >= 400 ? "degraded" : "online";
    return { up: status < 500, reachable: true, state, status, ms: Date.now() - started };
  } catch {
    return { up: false, reachable: false, state: "unreachable", status: 0, ms: Date.now() - started };
  }
}

// Jarvis, tvbot and Pitwall only live on the server, so check them through the private bridge. Any answer from the
// app itself counts (Jarvis answers "enter your PIN" without a session); the bridge says 502/503 when it can't reach it.
const PRIVATE_SERVICES = {
  Jarvis: { service: "jarvis", path: "state" },
  tvbot: { service: "tvbot", path: "api/status", token: "TVBOT_TOKEN" },
  Pitwall: { service: "pitwall", path: "" }
};

async function checkPrivate(env, { service, path, token }) {
  const started = Date.now();
  if (!env.ARR_BRIDGE || (token && !env[token])) return { up: false, reachable: false, state: "not_configured", status: 0, ms: 0 };
  try {
    const headers = { "x-homebase-service": service, accept: "application/json" };
    if (token) headers["x-tv-token"] = String(env[token]).trim();
    const response = await env.ARR_BRIDGE.fetch(new Request("https://homebase-arr-bridge/" + path, { headers, signal: AbortSignal.timeout(6000) }));
    response.body?.cancel();
    const status = response.status;
    const state = [502, 503, 504].includes(status) ? "unreachable" : status >= 500 ? "degraded" : "online";
    return { up: state === "online", reachable: state !== "unreachable", state, status, ms: Date.now() - started };
  } catch {
    return { up: false, reachable: false, state: "unreachable", status: 0, ms: Date.now() - started };
  }
}

async function checkArr(env, service) {
  const started = Date.now();
  const configured = arrServiceStatus(env, service);
  if (!configured.configured) {
    return { up: false, reachable: false, state: "not_configured", status: 0, ms: Date.now() - started };
  }
  try {
    await arrCall(env, service, "api/v3/system/status");
    return { up: true, reachable: true, state: "online", status: 200, ms: Date.now() - started };
  } catch (error) {
    const authFailed = error?.code === "arr_auth_failed";
    const unreachable = error?.code === "service_unavailable";
    return {
      up: false,
      reachable: !unreachable,
      state: authFailed ? "auth_failed" : unreachable ? "unreachable" : "degraded",
      status: Number(error?.upstreamStatus) || (unreachable ? 0 : authFailed ? 401 : 502),
      ms: Date.now() - started
    };
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to check service health." }, 401);

  const entries = await Promise.all([
    ...arrServices().map(async service => [service.name, await checkArr(env, service)]),
    ...Object.entries(PUBLIC_SERVICES).map(async ([name, url]) => [name, await checkPublic(url)]),
    ...Object.entries(PRIVATE_SERVICES).map(async ([name, check]) => [name, await checkPrivate(env, check)])
  ]);
  return json({ checkedAt: new Date().toISOString(), services: Object.fromEntries(entries) });
}

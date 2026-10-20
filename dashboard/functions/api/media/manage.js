import { arrCall, arrService, arrServiceStatus } from "../../_utils/arr.js";
import { json, loginConfigured, readJsonBody, validRequestOrigin, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "POST" });
  if (!validRequestOrigin(request)) return json({ code: "invalid_origin", error: "Request origin could not be verified." }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ code: "invalid_content_type", error: "Expected a JSON request." }, 415);
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in before managing media." }, 401);
  let body;
  try { body = await readJsonBody(request, 2048); }
  catch { return json({ code: "invalid_request", error: "Could not read the media action." }, 400); }

  const service = arrService(body?.serviceKey);
  const id = Number(body?.id);
  const action = String(body?.action || "");
  if (!service || !Number.isSafeInteger(id) || id <= 0 || !["monitor", "refresh", "search"].includes(action)) {
    return json({ code: "invalid_request", error: "Select a valid library item and action." }, 400);
  }
  const status = arrServiceStatus(env, service);
  if (!status.configured) return json({ code: status.code, error: status.message }, 503);

  try {
    const resource = service.type === "tv" ? "series" : "movie";
    if (action === "monitor") {
      const current = await arrCall(env, service, "api/v3/" + resource + "/" + id);
      if (!current || Number(current.id) !== id) return json({ code: "not_found", error: "That title is no longer in the selected library." }, 404);
      current.monitored = body.value === true;
      const updated = await arrCall(env, service, "api/v3/" + resource + "/" + id, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current)
      });
      return json({ accepted: true, monitored: Boolean(updated?.monitored) });
    }

    const commandName = action === "refresh"
      ? (service.type === "tv" ? "RefreshSeries" : "RefreshMovie")
      : (service.type === "tv" ? "SeriesSearch" : "MoviesSearch");
    const command = service.type === "tv"
      ? { name: commandName, seriesId: id }
      : action === "refresh" ? { name: commandName, movieId: id } : { name: commandName, movieIds: [id] };
    const queued = await arrCall(env, service, "api/v3/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    });
    return json({ accepted: true, commandId: Number(queued?.id) || null, action });
  } catch (error) {
    return json({ code: error?.code || "arr_unavailable", error: error?.message || service.name + " could not complete that action." }, error?.status || 502);
  }
}

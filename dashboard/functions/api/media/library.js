import { arrCall, arrServiceStatus, arrServices, normalizeLibraryItem } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to view your media library." }, 401);

  const settled = await Promise.all(arrServices().map(async service => {
    const status = arrServiceStatus(env, service);
    if (!status.configured) return { service, error: status.message };
    try {
      const route = service.type === "tv" ? "api/v3/series" : "api/v3/movie?excludeLocalCovers=true";
      const items = await arrCall(env, service, route);
      return { service, items: Array.isArray(items) ? items.map(item => normalizeLibraryItem(service, item)).filter(Boolean) : [] };
    } catch (error) {
      return { service, error: error?.message || service.name + " is unavailable." };
    }
  }));
  return json({
    items: settled.flatMap(result => result.items || []),
    services: settled.map(result => ({
      key: result.service.key,
      name: result.service.name,
      type: result.service.type,
      connected: Array.isArray(result.items),
      count: result.items?.length || 0,
      message: result.error || ""
    }))
  });
}

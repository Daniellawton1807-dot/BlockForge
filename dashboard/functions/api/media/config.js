import { arrServiceStatus, arrServices, readArrOptions } from "../../_utils/arr.js";
import { json, loginConfigured, validSession } from "../../_utils/downloads-auth.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ code: "method_not_allowed", error: "Method not allowed." }, 405, { allow: "GET" });
  if (!loginConfigured(env)) return json({ code: "login_setup_required", error: "Dashboard login has not been configured." }, 503);
  if (!await validSession(request, env)) return json({ code: "login_required", error: "Sign in to manage media." }, 401);

  const services = await Promise.all(arrServices().map(async service => {
    const status = arrServiceStatus(env, service);
    if (!status.configured) return status;
    try {
      const options = await readArrOptions(env, service);
      return {
        ...status,
        configured: true,
        connected: true,
        rootFolders: options.rootFolders,
        qualityProfiles: options.qualityProfiles,
        libraryCount: options.library.length
      };
    } catch (error) {
      return {
        ...status,
        connected: false,
        code: error?.code || "service_unavailable",
        message: error?.message || service.name + " is not reachable from Homebase."
      };
    }
  }));
  const ready = services.filter(service => service.connected).length;
  return json({ services, ready, total: services.length });
}

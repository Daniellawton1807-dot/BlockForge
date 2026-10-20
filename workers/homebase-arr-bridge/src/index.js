const SERVICES = Object.freeze({
  "sonarr-daniel": { binding: "VPC_SONARR_DANIEL", port: 8989 },
  "sonarr-mum": { binding: "VPC_SONARR_MUM", port: 8990 },
  "sonarr-extra": { binding: "VPC_SONARR_EXTRA", port: 8991 },
  "radarr": { binding: "VPC_RADARR", port: 7878 }
});

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_API_PATH = new RegExp("^api/v3/[A-Za-z0-9_./?=&%:+-]+$");
const MAX_BODY_BYTES = 1024 * 1024;

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}

export default {
  async fetch(request, env) {
    const method = request.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) return json({ error: "Method not allowed." }, 405, { allow: [...ALLOWED_METHODS].join(", ") });

    const serviceKey = request.headers.get("x-homebase-service") || "";
    const service = SERVICES[serviceKey];
    if (!service) return json({ error: "Unknown media service." }, 404);

    const url = new URL(request.url);
    let path = url.pathname;
    while (path.startsWith("/")) path = path.slice(1);
    const pathAndQuery = path + url.search;
    if (!SAFE_API_PATH.test(pathAndQuery) || pathAndQuery.includes("..") || /%2e/i.test(pathAndQuery)) {
      return json({ error: "That media operation is not supported." }, 400);
    }

    const apiKey = request.headers.get("x-api-key") || "";
    if (!apiKey || apiKey.length > 512) return json({ error: "API key is missing." }, 401);

    const binding = env[service.binding];
    if (!binding || typeof binding.fetch !== "function") return json({ error: "Private ARR service binding is unavailable." }, 503);

    let body;
    if (method !== "GET") {
      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
      try {
        body = await request.arrayBuffer();
      } catch {
        return json({ error: "Request body could not be read." }, 400);
      }
      if (body.byteLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
    }

    const headers = new Headers({
      "x-api-key": apiKey,
      "accept": "application/json"
    });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    let upstream;
    try {
      const upstreamRequest = new Request("http://192.168.8.150:" + service.port + "/" + pathAndQuery, {
        method,
        headers,
        body
      });
      upstream = await binding.fetch(upstreamRequest);
    } catch {
      return json({ error: "Private media service is unavailable." }, 503);
    }

    const responseHeaders = new Headers({ "cache-control": "no-store" });
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  }
};

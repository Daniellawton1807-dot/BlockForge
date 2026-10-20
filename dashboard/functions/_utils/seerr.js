const DEFAULT_SEERR_BASE_URL = "https://seerr.danielvault.uk";

export class SeerrError extends Error {
  constructor(message, status = 502, code = "seerr_unavailable") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function seerrConfigured(env) {
  return Boolean(String(env.SEERR_API_KEY || "").trim());
}

function seerrBase(env) {
  let root;
  try {
    root = new URL(String(env.SEERR_BASE_URL || DEFAULT_SEERR_BASE_URL).trim());
  } catch {
    throw new SeerrError("The Seerr service URL is invalid.", 503, "seerr_url_invalid");
  }
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash) {
    throw new SeerrError("The Seerr service URL must be HTTPS and contain no credentials.", 503, "seerr_url_invalid");
  }
  root.pathname = root.pathname.replace(/\\/+$/, "");
  return root;
}

export async function seerrCall(env, endpoint, options = {}) {
  const apiKey = String(env.SEERR_API_KEY || "").trim();
  if (!apiKey) throw new SeerrError("Set SEERR_API_KEY as a protected Cloudflare Pages secret.", 503, "seerr_setup_required");

  const root = seerrBase(env);
  const route = String(endpoint || "").replace(/^\\/+/, "");
  const url = new URL(root.pathname + "/api/v1/" + route, root.origin);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        "X-Api-Key": apiKey,
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(10000),
      redirect: "manual"
    });
  } catch {
    throw new SeerrError("Homebase could not reach Seerr.", 502, "seerr_unavailable");
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SeerrError("Seerr redirected the API request. Check its configured URL.", 502, "seerr_redirected");
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new SeerrError("This title already has an active request or cannot be requested again.", 409, "request_conflict");
    }
    if (response.status === 401 || response.status === 403) {
      throw new SeerrError("Seerr rejected its API key or the key lacks permission.", 502, "seerr_auth_failed");
    }
    if (response.status === 530) {
      const body = await response.text().catch(() => "");
      const cloudflareCode = body.match(/\\bError(?:\\s+code)?\\s*[:#]?\\s*(1\\d{3})\\b/i)?.[1];
      const suffix = cloudflareCode ? " (Cloudflare error " + cloudflareCode + ")" : "";
      throw new SeerrError("Seerr returned HTTP 530" + suffix + ".", 502, "seerr_upstream_error");
    }
    throw new SeerrError("Seerr returned HTTP " + response.status + ".", 502, "seerr_upstream_error");
  }

  try {
    return await response.json();
  } catch {
    throw new SeerrError("Seerr returned invalid JSON.", 502, "seerr_invalid_json");
  }
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.servers)) return value.servers;
  return [];
}

function cleanPath(value) {
  if (typeof value !== "string") return "";
  const path = value.trim();
  return path.length > 0 && path.length <= 500 && !/[\\r\\n\\0]/.test(path) ? path : "";
}

async function testServer(env, type, server) {
  const body = {
    hostname: server.hostname,
    port: Number(server.port),
    apiKey: String(server.apiKey || ""),
    useSsl: server.useSsl === true,
    baseUrl: String(server.baseUrl || "")
  };
  const detail = await seerrCall(env, "settings/" + type + "/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const folders = Array.isArray(detail?.rootFolders)
    ? detail.rootFolders.map(folder => cleanPath(folder?.path)).filter(Boolean)
    : [];
  return folders;
}

export async function seerrTargets(env, type) {
  if (!["sonarr", "radarr"].includes(type)) {
    throw new SeerrError("Unsupported media server type.", 400, "invalid_server_type");
  }

  const configured = listFrom(await seerrCall(env, "settings/" + type));
  const targets = await Promise.all(configured.map(async server => {
    const id = Number(server?.id);
    if (!Number.isSafeInteger(id) || id < 0) return null;

    let rootFolders = [];
    let rootFolderListAvailable = false;
    try {
      rootFolders = await testServer(env, type, server);
      rootFolderListAvailable = rootFolders.length > 0;
    } catch {
      // Keep the configured default as a usable fallback if the service detail call is unavailable.
    }

    const activeDirectory = cleanPath(server?.activeDirectory);
    if (!rootFolders.length && activeDirectory) rootFolders = [activeDirectory];

    return {
      id,
      name: String(server?.name || (type === "sonarr" ? "Sonarr" : "Radarr")).slice(0, 80),
      is4k: server?.is4k === true,
      isDefault: server?.isDefault === true,
      profileId: Number.isSafeInteger(Number(server?.activeProfileId)) && Number(server.activeProfileId) > 0
        ? Number(server.activeProfileId)
        : null,
      activeDirectory,
      rootFolders: rootFolders.map(path => ({ path })),
      rootFolderListAvailable
    };
  }));

  return targets.filter(Boolean);
}

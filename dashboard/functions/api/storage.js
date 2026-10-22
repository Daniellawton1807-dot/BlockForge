import { json, loginConfigured, validRequestOrigin, validSession } from "../_utils/downloads-auth.js";

const DEFAULT_GLANCES_URL = "https://glances.danielvault.uk";
const number = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const safeText = value => String(value ?? "").slice(0, 200);

async function glancesJson(root, path) {
  const response = await fetch(new URL(path, root.origin + "/"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(6000),
    redirect: "manual"
  });
  if (!response.ok || response.status >= 300 && response.status < 400) throw new Error("Glances returned HTTP " + response.status + " for " + path);
  return response.json();
}

async function getStorage(env) {
  const base = String(env.GLANCES_BASE_URL || DEFAULT_GLANCES_URL).trim().replace(/\/+$/, "");
  let root;
  try { root = new URL(base); } catch { return json({ error: "Glances URL is not configured correctly." }, 503); }
  if (root.protocol !== "https:" || root.username || root.password) return json({ error: "Glances must use HTTPS." }, 503);

  try {
    const [filesystems, diskio] = await Promise.all([
      glancesJson(root, "/api/4/fs"),
      glancesJson(root, "/api/4/diskio").catch(() => [])
    ]);
    const io = Array.isArray(diskio) ? diskio : [];
    // Exclude bind/pseudo mounts such as /etc/hosts that duplicate root storage.
    const excludedMount = /^(\/proc(?:\/|$)|\/sys(?:\/|$)|\/dev(?:\/|$)|\/run(?:\/|$)|\/etc\/(hosts|hostname|resolv\.conf)$|\/var\/lib\/docker(?:\/|$)|\/var\/lib\/containers(?:\/|$))/;
    const candidates = (Array.isArray(filesystems) ? filesystems : []).filter(fs => {
      const mount = String(fs?.mnt_point || "");
      const device = String(fs?.device_name || fs?.device || fs?.name || "");
      const type = String(fs?.fs_type || fs?.fstype || "");
      if (!mount || excludedMount.test(mount)) return false;
      if (/^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|nsfs|ramfs)$/i.test(type)) return false;
      return device.startsWith("/dev/") || mount === "/" || mount.startsWith("/mnt/") || mount.startsWith("/media/") || mount.startsWith("/run/media/");
    });
    const unique = new Map();
    for (const fs of candidates) {
      const mount = String(fs?.mnt_point || "");
      const device = String(fs?.device_name || fs?.device || fs?.name || mount);
      const key = device + "|" + mount;
      if (!unique.has(key)) unique.set(key, fs);
    }
    const disks = [...unique.values()].map((fs, index) => {
      const mount = safeText(fs?.mnt_point || "Unknown mount");
      const name = safeText(fs?.device_name || fs?.device || fs?.name || mount);
      const matchingIo = io.find(d => [d?.disk_name,d?.name,d?.device_name].some(v => v && (String(v) === name || name.includes(String(v)) || String(v).includes(name))));
      const size = number(fs?.size);
      const used = number(fs?.used);
      const percent = number(fs?.percent);
      return {
        id: index, name, mount,
        filesystem: safeText(fs?.fs_type || fs?.fstype || "Filesystem"),
        totalBytes: size, usedBytes: used,
        freeBytes: number(fs?.free), percent,
        mounted: Boolean(fs?.mnt_point),
        readBytesPerSecond: number(matchingIo?.read_bytes_rate ?? matchingIo?.read_bytes),
        writeBytesPerSecond: number(matchingIo?.write_bytes_rate ?? matchingIo?.write_bytes),
        ioAvailable: Boolean(matchingIo)
      };
    });
    return json({ updatedAt: new Date().toISOString(), disks });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to read storage status from Glances." }, 502);
  }
}

async function restartServer(request, env) {
  if (!loginConfigured(env) || !await validSession(request, env)) return json({ error: "Sign in to Homebase before requesting a server restart." }, 401);
  if (!validRequestOrigin(request)) return json({ error: "Request origin check failed." }, 403);
  const endpoint = String(env.HOMEBASE_RESTART_URL || "").trim();
  const token = String(env.HOMEBASE_RESTART_TOKEN || "");
  if (!endpoint || token.length < 32) return json({ error: "Server restart is not configured yet. Set up the authenticated restart agent on your server first." }, 503);
  let url;
  try { url = new URL(endpoint); } catch { return json({ error: "Restart agent URL is invalid." }, 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return json({ error: "Restart agent must be an HTTPS URL without embedded credentials, query strings, or fragments." }, 503);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "authorization": "Bearer " + token, "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ action: "restart" }),
      signal: AbortSignal.timeout(5000),
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) return json({ error: "Restart agent redirected the request; no restart was confirmed." }, 502);
    if (!response.ok) return json({ error: "Restart agent rejected the request (HTTP " + response.status + ")." }, 502);
    return json({ accepted: true, message: "Restart request accepted. The server may take a few minutes to return." }, 202);
  } catch {
    return json({ error: "Could not reach the restart agent. No restart was confirmed." }, 502);
  }
}

export async function onRequest({ request, env }) {
  if (request.method === "GET") return getStorage(env);
  if (request.method === "POST") {
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "JSON request required." }, 415);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
    if (body?.action !== "restart") return json({ error: "Unsupported storage action." }, 400);
    return restartServer(request, env);
  }
  return json({ error: "Method not allowed." }, 405, { allow: "GET, POST" });
}

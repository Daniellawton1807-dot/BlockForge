const DEFAULT_GLANCES_URL = "https://glances.danielvault.uk";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});

const number = value => {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

export async function onRequest({ env, request }) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  // The dashboard calls this same-origin Pages route, so the browser does not
  // make a cross-origin request to Glances and Glances CORS settings do not apply.
  const base = String(env.GLANCES_BASE_URL || DEFAULT_GLANCES_URL).trim().replace(/\/+$/, "");
  let root;

  try {
    root = new URL(base);
  } catch {
    return json({ error: "GLANCES_BASE_URL must be a valid HTTPS URL." }, 503);
  }

  if (root.protocol !== "https:" || root.username || root.password) {
    return json({ error: "Glances must be configured with an HTTPS URL." }, 503);
  }

  const get = async path => {
    const url = new URL(path, root.origin + "/");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(7000),
      redirect: "error"
    });

    if (!response.ok) {
      let blockedByBrowserSignature = false;
      if ((response.headers.get("content-type") || "").includes("json")) {
        const body = await response.clone().json().catch(() => null);
        blockedByBrowserSignature = body?.error_code === 1010;
      }
      if (blockedByBrowserSignature) {
        throw new Error("Glances rejected the server request with Cloudflare Error 1010 (browser signature blocked).");
      }
      throw new Error("Glances " + path + " returned HTTP " + response.status + ".");
    }

    try {
      return await response.json();
    } catch {
      throw new Error("Glances " + path + " did not return valid JSON.");
    }
  };

  try {
    const [cpu, mem, fs] = await Promise.all([
      get("/api/4/cpu"),
      get("/api/4/mem"),
      get("/api/4/fs")
    ]);

    const filesystems = Array.isArray(fs) ? fs : [];
    const disk = filesystems.find(item => item?.mnt_point === "/mnt")
      || filesystems.find(item => item?.mnt_point === "/")
      || filesystems[0]
      || {};

    const metrics = {
      cpuPercent: number(cpu?.total),
      memoryPercent: number(mem?.percent),
      memoryUsedBytes: number(mem?.used),
      memoryTotalBytes: number(mem?.total),
      diskPercent: number(disk?.percent),
      diskUsedBytes: number(disk?.used),
      diskTotalBytes: number(disk?.size),
      diskMount: disk?.mnt_point || null
    };

    if (metrics.cpuPercent === null || metrics.memoryPercent === null
      || metrics.memoryUsedBytes === null || !metrics.memoryTotalBytes
      || metrics.diskPercent === null || metrics.diskUsedBytes === null
      || !metrics.diskTotalBytes) {
      return json({ error: "Glances returned incomplete CPU, memory, or filesystem metrics." }, 502);
    }

    return json(metrics);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Unable to read Glances metrics."
    }, 502);
  }
}

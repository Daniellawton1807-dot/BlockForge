const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
});
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const base = String(env.GLANCES_BASE_URL || "").replace(/\/+$/, "");
  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (!base || !clientId || !clientSecret) {
    return json({ error: "Monitoring is not configured. Set GLANCES_BASE_URL and Cloudflare Access service-token secrets in Pages settings." }, 503);
  }
  let root;
  try { root = new URL(base); } catch { return json({ error: "GLANCES_BASE_URL must be an HTTPS URL." }, 503); }
  if (root.protocol !== "https:") return json({ error: "Glances must be reached over HTTPS." }, 503);
  const headers = { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret, "accept": "application/json" };
  const get = async path => {
    const url = new URL(path, root.href.replace(/\/$/, "") + "/");
    if (url.origin !== root.origin) throw new Error("Invalid Glances endpoint");
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Glances returned " + response.status + " for " + path);
    return response.json();
  };
  try {
    const [cpu, mem, fs] = await Promise.all([get("/api/4/cpu"), get("/api/4/mem"), get("/api/4/fs")]);
    const filesystems = Array.isArray(fs) ? fs : [];
    const disk = filesystems.find(item => item.mnt_point === "/mnt") || filesystems.find(item => item.mnt_point === "/") || filesystems[0] || {};
    const total = number(mem.total), used = number(mem.used);
    const diskTotal = number(disk.size), diskUsed = number(disk.used);
    return json({
      cpuPercent: number(cpu.total),
      memoryPercent: number(mem.percent),
      memoryUsedBytes: used,
      memoryTotalBytes: total,
      diskPercent: number(disk.percent),
      diskUsedBytes: diskUsed,
      diskTotalBytes: diskTotal,
      diskMount: disk.mnt_point || null
    });
  } catch {
    return json({ error: "Unable to read Glances metrics. Check the tunnel, Access policy, and Glances API." }, 502);
  }
}
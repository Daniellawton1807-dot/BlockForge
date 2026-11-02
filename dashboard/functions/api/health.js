// Is each published app answering? Checked from Cloudflare against the public addresses in config.js, so
// "up" means reachable from the internet through the tunnel. Apps that only live on the home network
// (plain http://192.168…) can't be checked from here and come back as "local".
const SERVICES = {
  "Sonarr": "https://sonarr.danielvault.uk",
  "Sonarr Mum": "https://sonarrmum.danielvault.uk",
  "Radarr": "https://radarr.danielvault.uk",
  "Seerr": "https://seerr.danielvault.uk",
  "SABnzbd": "https://sab.danielvault.uk",
  "qBittorrent": "https://qb.danielvault.uk",
  "Jellyfin": "https://jellyfin.danielvault.uk",
  "CasaOS": "https://casa.danielvault.uk",
  "Crafty": "https://minecraft.danielvault.uk"
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" }
});

async function check(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "user-agent": "Homebase health check" } });
    // a login page, a redirect or "forbidden" all mean the app answered; 5xx (530 = tunnel down) means it didn't
    return { up: response.status < 500, status: response.status, ms: Date.now() - started };
  } catch {
    return { up: false, status: 0, ms: Date.now() - started };
  }
}

export async function onRequest({ request }) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  const names = Object.keys(SERVICES);
  const results = await Promise.all(names.map(name => check(SERVICES[name])));
  return json({ checkedAt: new Date().toISOString(), services: Object.fromEntries(names.map((name, i) => [name, results[i]])) });
}

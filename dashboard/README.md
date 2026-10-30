# Homebase homelab dashboard

How the pages, Functions, private bridge and tvbot fit together: see [ARCHITECTURE.md](ARCHITECTURE.md).

A static, responsive dashboard for self-hosted services. This project lives in `dashboard/` to avoid changing the existing BlockForge game files.

## Deploy

- Cloudflare Pages serves this directory; no build command is required.
- `config.js` contains the application shortcuts.
- The dashboard calls its same-origin Pages Function at `/api/metrics`; it never calls the Glances LAN address directly from the browser.

## Live metrics

The Pages Function reads `GLANCES_BASE_URL` from the Pages environment when set, otherwise it uses `https://glances.danielvault.uk`. It fetches Glances `/api/4/cpu`, `/api/4/mem`, and `/api/4/fs` over HTTPS and returns normalized CPU, RAM, and storage values. The dashboard refreshes every 10 seconds.

Because the browser calls the same-origin `/api/metrics` route, browser CORS does not apply to the server-side Glances requests. The function enforces HTTPS, rejects redirects, requires valid JSON, uses a bounded timeout, disables caching, and displays errors instead of inventing metrics.

This version does not use Cloudflare Access or service tokens. Anyone who can access the Homebase metrics endpoint can read the returned server metrics. If Cloudflare rejects server-side requests with Error 1010, the Glances zone's Browser Integrity Check is blocking the request; the zone owner must decide whether to create a narrow exception for the metrics route.

## Metric mapping

- CPU: Glances `cpu.total`
- RAM: Glances `mem.percent`, `mem.used`, and `mem.total`
- Storage: filesystem `/mnt` if available, otherwise `/`, otherwise the first filesystem Glances returns.

Do not expose Docker sockets or credentials through the dashboard.

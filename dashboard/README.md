# Homebase homelab dashboard

A static, responsive dashboard for self-hosted services. This project lives in `dashboard/` to avoid changing the existing BlockForge game files.

## Deploy
- Cloudflare Pages serves this directory; no build command is required.
- `config.js` contains the application shortcuts.
- The dashboard calls its same-origin Pages Function at `/api/metrics`; it never calls the Glances LAN address directly from the browser.

## Secure live metrics setup
The metrics function requires these Cloudflare Pages environment variables (Production, and Preview only if needed):
- `GLANCES_BASE_URL`: the HTTPS origin of a dedicated Cloudflare Tunnel published hostname for Glances, for example `https://glances-api.danielvault.uk` (no `/api/4` suffix).
- `CF_ACCESS_CLIENT_ID`: Cloudflare Access service-token client ID.
- `CF_ACCESS_CLIENT_SECRET`: Cloudflare Access service-token client secret.

Important setup sequence:
1. Publish Glances on a dedicated Tunnel hostname, forwarding to `http://192.168.8.150:61208`.
2. Protect that hostname with a Cloudflare Access self-hosted application/policy that requires a service token. Do not leave Glances publicly accessible: its current server has no API authentication and its logs warn about permissive CORS.
3. Create a Cloudflare Access service token and store its client ID and secret only as Pages environment variables. Never commit these secrets to GitHub or put them in `config.js`.
4. Add the three environment variables in Cloudflare Pages project settings and redeploy.
5. Test `/api/metrics` on the deployed Homebase site. The CPU, memory and `/mnt` filesystem values refresh every 10 seconds.

The Pages Function requests Glances `/api/4/cpu`, `/api/4/mem`, and `/api/4/fs` from the server-side, behind Access. It returns only normalized metrics to the browser. It has a five-second timeout and does not expose the Access service-token headers.

## Metric mapping
- CPU: Glances `cpu.total`
- RAM: Glances `mem.percent`, `mem.used`, `mem.total`
- Storage: filesystem `/mnt` if available, otherwise `/`, otherwise the first filesystem Glances returns.

Do not expose Docker sockets or an unauthenticated Glances endpoint publicly.

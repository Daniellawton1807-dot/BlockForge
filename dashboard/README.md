# Homebase homelab dashboard

A static, responsive dashboard for your self-hosted services. This is intentionally kept in `dashboard/` so it does not overwrite the existing BlockForge files.

## Preview / deploy
- The entry point is `index.html`; no build step is required.
- For Cloudflare Pages, configure the project to deploy the `dashboard` directory as the build output directory, with no build command, or deploy this directory as a separate Pages project.
- Set your service URLs in `config.js` (copy `config.example.js`). Until configured, application cards show their names and setup state.

## Live metrics
CPU, RAM, storage, and service counts are designed to read JSON from `metricsEndpoint`. No fake measurements are displayed when the endpoint is not configured. A server-side monitoring agent and a securely authenticated/restricted HTTPS endpoint still need to be installed/configured. Do not expose Docker sockets or unauthenticated metrics endpoints publicly, and do not put API keys in this static frontend.

Expected metrics JSON example:
```json
{
  "cpuPercent": 23,
  "memoryPercent": 61,
  "memoryUsedBytes": 6553600000,
  "memoryTotalBytes": 10737418240,
  "diskPercent": 48,
  "diskUsedBytes": 500000000000,
  "diskTotalBytes": 1000000000000,
  "uptimeSeconds": 86400,
  "services": {"sonarr": true, "radarr": true}
}
```
This is a schema example only, not real server data.

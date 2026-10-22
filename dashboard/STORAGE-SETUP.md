# Homebase Storage page setup

The Storage page is available at `/storage/`. It reads filesystem and disk I/O information through the existing Glances endpoint at `GLANCES_BASE_URL` (or `https://glances.danielvault.uk` by default).

## What the page can show

- Mounted filesystems reported by Glances, mount paths, filesystem type, and capacity.
- Disk I/O counters if the Glances `/api/4/diskio` endpoint exposes matching devices.
- A 30-second refresh.

Glances filesystem data is not a complete physical-drive inventory and does not provide dependable SMART health. For that, install a server-side inventory agent that can safely run `lsblk` and `smartctl`, with any needed device permissions.

## Server restart button

The button is deliberately guarded. Cloudflare Pages cannot directly reboot a machine on the private LAN. To enable it, install a small HTTPS restart agent on the server that accepts only an authenticated restart action and executes a fixed, allowlisted reboot command. Do not expose SSH, a shell, or a generic command endpoint to the internet.

Configure these Cloudflare Pages environment variables after that agent is deployed:

- `HOMEBASE_RESTART_URL`: the HTTPS URL of the restart agent.
- `HOMEBASE_RESTART_TOKEN`: a random secret of at least 32 characters, matching the agent's expected bearer token.

The request from Homebase also requires a valid Homebase media-session cookie and same-origin request. Until the agent and variables are configured, the button returns an explicit setup error and will not pretend a reboot occurred.

Before enabling remote restarts, ensure ZimaOS/server starts automatically after reboot and that your media drives remount reliably. Rebooting can interrupt downloads and file writes; investigate logs and drive health when possible.

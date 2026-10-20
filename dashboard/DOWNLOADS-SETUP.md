# Homebase downloads setup

The dashboard calls the same-origin `/api/downloads` Pages Function. A Homebase username and password protect the queue. A successful sign-in creates a signed, HttpOnly, Secure, SameSite=Strict cookie scoped to the downloads API. The optional “Remember me on this device” choice makes that cookie last 30 days; without it, the browser keeps a session cookie with a 12-hour signed expiry. The password itself is never saved in the browser, local storage, frontend JavaScript, or GitHub.

## Homebase sign-in secrets

In Cloudflare Pages, open the `homebase-dash-dashboard` project, then Settings > Variables and Secrets for the production environment. Add these as encrypted secrets:

- `HOMEBASE_DOWNLOADS_USERNAME`: the username you will enter in the dashboard form
- `HOMEBASE_DOWNLOADS_PASSWORD`: the matching password
- `HOMEBASE_DOWNLOADS_SESSION_SECRET`: a randomly generated secret with at least 32 bytes

Do not put any of these values in the repository or paste them into frontend settings. After saving them, trigger a production deployment so the Pages Functions receive the values. The sign-in form stays locked until all three values are present.

## Downloader secrets

Add these in the same production environment. Mark credentials and API keys as encrypted secrets:

- `QBITTORRENT_USERNAME` (secret)
- `QBITTORRENT_PASSWORD` (secret)
- `SABNZBD_API_KEY` (secret)
- `QBITTORRENT_BASE_URL` (optional; defaults to `https://qb.danielvault.uk`)
- `SABNZBD_BASE_URL` (optional; defaults to `https://sab.danielvault.uk`)

The Pages Function uses those values server-side to read qBittorrent and SABnzbd. It returns sanitized queue names, progress percentages, and ETAs only after a valid Homebase sign-in. The dashboard refreshes the queue on its existing 10-second interval.

Cloudflare Access is not used by this downloads login.

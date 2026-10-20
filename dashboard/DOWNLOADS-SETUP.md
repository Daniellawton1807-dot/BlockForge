# Private downloads panel setup

The dashboard calls the same-origin `/api/downloads` Pages Function. The function validates a Cloudflare Access application JWT before it contacts either downloader. Download names, queue progress, and ETAs are not returned to unauthenticated visitors. The UI refreshes this panel on the dashboard's existing 10-second interval.

## Cloudflare Access

Create a self-hosted Access application for the exact path:

```
dashboard.danielvault.uk/api/downloads*
```

Add an Allow policy for only the account that should see the queue. The dashboard page can remain public; only this API path needs the Access policy. Copy the application's Audience (AUD) tag and note the team domain.

Set these Pages production variables:

- `CF_ACCESS_TEAM_DOMAIN`: your team domain, such as `your-team.cloudflareaccess.com`
- `CF_ACCESS_AUD`: the Audience tag for the path-scoped Access application

## Downloader variables

Set these in Cloudflare Pages > Settings > Variables and Secrets for the production environment. Mark credentials and API keys as encrypted secrets.

- `QBITTORRENT_USERNAME` (secret)
- `QBITTORRENT_PASSWORD` (secret)
- `SABNZBD_API_KEY` (secret)
- `QBITTORRENT_BASE_URL` (optional; defaults to `https://qb.danielvault.uk`)
- `SABNZBD_BASE_URL` (optional; defaults to `https://sab.danielvault.uk`)

The secrets are used only by the Pages Function. They are not added to GitHub files or sent to browser JavaScript. Until Access and the downloader credentials are configured, the panel stays disabled and does not request queue data.

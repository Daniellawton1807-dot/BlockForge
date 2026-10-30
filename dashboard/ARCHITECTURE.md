# How Homebase fits together

A map for whoever works on this next (people or AI sessions), so nobody has to rediscover it.
No secret values live here or anywhere in this public repo, only the names of Cloudflare secrets.

## Pages and files

| URL | Files | What it is |
| --- | --- | --- |
| `/` | `index.html`, `app.js`, `polish.js`, `style.css` | Overview: Glances metrics, activity feed, app grid |
| `/media/` | `media/index.html`, `hub-media.js` | Media hub: For You, Coming up, Library, Downloads, search, title sheets |
| `/media/classic/` | `media/classic/index.html`, `media.js` | The previous media page, kept as a fallback |
| `/remote/` | `remote/index.html`, `remote.js` | TV remote: now playing, transport, commands, D-pad/touchpad |
| shared | `hub.js`, `hub.css` | `window.Hub`: sign-in gate, theme, icons, sheet (closes on Back), toast, `api()`, skeletons, rails |

No build step. **Cache busting is manual:** bump the `?v=` on the `<script>`/`<link>` tags in the HTML when you change a JS/CSS file, or browsers keep the old one.
Everything is rendered with `textContent`, never `innerHTML` from data.

## Server side (Cloudflare Pages Functions, `functions/api/`)

All of these except `/api/metrics` need the Homebase session cookie (`functions/_utils/downloads-auth.js`).

| Route | Purpose |
| --- | --- |
| `downloads/login`, `logout`, `session` | One shared Homebase sign-in, HMAC cookie on `/api` |
| `downloads` | GET: qBittorrent + SABnzbd queues, merged with the Sonarr/Radarr queues (stage: downloading, waiting to import, importing, import blocked, imported) and recent history. POST: pause/resume/remove/replace |
| `media/config`, `library`, `search`, `add`, `details`, `manage`, `releases`, `recent`, `calendar` | Sonarr (3 instances) and Radarr, via the bridge |
| `tv/[[path]]` | The TV remote, proxied to tvbot via the bridge. Allowed: GET `api/status`, `api/foryou`, `api/locate`, `img/{id}`; POST `api/key`, `api/type`, `api/seek`, `api/playhere`, `cmd` |
| `metrics` | Glances, public by design |

## The private bridge

Home services are never exposed to the internet for Homebase. Pages calls the Worker
`workers/homebase-arr-bridge` through the `ARR_BRIDGE` service binding, and the Worker reaches
`192.168.8.150` over **Workers VPC** services on the home Cloudflare Tunnel:

| Binding | Service | Port |
| --- | --- | --- |
| `VPC_SONARR_DANIEL` / `_MUM` / `_EXTRA` | Sonarr | 8989 / 8990 / 8991 |
| `VPC_RADARR` | Radarr | 7878 |
| `VPC_TVBOT` (`homebase-tvbot`) | tvbot | 8765 |

The Worker only forwards allow-listed paths (`SAFE_PATHS` in `src/index.js`). **A new tvbot route
needs adding in three places:** tvbot itself, `SAFE_PATHS.tvbot` in the bridge, and `ROUTES` in
`functions/api/tv/[[path]].js`. Then redeploy the Worker:

```sh
cd workers/homebase-arr-bridge && npx wrangler deploy   # needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

Pages itself deploys automatically from `main` (branches get preview URLs, but previews have no secrets,
so sign-in doesn't work there).

## Cloudflare secrets (Pages, production)

`HOMEBASE_DOWNLOADS_*` (sign-in), `SONARR_DANIEL_API_KEY`, `SONARR_MUM_API_KEY`, `SONARR_EXTRA_API_KEY`,
`RADARR_API_KEY`, `SABNZBD_API_KEY`, qBittorrent credentials, and `TVBOT_TOKEN`. tvbot rejects a wrong
token with 401 (shown as "tvbot rejected Homebase's token"). Secrets only apply to deployments made
after they're saved, so retry the latest deployment after changing one.

## tvbot (not in this repo)

A small Python service on the server (`~/tvbot`, Docker, port 8765) that drives the TVs (Fire TVs over adb, the
Apple TV over pyatv) and talks to Jellyfin. Routes Homebase uses:

- `GET /api/status?tv=` now playing; `GET /api/foryou` recommendations from watch history (Seerr), with poster and backdrop
- `GET /api/locate?ref=&season=&episode=` Jellyfin item id; `ref` is `tvdb:<id>`, `tmdb:<id>` or a name
- `POST /cmd {text}` plain English ("play tvdb:428163 season 5 episode 1 in the living room")
- `POST /api/playhere {ref, season, episode, kind: app|web, device: iphone|ipad|android}` arms a two-minute
  server-side watcher that sends PlayNow to that device's Jellyfin app once it connects (resuming), never a TV

Play by id, not title: Jellyfin names both the UK and US "The Traitors" just "The Traitors".

## Media hub behaviour worth knowing

- **Play:** "This device" on a phone opens the Jellyfin iOS app (`org.jellyfin.expo://`) and tvbot starts playback.
  On a computer it opens the title's Jellyfin page, because browsers won't autoplay in an unclicked tab.
  Picking a TV sends `play …` to tvbot.
- **Downloads** refresh in place (no fade) and show Grabbed → Downloading → Importing → Imported.
  The show sheet follows its episodes' downloads live every 3 s while open.
- **After a request** the sheet turns into the title's manage view; grabbing a release jumps to Downloads and highlights it.

## Checking a change

There are no automated tests. What has worked: serve `dashboard/` with Playwright, mock the `/api/*`
responses (`page.route`), and screenshot each view at 1440×900 and 390×844 in dark and light themes,
checking for console errors and horizontal overflow (`document.documentElement.scrollWidth > innerWidth`).

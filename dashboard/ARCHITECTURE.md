# How Homebase fits together

A map for whoever works on this next (people or AI sessions), so nobody has to rediscover it.
No secret values live here or anywhere in this public repo, only the names of Cloudflare secrets.

## Pages and files

| URL | Files | What it is |
| --- | --- | --- |
| `/` | `index.html`, `app.js`, `polish.js`, `style.css` | Overview: Glances metrics, activity feed, app grid |
| `/media/` | `media/index.html`, `hub-media.js` | Media hub: For You, Coming up, Library, Downloads, Autopilot, search, title sheets |
| `/media/classic/` | `media/classic/index.html`, `media.js` | The previous media page, kept as a fallback |
| `/remote/` | `remote/index.html`, `remote.js` | TV remote: now playing, transport, commands, D-pad/touchpad |
| `/mum/` | `mum/index.html`, `mum.js`, `mum.css`, manifest + icons | Mum's request page (not linked anywhere), installed on her Samsung as a home-screen app |
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
| `autopilot` | GET rules, last check, log; POST `{action:"run"}` checks now, `{action:"settings", rules}` switches rules |
| `autopilot/run` | The scheduled run (POST with `x-autopilot-token`, no cookie; the Worker confirms the token) |
| `storage` | GET drives, fill-up forecast and suggestions (`?summary=1`: drives + forecast only, for the Overview tile); POST `{action:"delete", confirm:true, items}` removes picked titles with their files |
| `mum/setup`, `home`, `search`, `request` | Mum's page. Own cookie (`homebase_mum`, path `/api/mum`, ~13 months, renews itself), set once by Daniel's sign-in on her phone; it can't open the rest of Homebase |
| `metrics` | Glances, public by design (Glances only sees the system disk) |

## The private bridge

Home services are never exposed to the internet for Homebase. Pages calls the Worker
`workers/homebase-arr-bridge` through the `ARR_BRIDGE` service binding, and the Worker reaches
`192.168.8.150` over **Workers VPC** services on the home Cloudflare Tunnel:

| Binding | Service | Port |
| --- | --- | --- |
| `VPC_SONARR_DANIEL` / `_MUM` / `_EXTRA` | Sonarr | 8989 / 8990 / 8991 |
| `VPC_RADARR` | Radarr | 7878 |
| `VPC_TVBOT` (`homebase-tvbot`) | tvbot | 8765 |

The Worker also has a KV namespace `AUTOPILOT` (`homebase-autopilot`) and a cron trigger every 15 minutes, see Autopilot below.

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
- `GET /api/discover` Seerr trending (or `?q=` a search), trimmed to poster cards; `GET /api/foryou?user=Mum` her picks
  (only users in config `foryou_users`, default Mum)
- `GET /api/mumfilms` folders in Mum's films (and ones being shared); `POST /api/sharefilm {folder}` shares one of Daniel's
- `GET /api/watchdata` every film/series per Jellyfin user (except Admin): played, % watched, started. Each user only
  sees their own libraries, so "watched by everyone" means everyone who can see it. Cached 10 min. Pages calls it
  directly from `functions/api/storage.js` (bridge `SAFE_PATHS` allows it), not through `/api/tv`
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

## Autopilot (`functions/_utils/autopilot.js`, `functions/api/storage.js`)

Plan: `AUTOPILOT.md` in Daniel's vault folder. **Self-healing downloads**, every 15 minutes (Worker cron → `POST /api/autopilot/run`)
or "Check now" on the Autopilot tab:
- *Stalled:* a qBittorrent torrent in `stalledDL`/`metaDL` with no activity for 60 min, or a failed job → Sonarr/Radarr
  `DELETE queue/{id}?removeFromClient&blocklist&skipRedownload=false` (blocklist, then they search again). Skipped when
  qBittorrent is disconnected or every torrent is stalled at once (VPN down), which is listed under Needs you instead.
- *Import blocked:* "not an upgrade" → removed from client and queue (no blocklist); sample/no video/suspicious file →
  blocklist and replace; anything else → Needs you, in plain English (`plainReason`, also used on Downloads rows).
- *Re-search:* monitored, aired, missing episodes/films → `EpisodeSearch`/`MoviesSearch` after 1 h, 6 h, 1 day, 3 days,
  then weekly; at most 10 per instance per run. At most 6 queue removals per run. Library files are never deleted.
- State (rule switches, last 150 log entries, back-off) is one JSON value in KV, read and written through the bridge
  (`x-homebase-service: autopilot`, paths `state` GET/PUT and `verify`). The Worker has no public route, so only Pages reaches it.
- The cron needs the Worker secret `AUTOPILOT_TOKEN`; without it the schedule does nothing.

**Storage planner:** drives come from Sonarr/Radarr `diskspace` (grouped by size, so `/Server`, `/movies`… are one drive);
the forecast is the last 30 days of `downloadFolderImported` sizes. Suggestions (finished by everyone who can see it,
not started in 90+ days, the same show in two Sonarrs, oversized) skip anything imported in the last 30 days or aired in
the last 60. Nothing is removed until Daniel ticks titles and confirms in a sheet.

## Mum's request page (`functions/_utils/mum.js`)

Recommended (tvbot `api/foryou?user=Mum`: her Jellyfin history minus Zayah's library and kids' genres, plus anchors
like The Night Agent, Reacher and Tyler Perry; drama/soap/action/crime boosted, every third pick a film; tuned in
`FORYOU_PROFILES` in tvbot), trending
(tvbot `api/discover`, Seerr trending) and search (tvbot `api/discover?q=`). Request adds shows to **Sonarr Mum**
(its `/mum tv` root, her usual quality profile, monitor all, search now) and films to **Radarr** with the
`/Server/Media/Movies - Mum` root folder. Status per title: request / coming soon / on your TV. A film Daniel already has can't go into Radarr
twice, so Request asks tvbot (`POST api/sharefilm {folder}`) to hardlink its folder from `Movies - Daniel` into
`Movies - Mum` (same NTFS drive: instant, no extra space; copies only if a link fails) and rescan her Jellyfin
films library. tvbot mounts the drive's `Media` folder at `/library` for this. Private films never appear.

## Checking a change

There are no automated tests. What has worked: serve `dashboard/` with Playwright, mock the `/api/*`
responses (`page.route`), and screenshot each view at 1440×900 and 390×844 in dark and light themes,
checking for console errors and horizontal overflow (`document.documentElement.scrollWidth > innerWidth`).

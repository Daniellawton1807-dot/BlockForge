/* Homebase Media hub. Requests and queue details are proxied through authenticated Pages Functions. */
const config = window.HOMEBASE_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const endpoints = {
  queue: "/api/downloads",
  login: "/api/downloads/login",
  logout: "/api/downloads/logout",
  seerrConfig: "/api/downloads/seerr/config",
  search: "/api/downloads/seerr/search",
  request: "/api/downloads/seerr/request"
};
let authenticated = false;
let seerrReady = false;
let downloadsFetchInFlight = false;
let targetMap = Object.create(null);
let lastSearchResults = [];

function safeUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
function formatEta(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds)));
  if (!Number.isFinite(value)) return "Calculating";
  if (value < 60) return value + "s";
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value % 86400 / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  const parts = [];
  if (days) parts.push(days + "d");
  if (hours || days) parts.push(hours + "h");
  if (minutes || hours || days) parts.push(String(minutes).padStart(2, "0") + "m");
  parts.push(String(remainder).padStart(2, "0") + "s");
  return parts.join(" ");
}
function downloadCard(item, updatedAt) {
  const raw = Number(item.progress);
  const progress = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const status = String(item.status || "In queue");
  const hasEta = item.etaSeconds !== null && item.etaSeconds !== undefined && Number.isFinite(Number(item.etaSeconds));
  const seconds = hasEta ? Math.max(0, Math.floor(Number(item.etaSeconds))) : null;
  const eta = hasEta ? formatEta(seconds) : (/queued/i.test(status) ? "Pending" : /paused/i.test(status) ? "Paused" : /stalled/i.test(status) ? "Waiting" : "Calculating");
  const etaLabel = hasEta
    ? '<span class="download-eta" data-eta-seconds="' + seconds + '" data-eta-started="' + updatedAt + '">ETA ' + esc(eta) + '</span>'
    : '<span>ETA ' + esc(eta) + '</span>';
  const title = String(item.name || "Untitled download");
  return '<article class="download-card"><div class="download-card-header"><span class="download-source">' + esc(item.source || "Downloader") + '</span><span class="download-state">' + esc(status) + '</span></div><h4 class="download-name" title="' + esc(title) + '">' + esc(title) + '</h4><div class="download-progress" role="progressbar" aria-label="' + esc(title) + ' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(progress) + '"><span style="width:' + progress + '%"></span></div><div class="download-facts"><span>' + esc(item.category || "Download") + '</span><strong>' + Math.round(progress) + '%</strong>' + etaLabel + '</div></article>';
}
function showLogin(message) {
  authenticated = false;
  $("mediaAccess").hidden = false;
  $("downloadLoginForm").hidden = false;
  $("mediaAuthMessage").textContent = message;
  $("downloadsPrivate").hidden = true;
  $("downloadsLocked").hidden = false;
  $("downloadSummary").textContent = "Sign-in required";
  $("downloadList").innerHTML = "";
  $("seerrConnectionLabel").textContent = "Sign in required";
  $("mediaSearchButton").disabled = true;
  $("mediaSearch").disabled = true;
  $("tvTargetSelect").disabled = true;
  $("movieTargetSelect").disabled = true;
  $("mediaSearchMessage").textContent = "Sign in above to search and request media.";
}
function showUnlocked() {
  authenticated = true;
  $("mediaAccess").hidden = true;
  $("downloadsPrivate").hidden = false;
  $("downloadsLocked").hidden = true;
  $("downloadSummary").textContent = "Loading queue…";
}
function setSeerrUnavailable(message) {
  seerrReady = false;
  $("seerrConnectionLabel").textContent = "Seerr unavailable";
  $("seerrStatus").textContent = message;
  $("seerrStatus").className = "media-status is-error";
  $("mediaSearchButton").disabled = true;
  $("mediaSearch").disabled = true;
  $("tvTargetSelect").disabled = true;
  $("movieTargetSelect").disabled = true;
  $("mediaSearchMessage").textContent = message.includes("SEERR_API_KEY")
    ? "Add the protected SEERR_API_KEY secret to enable search and requests."
    : "Media requests are unavailable while Seerr is disconnected.";
  $("mediaSearchMessage").className = "media-status is-error";
}
function populateTargets(data) {
  targetMap = Object.create(null);
  const sonarr = Array.isArray(data.sonarr) ? data.sonarr : [];
  const radarr = Array.isArray(data.radarr) ? data.radarr : [];
  const tvSelect = $("tvTargetSelect");
  const movieSelect = $("movieTargetSelect");
  tvSelect.innerHTML = '<option value="">Choose a Sonarr instance…</option>';
  movieSelect.innerHTML = '<option value="">Choose a Radarr folder…</option>';

  sonarr.forEach(server => {
    const id = Number(server.id);
    if (!Number.isSafeInteger(id)) return;
    const key = "tv:" + id;
    targetMap[key] = { type: "tv", id, activeDirectory: String(server.activeDirectory || server.rootFolders?.[0]?.path || "") };
    const option = document.createElement("option");
    option.value = key;
    option.textContent = String(server.name || "Sonarr") + (server.is4k ? " · 4K" : "");
    if (server.isDefault) option.selected = true;
    tvSelect.appendChild(option);
  });

  radarr.forEach(server => {
    const id = Number(server.id);
    if (!Number.isSafeInteger(id)) return;
    const name = String(server.name || "Radarr") + (server.is4k ? " · 4K" : "");
    const folders = Array.isArray(server.rootFolders) ? server.rootFolders : [];
    folders.forEach((folder, index) => {
      const path = String(folder.path || "");
      if (!path) return;
      const key = "movie:" + id + ":" + index;
      targetMap[key] = { type: "movie", id, rootFolder: path };
      const option = document.createElement("option");
      option.value = key;
      option.textContent = name + " — " + path;
      if (server.isDefault && path === server.activeDirectory) option.selected = true;
      movieSelect.appendChild(option);
    });
  });

  tvSelect.disabled = sonarr.length === 0;
  movieSelect.disabled = movieSelect.options.length <= 1;
  $("tvTargetWrap").classList.toggle("is-empty", sonarr.length === 0);
  $("movieTargetWrap").classList.toggle("is-empty", movieSelect.options.length <= 1);
  $("seerrStatus").textContent = sonarr.length + " Sonarr destination" + (sonarr.length === 1 ? "" : "s") + " · " + radarr.length + " Radarr instance" + (radarr.length === 1 ? "" : "s") + " ready.";
  $("seerrStatus").className = "media-status is-success";
  $("seerrConnectionLabel").textContent = "Connected";
  seerrReady = true;
  $("mediaSearchButton").disabled = false;
  $("mediaSearch").disabled = false;
  $("mediaSearchMessage").textContent = "Choose the destination for each type, then search.";
  $("mediaSearchMessage").className = "media-status";
}
async function readResponse(response) {
  const data = await response.json().catch(() => null);
  return { response, data };
}
async function loadSeerrTargets() {
  try {
    const result = await readResponse(await fetch(endpoints.seerrConfig, { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Sign in to use media requests and view downloads.");
      return false;
    }
    if (result.data?.code === "login_setup_required") {
      showLogin("The Homebase sign-in is not configured in Cloudflare Pages yet.");
      return false;
    }
    showUnlocked();
    if (!result.response.ok) {
      if (result.data?.code === "seerr_setup_required") {
        setSeerrUnavailable("Set SEERR_API_KEY as a Secret in Cloudflare Pages Production, then redeploy. Keep it out of GitHub.");
        return true;
      }
      setSeerrUnavailable(result.data?.error || "Could not connect to Seerr. Check its URL and API key in Cloudflare Pages.");
      return true;
    }
    populateTargets(result.data || {});
    if (Array.isArray(result.data?.radarr) && result.data.radarr.some(server => !server.rootFolderListAvailable)) {
      $("seerrStatus").textContent += " Some Radarr roots use Seerr’s configured default because its root-folder lookup was unavailable.";
    }
    if (!Array.isArray(result.data?.sonarr) || !result.data.sonarr.length) {
      $("tvTargetWrap").classList.add("is-empty");
    }
    if (!Array.isArray(result.data?.radarr) || !result.data.radarr.length) {
      $("movieTargetWrap").classList.add("is-empty");
    }
    return true;
  } catch {
    showUnlocked();
    setSeerrUnavailable("Could not reach Seerr. Check its Cloudflare URL and API key configuration.");
    return true;
  }
}
function renderDownloads(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const warnings = sources.filter(source => !source.connected).map(source => esc(source.name) + ": " + esc(source.message || "Unavailable"));
  $("downloadSummary").textContent = items.length + " active " + (items.length === 1 ? "download" : "downloads");
  if (items.length) {
    $("downloadList").innerHTML = items.map(item => downloadCard(item, Date.now())).join("") + (warnings.length ? '<div class="download-warning">' + warnings.join(" · ") + "</div>" : "");
  } else if (sources.length && sources.every(source => source.connected)) {
    $("downloadList").innerHTML = '<div class="downloads-empty">No active downloads right now.</div>';
  } else {
    $("downloadList").innerHTML = '<div class="downloads-empty">The download queue is unavailable right now.</div>' + (warnings.length ? '<div class="download-warning">' + warnings.join(" · ") + "</div>" : "");
  }
}
async function refreshDownloads() {
  if (!authenticated || downloadsFetchInFlight) return;
  downloadsFetchInFlight = true;
  try {
    const result = await readResponse(await fetch(endpoints.queue, { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok || !Array.isArray(result.data?.items)) {
      $("downloadSummary").textContent = "Unavailable";
      $("downloadList").innerHTML = '<div class="downloads-empty">Could not load the download queue.</div>';
      return;
    }
    renderDownloads(result.data);
  } catch {
    $("downloadSummary").textContent = "Unavailable";
    $("downloadList").innerHTML = '<div class="downloads-empty">Could not reach the download services.</div>';
  } finally {
    downloadsFetchInFlight = false;
  }
}
async function submitLogin(event) {
  event.preventDefault();
  const form = $("downloadLoginForm");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  $("mediaAuthMessage").textContent = "Signing in…";
  try {
    const result = await readResponse(await fetch(endpoints.login, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        username: $("downloadUsername").value,
        password: $("downloadPassword").value,
        remember: $("downloadRemember").checked
      })
    }));
    if (!result.response.ok) {
      if (result.data?.code === "login_setup_required") $("mediaAuthMessage").textContent = "The Homebase sign-in is not configured in Cloudflare Pages.";
      else if (result.response.status === 401) $("mediaAuthMessage").textContent = "Username or password is incorrect.";
      else $("mediaAuthMessage").textContent = "Could not sign in. Try again.";
      return;
    }
    $("downloadPassword").value = "";
    showUnlocked();
    await loadSeerrTargets();
    await refreshDownloads();
  } catch {
    $("mediaAuthMessage").textContent = "Could not reach the sign-in service. Try again.";
  } finally {
    button.disabled = false;
  }
}
async function lockMedia() {
  const button = $("downloadLogout");
  button.disabled = true;
  try {
    const response = await fetch(endpoints.logout, { method: "POST", credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Sign out failed.");
    targetMap = Object.create(null);
    lastSearchResults = [];
    $("mediaResults").innerHTML = '<div class="media-empty">Sign in to search for a title.</div>';
    showLogin("This device is signed out. Sign in to manage media.");
  } catch {
    $("downloadSummary").textContent = "Could not lock media";
  } finally {
    button.disabled = false;
  }
}
function mediaTypeName(type) {
  return type === "tv" ? "TV show" : "Movie";
}
function renderSearchResults(items) {
  lastSearchResults = items;
  if (!items.length) {
    $("mediaResults").innerHTML = '<div class="media-empty">No movies or shows matched that search.</div>';
    return;
  }
  $("mediaResults").innerHTML = items.map((item, index) => {
    const type = item.mediaType === "tv" ? "tv" : "movie";
    const rawDate = String(item.releaseDate || "");
    const year = /^\d{4}/.test(rawDate) ? rawDate.slice(0, 4) : "";
    const posterPath = typeof item.posterPath === "string" && /^\/[A-Za-z0-9_./-]+$/.test(item.posterPath) ? item.posterPath : "";
    const poster = posterPath
      ? '<img src="https://image.tmdb.org/t/p/w185' + esc(posterPath) + '" alt="" loading="lazy">'
      : '<span>' + (type === "tv" ? "TV" : "M") + "</span>";
    const targetSelect = type === "tv" ? $("tvTargetSelect") : $("movieTargetSelect");
    const hasTarget = targetSelect.options.length > 1;
    const label = type === "tv" ? "Request show" : "Request movie";
    const actionLabel = hasTarget ? label : "Destination unavailable";
    return '<article class="media-result"><div class="media-result-art">' + poster + '</div><div class="media-result-copy"><div class="media-result-meta"><span class="media-type-chip">' + mediaTypeName(type) + '</span>' + (year ? '<span>' + esc(year) + '</span>' : "") + '</div><h4>' + esc(item.title || "Untitled") + '</h4><p>' + esc(item.overview || "No summary available.") + '</p><div class="media-result-actions"><span class="media-destination-hint">' + (hasTarget ? "Destination selected above" : "Configure a destination in Seerr") + '</span><button class="media-primary-button request-button" data-request-index="' + index + '" type="button" ' + (hasTarget ? "" : "disabled") + '>' + actionLabel + '</button></div><div class="request-feedback" aria-live="polite"></div></div></article>';
  }).join("");
}
async function searchMedia(event) {
  event.preventDefault();
  if (!authenticated || !seerrReady) {
    $("mediaSearchMessage").textContent = "Seerr is not ready yet. Check the setup message above.";
    return;
  }
  const query = $("mediaSearch").value.trim();
  if (query.length < 2) {
    $("mediaSearchMessage").textContent = "Enter at least two characters to search.";
    return;
  }
  $("mediaSearchButton").disabled = true;
  $("mediaSearchMessage").textContent = "Searching Seerr…";
  $("mediaResults").innerHTML = '<div class="media-empty">Searching…</div>';
  try {
    const result = await readResponse(await fetch(endpoints.search + "?q=" + encodeURIComponent(query), { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok) throw new Error(result.data?.error || "Seerr search failed.");
    renderSearchResults(Array.isArray(result.data?.results) ? result.data.results : []);
    $("mediaSearchMessage").textContent = "Choose the Sonarr instance or Radarr root folder above, then submit a request.";
  } catch (error) {
    $("mediaResults").innerHTML = '<div class="media-empty">Search failed. ' + esc(error.message || "Try again.") + '</div>';
    $("mediaSearchMessage").textContent = "Seerr search is unavailable.";
  } finally {
    $("mediaSearchButton").disabled = !seerrReady;
  }
}
async function requestMedia(button) {
  const index = Number(button.dataset.requestIndex);
  const item = lastSearchResults[index];
  if (!item || !authenticated) return;
  const type = item.mediaType === "tv" ? "tv" : "movie";
  const targetSelect = type === "tv" ? $("tvTargetSelect") : $("movieTargetSelect");
  const target = targetMap[targetSelect.value];
  const feedback = button.closest(".media-result").querySelector(".request-feedback");
  if (!target) {
    feedback.textContent = "Choose a destination first.";
    return;
  }
  button.disabled = true;
  button.textContent = "Sending…";
  feedback.textContent = "";
  const body = { mediaType: type, mediaId: Number(item.id), targetId: target.id };
  if (type === "movie") body.rootFolder = target.rootFolder;
  if (item.tvdbId) body.tvdbId = Number(item.tvdbId);
  try {
    const result = await readResponse(await fetch(endpoints.request, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body)
    }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok) throw new Error(result.data?.error || "Seerr could not submit that request.");
    button.textContent = "Requested";
    button.classList.add("is-complete");
    feedback.textContent = "Request submitted to Seerr.";
  } catch (error) {
    button.disabled = false;
    button.textContent = type === "tv" ? "Request show" : "Request movie";
    feedback.textContent = error.message || "Request failed. Try again.";
  }
}
function renderServiceLinks() {
  const services = Array.isArray(config.services) ? config.services : [];
  const items = services.filter(service => ["media", "downloads"].includes(service.group));
  $("mediaApps").innerHTML = items.map(service => {
    const url = safeUrl(service.url);
    const tone = ["purple", "blue", "orange", "green"].includes(service.tone) ? service.tone : "purple";
    const icon = esc(service.icon || String(service.name || "M").slice(0, 1));
    const link = url
      ? '<a class="launch" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open ↗</a>'
      : '<span class="launch" title="This service has no URL configured">Set URL</span>';
    return '<article class="service-card"><div class="app-icon ' + tone + '">' + icon + '</div><div class="service-info"><h4>' + esc(service.name || "Service") + '</h4><p>' + esc(service.desc || "Self-hosted service") + '</p></div>' + link + '</article>';
  }).join("") || '<div class="media-empty">No media service shortcuts are configured.</div>';
}
function tickEtas() {
  if (!authenticated) return;
  const now = Date.now();
  document.querySelectorAll(".download-eta[data-eta-seconds]").forEach(node => {
    const seconds = Number(node.dataset.etaSeconds);
    const started = Number(node.dataset.etaStarted);
    if (Number.isFinite(seconds) && Number.isFinite(started)) {
      node.textContent = "ETA " + formatEta(Math.max(0, seconds - Math.floor((now - started) / 1000)));
    }
  });
}
async function initializeMedia() {
  renderServiceLinks();
  await loadSeerrTargets();
  if (authenticated) await refreshDownloads();
}
$("downloadLoginForm").addEventListener("submit", submitLogin);
$("downloadLogout").addEventListener("click", lockMedia);
$("mediaSearchForm").addEventListener("submit", searchMedia);
$("mediaResults").addEventListener("click", event => {
  const button = event.target.closest("[data-request-index]");
  if (button && !button.disabled) requestMedia(button);
});
$("mediaRefresh").addEventListener("click", async () => {
  $("mediaRefresh").textContent = "…";
  await loadSeerrTargets();
  await refreshDownloads();
  $("mediaRefresh").textContent = "↻";
});
initializeMedia();
setInterval(() => { if (authenticated) refreshDownloads(); }, 3000);
setInterval(tickEtas, 1000);

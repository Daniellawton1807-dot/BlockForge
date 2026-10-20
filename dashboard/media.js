/* Homebase Media hub. ARR credentials stay in protected Pages environment variables. */
const config = window.HOMEBASE_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const endpoints = {
  queue: "/api/downloads",
  login: "/api/downloads/login",
  logout: "/api/downloads/logout",
  arrConfig: "/api/media/config",
  search: "/api/media/search",
  add: "/api/media/add",
  library: "/api/media/library",
  manage: "/api/media/manage"
};
let authenticated = false;
let arrReady = false;
let downloadsFetchInFlight = false;
let libraryFetchInFlight = false;
let serviceMap = Object.create(null);
let searchResults = [];
let libraryItems = [];
let libraryLoaded = false;
let serviceFilter = "all";

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
  $("arrConnectionLabel").textContent = "Sign in required";
  $("mediaSearchButton").disabled = true;
  $("mediaSearch").disabled = true;
  $("arrStatus").textContent = "Sign in above to connect to your media services.";
  $("mediaSearchMessage").textContent = "Sign in above to search and manage media.";
}
function showUnlocked() {
  authenticated = true;
  $("mediaAccess").hidden = true;
  $("downloadsPrivate").hidden = false;
  $("downloadsLocked").hidden = true;
  $("downloadSummary").textContent = "Loading queue…";
}
async function readResponse(response) {
  const data = await response.json().catch(() => null);
  return { response, data };
}
function renderArrStatus(data) {
  serviceMap = Object.create(null);
  for (const service of Array.isArray(data.services) ? data.services : []) serviceMap[service.key] = service;
  const services = Object.values(serviceMap);
  const connected = services.filter(service => service.connected);
  arrReady = connected.length > 0;
  $("arrConnectionLabel").textContent = connected.length + " of " + services.length + " services connected";
  if (arrReady) {
    const details = services.filter(service => !service.connected).map(service => service.name + ": " + service.message).join(" ");
    $("arrStatus").textContent = connected.length + " of " + services.length + " Sonarr/Radarr instances connected." + (details ? " " + details : "");
    $("arrStatus").className = "media-status is-success";
    $("mediaSearchButton").disabled = false;
    $("mediaSearch").disabled = false;
    $("mediaSearchMessage").textContent = "Search across the connected instances, then choose where to add a title.";
    $("mediaSearchMessage").className = "media-status";
  } else {
    const missing = services.map(service => service.message).filter(Boolean);
    $("arrStatus").textContent = missing.length ? missing.join(" ") : "No Sonarr or Radarr instances are connected.";
    $("arrStatus").className = "media-status is-error";
    $("mediaSearchButton").disabled = true;
    $("mediaSearch").disabled = true;
    $("mediaSearchMessage").textContent = "Configure the private VPC bindings and protected ARR API key secrets in Cloudflare Pages.";
    $("mediaSearchMessage").className = "media-status is-error";
  }
}
async function loadArrConfig() {
  try {
    const result = await readResponse(await fetch(endpoints.arrConfig, { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Sign in to search and manage your Sonarr/Radarr libraries.");
      return false;
    }
    if (result.data?.code === "login_setup_required") {
      showLogin("The Homebase sign-in is not configured in Cloudflare Pages yet.");
      return false;
    }
    showUnlocked();
    if (!result.response.ok) {
      $("arrConnectionLabel").textContent = "Configuration unavailable";
      $("arrStatus").textContent = result.data?.error || "Could not load the Sonarr/Radarr configuration.";
      $("arrStatus").className = "media-status is-error";
      arrReady = false;
      return true;
    }
    renderArrStatus(result.data || {});
    if (libraryLoaded) await loadLibrary();
    return true;
  } catch {
    showUnlocked();
    $("arrConnectionLabel").textContent = "Services unavailable";
    $("arrStatus").textContent = "Could not reach Homebase’s media connection. Check the Pages bindings and API keys.";
    $("arrStatus").className = "media-status is-error";
    arrReady = false;
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
      body: JSON.stringify({ username: $("downloadUsername").value, password: $("downloadPassword").value, remember: $("downloadRemember").checked })
    }));
    if (!result.response.ok) {
      if (result.data?.code === "login_setup_required") $("mediaAuthMessage").textContent = "The Homebase sign-in is not configured in Cloudflare Pages.";
      else if (result.response.status === 401) $("mediaAuthMessage").textContent = "Username or password is incorrect.";
      else $("mediaAuthMessage").textContent = "Could not sign in. Try again.";
      return;
    }
    $("downloadPassword").value = "";
    showUnlocked();
    await loadArrConfig();
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
    searchResults = [];
    libraryItems = [];
    libraryLoaded = false;
    $("mediaResults").innerHTML = '<div class="media-empty">Sign in to search for a title.</div>';
    $("mediaDetail").hidden = true;
    $("mediaLibraryView").hidden = true;
    showLogin("This device is signed out. Sign in to manage media.");
  } catch {
    $("downloadSummary").textContent = "Could not lock media";
  } finally {
    button.disabled = false;
  }
}
function mediaTypeName(type) { return type === "tv" ? "TV show" : "Movie"; }
function matchingLibrary(item) {
  return libraryItems.filter(entry => entry.mediaType === item.mediaType && (item.mediaType === "tv"
    ? (item.tvdbId && entry.tvdbId === item.tvdbId) || (!item.tvdbId && item.tmdbId && entry.tmdbId === item.tmdbId)
    : entry.tmdbId === item.tmdbId));
}
function renderSearchResults(items) {
  searchResults = items;
  $("mediaDetail").hidden = true;
  if (!items.length) {
    $("mediaResults").innerHTML = '<div class="media-empty">No movies or shows matched that search.</div>';
    return;
  }
  $("mediaResults").innerHTML = items.map((item, index) => {
    const type = item.mediaType === "tv" ? "tv" : "movie";
    const posterUrl = safeUrl(item.posterUrl || "");
    const poster = posterUrl ? '<img src="' + esc(posterUrl) + '" alt="" loading="lazy">' : '<span>' + (type === "tv" ? "TV" : "M") + "</span>";
    const matches = matchingLibrary(item);
    const libraryText = matches.length ? '<span class="media-in-library">In ' + esc(matches.map(entry => entry.serviceName).join(", ")) + '</span>' : "";
    const genres = Array.isArray(item.genres) ? item.genres.slice(0, 3).map(genre => '<span class="media-genre">' + esc(genre) + '</span>').join("") : "";
    return '<article class="media-result"><div class="media-result-art">' + poster + '</div><div class="media-result-copy"><div class="media-result-meta"><span class="media-type-chip ' + type + '">' + mediaTypeName(type) + '</span>' + (item.year ? '<span>' + esc(item.year) + '</span>' : "") + libraryText + '</div><h4>' + esc(item.title || "Untitled") + '</h4><div class="media-genres">' + genres + '</div><p>' + esc(item.overview || "No summary available.") + '</p><div class="media-result-actions"><span class="media-destination-hint">' + (matches.length ? "Choose a destination to see whether it is already there." : "Choose an instance and destination.") + '</span><button class="media-primary-button request-button" data-select-index="' + index + '" type="button">Select</button></div></div></article>';
  }).join("");
}
function folderOptions(service, selectedPath) {
  return (service?.rootFolders || []).map(folder => '<option value="' + esc(folder.path) + '" ' + (folder.path === selectedPath ? "selected" : "") + '>' + esc(folder.path) + (folder.freeSpace ? " · " + esc(formatBytes(folder.freeSpace)) + " free" : "") + '</option>').join("");
}
function profileOptions(service, selectedId) {
  return (service?.qualityProfiles || []).map(profile => '<option value="' + profile.id + '" ' + (profile.id === selectedId ? "selected" : "") + '>' + esc(profile.name) + '</option>').join("");
}
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "GB", "TB", "PB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return size.toFixed(size >= 10 || index === 0 ? 0 : 1) + " " + units[index];
}
function selectableServices(item) {
  return Object.values(serviceMap).filter(service => service.connected && service.type === item.mediaType);
}
function renderAddDetails(item) {
  const services = selectableServices(item);
  if (!services.length) {
    $("mediaDetail").hidden = false;
    $("mediaDetail").innerHTML = '<div class="media-detail-top"><h4>' + esc(item.title) + '</h4><button type="button" class="media-secondary-button" data-close-detail>Close</button></div><div class="media-status is-error">No connected ' + esc(item.mediaType === "tv" ? "Sonarr" : "Radarr") + ' destination is ready for this title.</div>';
    return;
  }
  const matching = matchingLibrary(item);
  const service = services[0];
  const image = safeUrl(item.posterUrl || "");
  const poster = image ? '<img src="' + esc(image) + '" alt="" loading="lazy">' : '<span>' + (item.mediaType === "tv" ? "TV" : "M") + "</span>";
  const serviceOptions = services.map(server => '<option value="' + esc(server.key) + '">' + esc(server.name) + '</option>').join("");
  const selectedPath = service.rootFolders?.[0]?.path || "";
  const selectedProfile = service.qualityProfiles?.[0]?.id;
  const existingText = matching.length ? '<div class="media-status is-success">Already in ' + esc(matching.map(entry => entry.serviceName).join(", ")) + '. You can still choose another instance if you want a separate copy.</div>' : "";
  const typeSettings = item.mediaType === "tv"
    ? '<div class="media-form-row"><label>Series type<select name="seriesType"><option value="standard">Standard</option><option value="daily">Daily</option><option value="anime">Anime</option></select></label><label>Monitor<select name="monitorType"><option value="all">All seasons</option><option value="future">Future seasons</option><option value="missing">Missing episodes</option><option value="none">None</option></select></label></div><label class="media-switch"><input type="checkbox" name="seasonFolder" checked><span>Use season folders</span></label>'
    : "";
  $("mediaDetail").innerHTML = '<div class="media-detail-top"><div><div class="kicker">' + (item.mediaType === "tv" ? "ADD SERIES" : "ADD MOVIE") + '</div><h4>' + esc(item.title) + (item.year ? ' <span>' + esc(item.year) + '</span>' : "") + '</h4></div><button type="button" class="media-secondary-button" data-close-detail>Close</button></div><div class="media-detail-summary"><div class="media-detail-art">' + poster + '</div><p>' + esc(item.overview || "No description available.") + '</p></div>' + existingText + '<form id="mediaAddForm" class="media-add-form"><input type="hidden" name="mediaType" value="' + esc(item.mediaType) + '"><input type="hidden" name="tmdbId" value="' + esc(item.tmdbId || "") + '"><input type="hidden" name="tvdbId" value="' + esc(item.tvdbId || "") + '"><label>ADD TO<select name="serviceKey" required>' + serviceOptions + '</select></label><label>Root folder<select name="rootFolderPath" required>' + folderOptions(service, selectedPath) + '</select></label><label>Quality profile<select name="qualityProfileId" required>' + profileOptions(service, selectedProfile) + '</select></label>' + typeSettings + '<label class="media-switch"><input type="checkbox" name="monitored" checked><span>Monitored</span></label><label class="media-switch"><input type="checkbox" name="searchOnAdd" checked><span>Search for missing ' + (item.mediaType === "tv" ? "episodes" : "movie") + ' after adding</span></label><div class="media-add-feedback" role="status" aria-live="polite"></div><button class="media-primary-button media-add-button" type="submit">Add to ' + esc(service.name) + '</button></form>';
  $("mediaDetail").hidden = false;
  const form = $("mediaAddForm");
  form.addEventListener("change", event => {
    if (event.target.name === "serviceKey") {
      const nextService = serviceMap[event.target.value];
      form.elements.rootFolderPath.innerHTML = folderOptions(nextService, nextService?.rootFolders?.[0]?.path || "");
      form.elements.qualityProfileId.innerHTML = profileOptions(nextService, nextService?.qualityProfiles?.[0]?.id);
      form.querySelector(".media-add-button").textContent = "Add to " + (nextService?.name || "service");
    }
  });
  form.addEventListener("submit", addSelectedMedia);
}
function chooseSearchResult(button) {
  const item = searchResults[Number(button.dataset.selectIndex)];
  if (item && authenticated) renderAddDetails(item);
}
async function searchMedia(event) {
  event.preventDefault();
  if (!authenticated || !arrReady) {
    $("mediaSearchMessage").textContent = "No connected Sonarr/Radarr destination is ready yet.";
    return;
  }
  const query = $("mediaSearch").value.trim();
  if (query.length < 2) {
    $("mediaSearchMessage").textContent = "Enter at least two characters to search.";
    return;
  }
  $("mediaSearchButton").disabled = true;
  $("mediaSearchMessage").textContent = "Searching Sonarr and Radarr…";
  $("mediaResults").innerHTML = '<div class="media-empty">Searching connected media services…</div>';
  $("mediaDetail").hidden = true;
  try {
    const result = await readResponse(await fetch(endpoints.search + "?q=" + encodeURIComponent(query), { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok) throw new Error(result.data?.error || "Search failed.");
    renderSearchResults(Array.isArray(result.data?.results) ? result.data.results : []);
    const offline = (result.data?.services || []).filter(service => !service.connected).map(service => service.name);
    $("mediaSearchMessage").textContent = "Select a result to choose an instance and root folder." + (offline.length ? " Search also completed with " + offline.join(", ") + " unavailable." : "");
  } catch (error) {
    $("mediaResults").innerHTML = '<div class="media-empty">Search failed. ' + esc(error.message || "Try again.") + '</div>';
    $("mediaSearchMessage").textContent = "Could not search the connected media services.";
  } finally {
    $("mediaSearchButton").disabled = !arrReady;
  }
}
async function addSelectedMedia(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".media-add-button");
  const feedback = form.querySelector(".media-add-feedback");
  const values = new FormData(form);
  const service = serviceMap[String(values.get("serviceKey"))];
  const item = searchResults.find(result => String(result.tmdbId || "") === String(values.get("tmdbId") || "") && String(result.tvdbId || "") === String(values.get("tvdbId") || ""));
  const body = {
    mediaType: String(values.get("mediaType")),
    serviceKey: String(values.get("serviceKey")),
    tmdbId: Number(values.get("tmdbId")) || null,
    tvdbId: Number(values.get("tvdbId")) || null,
    rootFolderPath: String(values.get("rootFolderPath")),
    qualityProfileId: Number(values.get("qualityProfileId")),
    monitored: values.has("monitored"),
    searchOnAdd: values.has("searchOnAdd"),
    seasonFolder: values.has("seasonFolder"),
    seriesType: String(values.get("seriesType") || "standard"),
    monitorType: String(values.get("monitorType") || "all")
  };
  button.disabled = true;
  button.textContent = "Adding…";
  feedback.textContent = "";
  try {
    const result = await readResponse(await fetch(endpoints.add, {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify(body)
    }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok) throw new Error(result.data?.error || "Could not add media.");
    button.textContent = "Added to " + (result.data?.item?.serviceName || service?.name || "library");
    button.classList.add("is-complete");
    feedback.textContent = (result.data?.item?.title || item?.title || "Title") + " has been added to " + (result.data?.item?.serviceName || service?.name || "your library") + ".";
    if (libraryLoaded) await loadLibrary();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Add to " + (service?.name || "service");
    feedback.textContent = error.message || "Add failed. Try again.";
  }
}
async function loadLibrary() {
  if (!authenticated || libraryFetchInFlight) return;
  libraryFetchInFlight = true;
  $("librarySummary").textContent = "Loading your Sonarr and Radarr library…";
  try {
    const result = await readResponse(await fetch(endpoints.library, { cache: "no-store", credentials: "same-origin" }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok || !Array.isArray(result.data?.items)) throw new Error(result.data?.error || "Could not load the library.");
    libraryItems = result.data.items;
    libraryLoaded = true;
    const serviceCount = (result.data.services || []).filter(service => service.connected).length;
    const offline = (result.data.services || []).filter(service => !service.connected);
    $("librarySummary").textContent = libraryItems.length + " titles across " + serviceCount + " connected instances." + (offline.length ? " " + offline.map(service => service.name + " unavailable").join(" · ") : "");
    renderServiceFilters(result.data.services || []);
    renderLibrary();
  } catch (error) {
    $("librarySummary").textContent = error.message || "Could not load your library.";
    $("librarySummary").className = "media-status is-error";
    $("libraryList").innerHTML = '<div class="media-empty">The library could not be loaded. Check the ARR connection status above.</div>';
  } finally {
    libraryFetchInFlight = false;
  }
}
function renderServiceFilters(services) {
  const active = services.filter(service => service.connected);
  const options = [{ key: "all", name: "All" }, ...active.map(service => ({ key: service.key, name: service.name }))];
  if (!options.some(option => option.key === serviceFilter)) serviceFilter = "all";
  $("libraryServiceFilters").innerHTML = options.map(option => '<button class="library-filter-chip ' + (option.key === serviceFilter ? "is-active" : "") + '" type="button" data-service-filter="' + esc(option.key) + '" aria-pressed="' + (option.key === serviceFilter) + '">' + esc(option.name) + '</button>').join("");
}
function renderLibrary() {
  const query = $("libraryFilter").value.trim().toLowerCase();
  const filtered = libraryItems.filter(item => (serviceFilter === "all" || item.serviceKey === serviceFilter)
    && (!query || (item.title + " " + item.year + " " + item.serviceName).toLowerCase().includes(query)));
  if (!filtered.length) {
    $("libraryList").innerHTML = '<div class="media-empty">' + (libraryItems.length ? "No titles match these filters." : "No titles are in the connected libraries yet.") + '</div>';
    return;
  }
  $("libraryList").innerHTML = filtered.map(item => {
    const image = safeUrl(item.posterUrl || "");
    const poster = image ? '<img src="' + esc(image) + '" alt="" loading="lazy">' : '<span>' + (item.mediaType === "tv" ? "TV" : "M") + "</span>";
    const status = item.mediaType === "tv" ? item.episodeFileCount + " / " + item.episodeCount + " episodes" : esc(item.status || "Movie");
    const size = item.sizeOnDisk ? formatBytes(item.sizeOnDisk) : "No files on disk";
    return '<article class="media-library-card"><div class="media-library-art">' + poster + '</div><div class="media-library-copy"><div class="media-result-meta"><span class="media-type-chip ' + (item.mediaType === "tv" ? "tv" : "movie") + '">' + mediaTypeName(item.mediaType) + '</span><span>' + esc(item.serviceName) + '</span>' + (item.year ? '<span>' + esc(item.year) + '</span>' : "") + '</div><h4>' + esc(item.title) + '</h4><p>' + esc(status) + ' · ' + esc(size) + '</p><p class="media-library-path" title="' + esc(item.rootFolderPath) + '">' + esc(item.rootFolderPath || "Root folder not reported") + '</p></div><div class="media-library-actions"><button type="button" class="media-secondary-button ' + (item.monitored ? "is-monitored" : "") + '" data-library-action="monitor" data-library-key="' + esc(item.serviceKey) + '" data-library-id="' + item.id + '" data-library-value="' + (!item.monitored) + '">' + (item.monitored ? "Monitored" : "Unmonitored") + '</button><button type="button" class="media-secondary-button" data-library-action="search" data-library-key="' + esc(item.serviceKey) + '" data-library-id="' + item.id + '">Search</button><button type="button" class="media-secondary-button" data-library-action="refresh" data-library-key="' + esc(item.serviceKey) + '" data-library-id="' + item.id + '">Refresh</button><span class="library-action-feedback" role="status" aria-live="polite"></span></div></article>';
  }).join("");
}
async function manageLibraryAction(button) {
  const action = button.dataset.libraryAction;
  const key = button.dataset.libraryKey;
  const id = Number(button.dataset.libraryId);
  const item = libraryItems.find(entry => entry.serviceKey === key && entry.id === id);
  if (!item || !authenticated) return;
  const card = button.closest(".media-library-card");
  const feedback = card.querySelector(".library-action-feedback");
  const buttons = card.querySelectorAll("button");
  buttons.forEach(control => { control.disabled = true; });
  feedback.textContent = action === "monitor" ? "Updating…" : action === "search" ? "Queueing search…" : "Queueing refresh…";
  try {
    const result = await readResponse(await fetch(endpoints.manage, {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ serviceKey: key, id, action, value: button.dataset.libraryValue === "true" })
    }));
    if (result.response.status === 401) {
      showLogin("Your Homebase sign-in expired. Sign in again to continue.");
      return;
    }
    if (!result.response.ok) throw new Error(result.data?.error || "That media action failed.");
    if (action === "monitor") item.monitored = Boolean(result.data?.monitored);
    feedback.textContent = action === "monitor" ? (item.monitored ? "Monitoring enabled." : "Monitoring disabled.") : action === "search" ? "Search queued in " + item.serviceName + "." : "Refresh queued in " + item.serviceName + ".";
    renderLibrary();
  } catch (error) {
    feedback.textContent = error.message || "Action failed.";
    buttons.forEach(control => { control.disabled = false; });
  }
}
function setMediaMode(mode) {
  const library = mode === "library";
  $("mediaAddView").hidden = library;
  $("mediaLibraryView").hidden = !library;
  $("mediaModeAdd").classList.toggle("is-active", !library);
  $("mediaModeLibrary").classList.toggle("is-active", library);
  $("mediaModeAdd").setAttribute("aria-selected", String(!library));
  $("mediaModeLibrary").setAttribute("aria-selected", String(library));
  if (library && !libraryLoaded) loadLibrary();
}
function renderServiceLinks() {
  const services = Array.isArray(config.services) ? config.services : [];
  const items = services.filter(service => ["media", "downloads"].includes(service.group));
  $("mediaApps").innerHTML = items.map(service => {
    const url = safeUrl(service.url);
    const tone = ["purple", "blue", "orange", "green"].includes(service.tone) ? service.tone : "purple";
    const icon = esc(service.icon || String(service.name || "M").slice(0, 1));
    const link = url ? '<a class="launch" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open ↗</a>' : '<span class="launch" title="This service has no URL configured">Set URL</span>';
    return '<article class="service-card"><div class="app-icon ' + tone + '">' + icon + '</div><div class="service-info"><h4>' + esc(service.name || "Service") + '</h4><p>' + esc(service.desc || "Self-hosted service") + '</p></div>' + link + '</article>';
  }).join("") || '<div class="media-empty">No media service shortcuts are configured.</div>';
}
function tickEtas() {
  if (!authenticated) return;
  const now = Date.now();
  document.querySelectorAll(".download-eta[data-eta-seconds]").forEach(node => {
    const seconds = Number(node.dataset.etaSeconds);
    const started = Number(node.dataset.etaStarted);
    if (Number.isFinite(seconds) && Number.isFinite(started)) node.textContent = "ETA " + formatEta(Math.max(0, seconds - Math.floor((now - started) / 1000)));
  });
}
async function initializeMedia() {
  renderServiceLinks();
  await loadArrConfig();
  if (authenticated) await refreshDownloads();
}
$("downloadLoginForm").addEventListener("submit", submitLogin);
$("downloadLogout").addEventListener("click", lockMedia);
$("mediaSearchForm").addEventListener("submit", searchMedia);
$("mediaResults").addEventListener("click", event => {
  const select = event.target.closest("[data-select-index]");
  if (select) chooseSearchResult(select);
});
$("mediaDetail").addEventListener("click", event => {
  if (event.target.closest("[data-close-detail]")) $("mediaDetail").hidden = true;
});
$("mediaModeAdd").addEventListener("click", () => setMediaMode("add"));
$("mediaModeLibrary").addEventListener("click", () => setMediaMode("library"));
$("libraryFilter").addEventListener("input", renderLibrary);
$("libraryServiceFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-service-filter]");
  if (!button) return;
  serviceFilter = button.dataset.serviceFilter;
  renderServiceFilters(Object.values(serviceMap));
  renderLibrary();
});
$("libraryRefresh").addEventListener("click", loadLibrary);
$("libraryList").addEventListener("click", event => {
  const button = event.target.closest("[data-library-action]");
  if (button && !button.disabled) manageLibraryAction(button);
});
$("mediaRefresh").addEventListener("click", async () => {
  $("mediaRefresh").textContent = "…";
  await loadArrConfig();
  await refreshDownloads();
  $("mediaRefresh").textContent = "↻";
});
initializeMedia();
setInterval(() => { if (authenticated) refreshDownloads(); }, 3000);
setInterval(tickEtas, 1000);

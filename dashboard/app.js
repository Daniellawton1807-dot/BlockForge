/* Homebase dashboard. Live metrics are served by the same-origin Pages Function at /api/metrics. */
const defaults = {
  metricsEndpoint: "/api/metrics",
  downloadsEndpoint: "/api/downloads",
  downloadsLoginEndpoint: "/api/downloads/login",
  downloadsLogoutEndpoint: "/api/downloads/logout",
  refreshIntervalMs: 10000,
  downloadsRefreshIntervalMs: 3000,
  services: []
};
const config = Object.assign({}, defaults, window.HOMEBASE_CONFIG || {});
config.services = Array.isArray(config.services) ? config.services : defaults.services;
const $ = id => document.getElementById(id);
const safeUrl = value => { try { const u = new URL(value, location.href); return ["http:","https:"].includes(u.protocol) ? u.href : ""; } catch { return ""; } };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function card(s,featured=false){
 const url=safeUrl(s.url), cls=["purple","blue","orange","green"].includes(s.tone)?s.tone:"purple";
 return featured ? '<article class="service-card"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="service-info"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p></div>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'<span class="launch" title="Set this URL in config.js">Set URL</span>')+'</article>'
 : '<article class="app-card"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="card-copy"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p><div class="card-bottom"><span class="status '+(url?"configured":"")+'">'+(url?"URL configured":"Not configured")+'</span>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'')+'</div></div></article>';
}
function render(){
 const services=config.services;
 const configuredCount=services.filter(s=>safeUrl(s.url)).length;
 $("onlineValue").innerHTML=configuredCount+'<small> / configured</small>';
 $("featured").innerHTML=services.filter(s=>["Sonarr","Radarr","qBittorrent","SABnzbd","Prowlarr","Jellyfin"].includes(s.name)).map(s=>card(s,true)).join("");
 const q=($("search").value||"").trim().toLowerCase();
 const filtered=services.filter(s=>(s.name+" "+(s.desc||"")+" "+(s.group||"")).toLowerCase().includes(q));
 $("appGrid").innerHTML=filtered.length?filtered.map(s=>card(s)).join(""):'<div class="empty">No applications match your search.</div>';
}
async function refreshMetrics(){
 const endpoint=safeUrl(config.metricsEndpoint);
 if(!endpoint){$("connectionLabel").textContent="Monitoring unavailable";return;}
 try{
  const res=await fetch(endpoint,{cache:"no-store",credentials:"same-origin"});
  const d=await res.json().catch(()=>null);
  if(!res.ok)throw new Error(d&&typeof d.error==="string"?d.error:"Metrics endpoint returned "+res.status);
  if(!d||typeof d!=="object")throw new Error("Metrics endpoint returned invalid JSON");
  const set=(value,valueId,barId)=>{if(Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=100){$(valueId).innerHTML=Math.round(Number(value))+'<small>%</small>';$ (barId).style.width=Number(value)+'%';}};
  set(d.cpuPercent,"cpuValue","cpuBar");set(d.memoryPercent,"ramValue","ramBar");set(d.diskPercent,"diskValue","diskBar");
  if(d.memoryUsedBytes!=null&&d.memoryTotalBytes>0)$("ramNote").textContent=formatBytes(d.memoryUsedBytes)+" / "+formatBytes(d.memoryTotalBytes);
  if(d.diskUsedBytes!=null&&d.diskTotalBytes>0)$("diskNote").textContent=formatBytes(d.diskUsedBytes)+" / "+formatBytes(d.diskTotalBytes)+(d.diskMount?" · "+d.diskMount:"");
  if(d.uptimeSeconds!=null)$("cpuNote").textContent="Uptime "+formatUptime(d.uptimeSeconds);
  else $("cpuNote").textContent="Updated "+new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
  $("connectionLabel").textContent="Metrics connected";$("onlineNote").textContent="Live hardware metrics";
 }catch(e){
  $("cpuValue").innerHTML="—<small>%</small>";$("ramValue").innerHTML="—<small>%</small>";$("diskValue").innerHTML="—<small>%</small>";
  $("cpuBar").style.width="0%";$("ramBar").style.width="0%";$("diskBar").style.width="0%";
  $("connectionLabel").textContent="Glances unavailable";
  $("onlineNote").textContent="Live metrics unavailable";
  $("cpuNote").textContent=String(e&&e.message||"Glances metrics unavailable").slice(0,140);
  $("ramNote").textContent="Waiting for Glances metrics";
  $("diskNote").textContent="Waiting for Glances metrics";
 }
}

function downloadCard(item, updatedAt){
 const raw=Number(item.progress), progress=Number.isFinite(raw)?Math.max(0,Math.min(100,raw)):0;
 const status=String(item.status||"In queue");
 const hasEta=item.etaSeconds!==null&&item.etaSeconds!==undefined&&Number.isFinite(Number(item.etaSeconds));
 const seconds=hasEta?Math.max(0,Math.floor(Number(item.etaSeconds))):null;
 const eta=hasEta?formatEta(seconds):(/queued/i.test(status)?"Pending":/paused/i.test(status)?"Paused":/stalled/i.test(status)?"Waiting":"Calculating");
 const etaLabel=hasEta?'<span class="download-eta" data-eta-seconds="'+seconds+'" data-eta-started="'+updatedAt+'">ETA '+esc(eta)+'</span>':'<span>ETA '+esc(eta)+'</span>';
 const title=String(item.name||"Untitled download");
 return '<article class="download-card"><div class="download-card-header"><span class="download-source">'+esc(item.source||"Downloader")+'</span><span class="download-state">'+esc(status)+'</span></div><h4 class="download-name" title="'+esc(title)+'">'+esc(title)+'</h4><div class="download-progress" role="progressbar" aria-label="'+esc(title)+' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(progress)+'"><span style="width:'+progress+'%"></span></div><div class="download-facts"><span>'+esc(item.category||"Download")+'</span><strong>'+Math.round(progress)+'%</strong>'+etaLabel+'</div></article>';
}
function formatEta(seconds){
 const value=Math.max(0,Math.floor(Number(seconds)));
 if(!Number.isFinite(value))return "Calculating";
 if(value<60)return value+"s";
 const days=Math.floor(value/86400), hours=Math.floor(value%86400/3600), minutes=Math.floor(value%3600/60), remainder=value%60;
 const parts=[];
 if(days)parts.push(days+"d");
 if(hours||days)parts.push(hours+"h");
 if(minutes||hours||days)parts.push(String(minutes).padStart(2,"0")+"m");
 parts.push(String(remainder).padStart(2,"0")+"s");
 return parts.join(" ");
}
let downloadsAuthKnown=false;
let downloadsUnlocked=false;
function showDownloadsLogin(message,summary){
 downloadsAuthKnown=true;downloadsUnlocked=false;
 const form=$("downloadLoginForm"), panel=$("downloadsPrivate");
 if(form)form.hidden=false;
 if(panel)panel.hidden=true;
 const authMessage=$("downloadAuthMessage");
 if(authMessage){authMessage.textContent=message;authMessage.hidden=false;}
 const label=$("downloadSummary");
 if(label)label.textContent=summary;
}
function showDownloadsUnlocked(){
 downloadsAuthKnown=true;downloadsUnlocked=true;
 const form=$("downloadLoginForm"), panel=$("downloadsPrivate");
 if(form)form.hidden=true;
 if(panel)panel.hidden=false;
 const authMessage=$("downloadAuthMessage");
 if(authMessage){authMessage.textContent="";authMessage.hidden=true;}
}
function showDownloadsMessage(message,summary){
 if(!downloadsUnlocked){showDownloadsLogin(message,summary);return;}
 const list=$("downloadList"), label=$("downloadSummary");
 if(!list||!label)return;
 label.textContent=summary;
 list.innerHTML='<div class="downloads-empty">'+esc(message)+'</div>';
}
function renderDownloads(data){
 showDownloadsUnlocked();
 const updatedAt=Date.now();
 const list=$("downloadList"), label=$("downloadSummary");
 if(!list||!label)return;
 const items=Array.isArray(data.items)?data.items:[];
 const sources=Array.isArray(data.sources)?data.sources:[];
 const warnings=sources.filter(source=>!source.connected).map(source=>esc(source.name)+": "+esc(source.message||"Unavailable"));
 label.textContent=items.length+" active "+(items.length===1?"download":"downloads");
 if(items.length){
  list.innerHTML=items.map(item=>downloadCard(item,updatedAt)).join()+(warnings.length?'<div class="download-warning">'+warnings.join(" · ")+'</div>':"");
 }else if(sources.length&&sources.every(source=>source.connected)){
  list.innerHTML='<div class="downloads-empty">No active downloads right now.</div>';
 }else{
  list.innerHTML='<div class="downloads-empty">Connect qBittorrent and SABnzbd in the protected Pages settings to view their queues.</div>'+(warnings.length?'<div class="download-warning">'+warnings.join(" · ")+'</div>':"");
 }
}
let downloadsFetchInFlight=false;
async function refreshDownloads(force=false){
 if(!$("downloadList")||!$("downloadSummary"))return;
 if(downloadsAuthKnown&&!downloadsUnlocked&&!force)return;
 const endpoint=safeUrl(config.downloadsEndpoint);
 if(!endpoint){showDownloadsLogin("The downloads endpoint is not available.","Unavailable");return;}
 if(downloadsFetchInFlight)return;
 downloadsFetchInFlight=true;
 try{
  const res=await fetch(endpoint,{cache:"no-store",credentials:"same-origin"});
  const data=await res.json().catch(()=>null);
  if(!res.ok){
   const code=data&&data.code;
   if(code==="login_setup_required"){
    showDownloadsLogin("Set the encrypted Homebase downloads login secrets in Cloudflare Pages before signing in.","Setup required");
   }else if(code==="login_required"){
    showDownloadsLogin("Sign in to see your private download queue.","Sign-in required");
   }else if(!downloadsUnlocked){
    showDownloadsLogin("The downloads sign-in could not be checked. Enter your details to try again.","Unavailable");
   }else{
    showDownloadsMessage("The download queue is unavailable right now.","Unavailable");
   }
   return;
  }
  if(!data||!Array.isArray(data.items)||!Array.isArray(data.sources))throw new Error("Invalid downloads response");
  renderDownloads(data);
 }catch{
  if(!downloadsUnlocked)showDownloadsLogin("Could not check the downloads sign-in. Try signing in again.","Unavailable");
  else showDownloadsMessage("The download queue is unavailable right now.","Unavailable");
 }finally{
  downloadsFetchInFlight=false;
 }
}
async function loginDownloads(event){
 event.preventDefault();
 const form=$("downloadLoginForm"), button=form.querySelector("button[type=submit]");
 const message=$("downloadAuthMessage");
 button.disabled=true;
 message.textContent="Signing in…";
 try{
  const endpoint=safeUrl(config.downloadsLoginEndpoint)||"/api/downloads/login";
  const res=await fetch(endpoint,{
   method:"POST",
   headers:{"content-type":"application/json"},
   credentials:"same-origin",
   cache:"no-store",
   body:JSON.stringify({
    username:$("downloadUsername").value,
    password:$("downloadPassword").value,
    remember:$("downloadRemember").checked
   })
  });
  const data=await res.json().catch(()=>null);
  if(!res.ok){
   if(data&&data.code==="login_setup_required")message.textContent="The Homebase login has not been configured in Cloudflare Pages yet.";
   else if(res.status===401)message.textContent="Username or password is incorrect.";
   else message.textContent="Could not sign in. Try again.";
   return;
  }
  $("downloadPassword").value="";
  downloadsAuthKnown=true;downloadsUnlocked=true;
  showDownloadsUnlocked();
  await refreshDownloads();
 }catch{
  message.textContent="Could not reach the sign-in service. Try again.";
 }finally{
  button.disabled=false;
 }
}
async function logoutDownloads(){
 const button=$("downloadLogout");
 button.disabled=true;
 try{
  const endpoint=safeUrl(config.downloadsLogoutEndpoint)||"/api/downloads/logout";
  const res=await fetch(endpoint,{method:"POST",credentials:"same-origin",cache:"no-store"});
  if(!res.ok)throw new Error("Could not lock downloads.");
  $("downloadUsername").value="";
  $("downloadPassword").value="";
  $("downloadRemember").checked=false;
  showDownloadsLogin("This device is signed out. Sign in to view downloads.","Signed out");
 }catch{
  showDownloadsMessage("Could not sign out. Please try again.","Unavailable");
 }finally{
  button.disabled=false;
 }
}
function refreshAll(forceDownloads=false){refreshMetrics();refreshDownloads(forceDownloads);}
function tickDownloadEtas(){
 if(!downloadsUnlocked)return;
 const now=Date.now();
 document.querySelectorAll(".download-eta[data-eta-seconds]").forEach(node=>{
  const seconds=Number(node.dataset.etaSeconds), started=Number(node.dataset.etaStarted);
  if(Number.isFinite(seconds)&&Number.isFinite(started))node.textContent="ETA "+formatEta(Math.max(0,seconds-Math.floor((now-started)/1000)));
 });
}

function formatBytes(n){if(!Number.isFinite(Number(n))||n<0)return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?1:0)+" "+u[i];}
function formatUptime(n){n=Math.max(0,Math.floor(Number(n)||0));const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60);return (d?d+"d ":"")+(h+"h "+m+"m");}
$("search").addEventListener("input",render);
$("downloadLoginForm").addEventListener("submit",loginDownloads);
$("downloadLogout").addEventListener("click",logoutDownloads);
$("refresh").addEventListener("click",()=>{refreshAll(true);const b=$("refresh");b.textContent="✓";setTimeout(()=>b.textContent="↻",800);});
render();refreshAll();
const metricsRefreshInterval=Number(config.refreshIntervalMs);
const downloadsRefreshInterval=Number(config.downloadsRefreshIntervalMs);
if(metricsRefreshInterval>=3000)setInterval(refreshMetrics,Math.min(metricsRefreshInterval,60000));
if(downloadsRefreshInterval>=2000)setInterval(refreshDownloads,Math.min(downloadsRefreshInterval,60000));
setInterval(tickDownloadEtas,1000);
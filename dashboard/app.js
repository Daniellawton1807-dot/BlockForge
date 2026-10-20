/* Homebase dashboard. Live metrics are served by the same-origin Pages Function at /api/metrics. */
const defaults = {
  metricsEndpoint: "/api/metrics",
  downloadsEndpoint: "/api/downloads",
  refreshIntervalMs: 10000,
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

function downloadCard(item){
 const raw=Number(item.progress), progress=Number.isFinite(raw)?Math.max(0,Math.min(100,raw)):0;
 const status=String(item.status||"In queue");
 const hasEta=item.etaSeconds!==null&&item.etaSeconds!==undefined&&Number.isFinite(Number(item.etaSeconds));
 const eta=hasEta?formatEta(item.etaSeconds):(/queued/i.test(status)?"Pending":/paused/i.test(status)?"Paused":/stalled/i.test(status)?"Waiting":"Calculating");
 const title=String(item.name||"Untitled download");
 return '<article class="download-card"><div class="download-card-header"><span class="download-source">'+esc(item.source||"Downloader")+'</span><span class="download-state">'+esc(status)+'</span></div><h4 class="download-name" title="'+esc(title)+'">'+esc(title)+'</h4><div class="download-progress" role="progressbar" aria-label="'+esc(title)+' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(progress)+'"><span style="width:'+progress+'%"></span></div><div class="download-facts"><span>'+esc(item.category||"Download")+'</span><strong>'+Math.round(progress)+'%</strong><span>ETA '+esc(eta)+'</span></div></article>';
}
function formatEta(seconds){
 let value=Math.max(0,Math.floor(Number(seconds)));
 if(!Number.isFinite(value))return "Calculating";
 if(value<5)return "Finishing";
 if(value<60)return "Under 1m";
 const minutes=Math.ceil(value/60), hours=Math.floor(minutes/60), days=Math.floor(hours/24);
 if(days)return days+"d "+(hours%24)+"h";
 if(hours)return hours+"h "+(minutes%60)+"m";
 return minutes+"m";
}
function showDownloadsMessage(message,summary){
 const list=$("downloadList"), label=$("downloadSummary");
 if(!list||!label)return;
 label.textContent=summary;
 list.innerHTML='<div class="downloads-empty">'+esc(message)+'</div>';
}
function renderDownloads(data){
 const list=$("downloadList"), label=$("downloadSummary");
 if(!list||!label)return;
 const items=Array.isArray(data.items)?data.items:[];
 const sources=Array.isArray(data.sources)?data.sources:[];
 const warnings=sources.filter(source=>!source.connected).map(source=>esc(source.name)+": "+esc(source.message||"Unavailable"));
 label.textContent=items.length+" active "+(items.length===1?"download":"downloads");
 if(items.length){
  list.innerHTML=items.map(downloadCard).join()+(warnings.length?'<div class="download-warning">'+warnings.join(" · ")+'</div>':"");
 }else if(sources.length&&sources.every(source=>source.connected)){
  list.innerHTML='<div class="downloads-empty">No active downloads right now.</div>';
 }else{
  list.innerHTML='<div class="downloads-empty">Connect qBittorrent and SABnzbd in the protected Pages settings to view their queues.</div>'+(warnings.length?'<div class="download-warning">'+warnings.join(" · ")+'</div>':"");
 }
}
async function refreshDownloads(){
 if(!$("downloadList")||!$("downloadSummary"))return;
 const endpoint=safeUrl(config.downloadsEndpoint);
 if(!endpoint){showDownloadsMessage("Downloads are not configured yet.","Setup required");return;}
 try{
  const res=await fetch(endpoint,{cache:"no-store",credentials:"same-origin"});
  const data=await res.json().catch(()=>null);
  if(!res.ok){
   const code=data&&data.code;
   if(code==="secure_setup_required")showDownloadsMessage("Private downloads are locked until Cloudflare Access and protected downloader credentials are configured.","Secure setup required");
   else if(code==="access_required"||code==="access_denied")showDownloadsMessage("Sign in through Cloudflare Access to view private download details.","Sign-in required");
   else showDownloadsMessage("The download queue is unavailable right now.","Unavailable");
   return;
  }
  if(!data||!Array.isArray(data.items)||!Array.isArray(data.sources))throw new Error("Invalid downloads response");
  renderDownloads(data);
 }catch{
  showDownloadsMessage("The download queue is unavailable right now.","Unavailable");
 }
}
function refreshAll(){refreshMetrics();refreshDownloads();}

function formatBytes(n){if(!Number.isFinite(Number(n))||n<0)return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?1:0)+" "+u[i];}
function formatUptime(n){n=Math.max(0,Math.floor(Number(n)||0));const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60);return (d?d+"d ":"")+(h+"h "+m+"m");}
$("search").addEventListener("input",render);
$("refresh").addEventListener("click",()=>{refreshAll();const b=$("refresh");b.textContent="✓";setTimeout(()=>b.textContent="↻",800);});
render();refreshAll();if(Number(config.refreshIntervalMs)>=3000)setInterval(refreshAll,Math.min(Number(config.refreshIntervalMs),60000));
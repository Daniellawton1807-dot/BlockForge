/* Homebase dashboard. Live metrics are served by the same-origin Pages Function at /api/metrics. */
const defaults = {
  metricsEndpoint: "/api/metrics",
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
 return featured ? '<article class="service-card" data-service-name="' + esc(s.name) + '"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="service-info"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p></div>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'<span class="launch" title="Set this URL in config.js">Set URL</span>')+'</article>'
 : '<article class="app-card" data-service-name="' + esc(s.name) + '"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="card-copy"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p><div class="card-bottom"><span class="status '+(url?"configured":"")+'">'+(url?"URL configured":"Not configured")+'</span>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'')+'</div></div></article>';
}
function render(){
 const services=config.services.slice();
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

async function refreshRecentMedia(){
 const list = $("recentMediaList");
 if(!list) return;
 try{
  const response = await fetch("/api/media/recent",{cache:"no-store",credentials:"same-origin"});
  const data = await response.json().catch(()=>null);
  if(response.status===401){list.innerHTML='<div class="recent-media-empty">Sign in to the Media Hub to view recent imports.</div>';return;}
  if(!response.ok) throw new Error(data?.error||"Recent imports unavailable");
  const items=Array.isArray(data?.items)?data.items.slice(0,5):[];
  if(!items.length){list.innerHTML='<div class="recent-media-empty">No recent imported movies or episodes found yet.</div>';return;}
  list.innerHTML=items.map(item=>{
   const poster=safeUrl(item.posterUrl||"");
   const subtitle=item.mediaType==="tv"?[item.episodeLabel,item.episodeTitle].filter(Boolean).join(" · "):"Movie";
   const date=item.date?new Date(item.date).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"Recently imported";
   return '<article class="recent-media-item"><div class="recent-media-poster">'+(poster?'<img src="'+esc(poster)+'" alt="" loading="lazy">':'<span>'+(item.mediaType==="tv"?"TV":"FILM")+'</span>')+'</div><div class="recent-media-copy"><strong title="'+esc(item.title)+'">'+esc(item.title)+'</strong><span class="recent-media-episode" title="'+esc(subtitle)+'">'+esc(subtitle||"Recently imported")+'</span><small>'+esc(item.serviceName||"Sonarr/Radarr")+' · '+esc(date)+'</small></div></article>';
  }).join("");
 }catch(error){list.innerHTML='<div class="recent-media-empty">Could not load recent imports. Check the Media Hub connection.</div>';}
}

async function refreshActivity(){
 const feed=$("activityFeed"); if(!feed)return;
 const events=[];
 try{
  const response=await fetch("/api/media/recent",{cache:"no-store",credentials:"same-origin"});
  if(response.ok){
   const data=await response.json();
   for(const item of (Array.isArray(data.items)?data.items:[]).slice(0,20)){
    const date=Date.parse(item.date||"");
    const subtitle=item.mediaType==="tv"?[item.episodeLabel,item.episodeTitle].filter(Boolean).join(" · "):"Movie imported";
    events.push({date:Number.isFinite(date)?date:0,type:"success",icon:"✓",title:"Media imported",detail:String(item.title||"Untitled")+(subtitle?" · "+subtitle:"")+" · "+String(item.serviceName||"Sonarr/Radarr")});
   }
  } else if(response.status===401){
   events.push({date:Date.now(),type:"info",icon:"↗",title:"Media activity requires sign-in",detail:"Sign in to the Media Hub to show recent Sonarr/Radarr imports."});
  }
 }catch{}
 try{
  const response=await fetch("/api/metrics",{cache:"no-store",credentials:"same-origin"});
  if(response.ok){
   const m=await response.json();
   if(Number.isFinite(Number(m.diskPercent))&&Number(m.diskPercent)>=85)events.push({date:Date.now(),type:Number(m.diskPercent)>=95?"warning":"warning",icon:"!",title:"Storage usage is high",detail:"The monitored filesystem is "+Math.round(Number(m.diskPercent))+"% full."});
   if(Number.isFinite(Number(m.memoryPercent))&&Number(m.memoryPercent)>=90)events.push({date:Date.now(),type:"warning",icon:"!",title:"Memory usage is high",detail:"Memory utilization is "+Math.round(Number(m.memoryPercent))+"%."});
  }
 }catch{}
 events.sort((a,b)=>b.date-a.date);
 if(!events.length){feed.innerHTML='<div class="activity-empty">No recent events available. Import events appear after you sign in to the Media Hub; monitoring alerts appear when metrics are available.</div>';return;}
 feed.innerHTML=events.slice(0,12).map(e=>'<article class="activity-item"><span class="activity-icon '+e.type+'">'+e.icon+'</span><div class="activity-copy"><strong>'+esc(e.title)+'</strong><span>'+esc(e.detail)+'</span></div><time>'+ (e.date?new Date(e.date).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"Recent")+'</time></article>').join("");
}
$("activityRefresh")?.addEventListener("click",refreshActivity);

function formatBytes(n){if(!Number.isFinite(Number(n))||n<0)return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?1:0)+" "+u[i];}
function formatUptime(n){n=Math.max(0,Math.floor(Number(n)||0));const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60);return (d?d+"d ":"")+(h+"h "+m+"m");}
$("search").addEventListener("input",render);
$("refresh").addEventListener("click",()=>{refreshMetrics();const b=$("refresh");b.textContent="✓";setTimeout(()=>b.textContent="↻",800);});
render();refreshMetrics();refreshRecentMedia();refreshActivity();
const metricsRefreshInterval=Number(config.refreshIntervalMs);
if(metricsRefreshInterval>=3000)setInterval(refreshMetrics,Math.min(metricsRefreshInterval,60000));
setInterval(refreshRecentMedia,300000);
setInterval(refreshActivity,120000);
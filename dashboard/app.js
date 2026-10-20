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

function formatBytes(n){if(!Number.isFinite(Number(n))||n<0)return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?1:0)+" "+u[i];}
function formatUptime(n){n=Math.max(0,Math.floor(Number(n)||0));const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60);return (d?d+"d ":"")+(h+"h "+m+"m");}
$("search").addEventListener("input",render);
$("refresh").addEventListener("click",()=>{refreshMetrics();const b=$("refresh");b.textContent="✓";setTimeout(()=>b.textContent="↻",800);});
render();refreshMetrics();
const metricsRefreshInterval=Number(config.refreshIntervalMs);
if(metricsRefreshInterval>=3000)setInterval(refreshMetrics,Math.min(metricsRefreshInterval,60000));
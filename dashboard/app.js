/* Homebase dashboard. Set service URLs in config.js; hardware metrics need a secured monitoring endpoint. */
const defaults = {
  metricsEndpoint: "",
  refreshIntervalMs: 10000,
  services: [
    {name:"Sonarr",desc:"TV series management",url:"",icon:"S",tone:"purple",group:"media"},
    {name:"Radarr",desc:"Movie library management",url:"",icon:"R",tone:"blue",group:"media"},
    {name:"Prowlarr",desc:"Indexer management",url:"",icon:"P",tone:"orange",group:"media"},
    {name:"qBittorrent",desc:"Torrent downloads",url:"",icon:"qB",tone:"green",group:"downloads"},
    {name:"SABnzbd",desc:"Usenet downloads",url:"",icon:"S",tone:"orange",group:"downloads"},
    {name:"Jellyfin",desc:"Your media library",url:"",icon:"J",tone:"blue",group:"media"},
    {name:"Overseerr",desc:"Media requests",url:"",icon:"O",tone:"purple",group:"media"},
    {name:"CasaOS",desc:"Server app management",url:"",icon:"C",tone:"green",group:"system"}
  ]
};
const config = Object.assign({}, defaults, window.HOMEBASE_CONFIG || {});
config.services = Array.isArray(config.services) ? config.services : defaults.services;
const $ = id => document.getElementById(id);
const safeUrl = value => { try { const u = new URL(value); return ["http:","https:"].includes(u.protocol) ? u.href : ""; } catch { return ""; } };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function card(s,featured=false){
 const url=safeUrl(s.url), cls=["purple","blue","orange","green"].includes(s.tone)?s.tone:"purple";
 return featured ? '<article class="service-card"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="service-info"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p></div>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'<span class="launch" title="Set this URL in config.js">Set URL</span>')+'</article>'
 : '<article class="app-card"><div class="app-icon '+cls+'">'+esc(s.icon||s.name[0])+'</div><div class="card-copy"><h4>'+esc(s.name)+'</h4><p>'+esc(s.desc||"Self-hosted service")+'</p><div class="card-bottom"><span class="status '+(url?"configured":"")+'">'+(url?"URL configured":"Not configured")+'</span>'+(url?'<a class="launch" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>':'')+'</div></div></article>';
}
function render(){
 const services=config.services;
 $("appCount")?.replaceChildren(document.createTextNode(services.length));
 $("featured").innerHTML=services.filter(s=>["Sonarr","Radarr","qBittorrent","SABnzbd","Prowlarr","Jellyfin"].includes(s.name)).map(s=>card(s,true)).join("");
 const q=($("search").value||"").trim().toLowerCase();
 const filtered=services.filter(s=>(s.name+" "+(s.desc||"")+" "+(s.group||"")).toLowerCase().includes(q));
 $("appGrid").innerHTML=filtered.length?filtered.map(s=>card(s)).join(""):'<div class="empty">No applications match your search.</div>';
}
async function refreshMetrics(){
 const endpoint=safeUrl(config.metricsEndpoint);
 if(!endpoint){$("connectionLabel").textContent="Monitoring not connected";return;}
 try{
  const res=await fetch(endpoint,{cache:"no-store",credentials:"omit"});
  if(!res.ok)throw new Error("Metrics endpoint returned "+res.status);
  const d=await res.json();
  const cpu=Number(d.cpuPercent),ram=Number(d.memoryPercent),disk=Number(d.diskPercent);
  const set=(value,valueId,barId)=>{if(Number.isFinite(value)&&value>=0&&value<=100){$(valueId).innerHTML=Math.round(value)+'<small>%</small>' ;$(barId).style.width=value+'%';}};
  set(cpu,"cpuValue","cpuBar");set(ram,"ramValue","ramBar");set(disk,"diskValue","diskBar");
  if(d.memoryUsedBytes!=null&&d.memoryTotalBytes>0)$("ramNote").textContent=formatBytes(d.memoryUsedBytes)+" / "+formatBytes(d.memoryTotalBytes);
  if(d.diskUsedBytes!=null&&d.diskTotalBytes>0)$("diskNote").textContent=formatBytes(d.diskUsedBytes)+" / "+formatBytes(d.diskTotalBytes);
  if(d.uptimeSeconds!=null)$("cpuNote").textContent="Uptime "+formatUptime(d.uptimeSeconds);
  if(d.services&&typeof d.services==="object"){const vals=Object.values(d.services);const online=vals.filter(v=>v===true||v==="online").length;$("onlineValue").innerHTML=online+'<small> / '+vals.length+'</small>';$("onlineNote").textContent="Last check just now";}
  $("connectionLabel").textContent="Metrics connected";
 }catch(e){$("connectionLabel").textContent="Metrics endpoint unavailable";$("cpuNote").textContent="Could not retrieve live metrics";$("ramNote").textContent="Check endpoint and access policy";}
}
function formatBytes(n){if(!Number.isFinite(Number(n))||n<0)return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?1:0)+" "+u[i];}
function formatUptime(n){n=Math.max(0,Math.floor(Number(n)||0));const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60);return (d?d+"d ":"")+(h+"h "+m+"m");}
$("search").addEventListener("input",render);$("refresh").addEventListener("click",()=>{refreshMetrics();const b=$("refresh");b.textContent="✓";setTimeout(()=>b.textContent="↻",800);});
render();refreshMetrics();if(Number(config.refreshIntervalMs)>=3000)setInterval(refreshMetrics,Math.min(Number(config.refreshIntervalMs),60000));
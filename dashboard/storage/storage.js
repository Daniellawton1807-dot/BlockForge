const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function bytes(n){if(n===null||n===undefined||!Number.isFinite(Number(n)))return "—";let v=Number(n),u=["B","KB","MB","GB","TB"],i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i>=3?2:1)+" "+u[i];}
function rate(n){if(n===null||n===undefined||!Number.isFinite(Number(n)))return "I/O rate unavailable";return bytes(n)+"/s";}
function render(data){
 const disks=Array.isArray(data.disks)?data.disks:[];
 const mounted=disks.filter(d=>d.mounted);
 const total=disks.reduce((s,d)=>s+(Number.isFinite(Number(d.totalBytes))?Number(d.totalBytes):0),0);
 const used=disks.reduce((s,d)=>s+(Number.isFinite(Number(d.usedBytes))?Number(d.usedBytes):0),0);
 $("storageCount").textContent=String(disks.length);
 $("storageMounted").textContent=String(mounted.length);
 $("storageUsed").textContent=total?Math.round(used/total*100)+"%":"—";
 $("storageCapacityNote").textContent=total?bytes(used)+" used of "+bytes(total):"Capacity unavailable";
 $("storageConnection").textContent=disks.length+" volumes reported";
 $("storageUpdated").textContent="Updated "+new Date(data.updatedAt||Date.now()).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
 if(!disks.length){$("storageList").innerHTML='<div class="media-empty">Glances returned no mounted filesystems.</div>';return;}
 $("storageList").innerHTML=disks.map(d=>{
  const p=Number(d.percent),valid=Number.isFinite(p)&&p>=0&&p<=100;
  const state=d.mounted?"Mounted":"Not mounted";
  const tone=d.mounted?"is-mounted":"is-missing";
  return '<article class="storage-drive-card"><div class="storage-drive-icon">▤</div><div class="storage-drive-main"><div class="storage-drive-top"><div><h4>'+esc(d.name||d.mount||"Storage volume")+'</h4><p>'+esc(d.mount||"Unknown mount")+' · '+esc(d.filesystem||"Filesystem")+'</p></div><span class="storage-drive-state '+tone+'">'+state+'</span></div><div class="storage-capacity-line"><span>Capacity used</span><strong>'+(valid?Math.round(p)+"%":"Unavailable")+'</strong></div><div class="meter purple"><span style="width:'+(valid?p:0)+'%"></span></div><div class="storage-drive-facts"><span><small>Used</small><strong>'+bytes(d.usedBytes)+'</strong></span><span><small>Free</small><strong>'+bytes(d.freeBytes)+'</strong></span><span><small>Total</small><strong>'+bytes(d.totalBytes)+'</strong></span></div><div class="storage-io-line">'+(d.ioAvailable?'Read '+rate(d.readBytesPerSecond)+' · Write '+rate(d.writeBytesPerSecond):'Disk I/O activity not exposed by this Glances response')+'</div></div></article>';
 }).join("");
}
let loading=false;
async function loadStorage(){
 if(loading)return;loading=true;
 $("storageRefresh").textContent="…";
 try{
  const r=await fetch("/api/storage",{cache:"no-store",credentials:"same-origin"});
  const d=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(d?.error||"Storage endpoint returned HTTP "+r.status);
  render(d);
 }catch(e){
  $("storageConnection").textContent="Storage unavailable";
  $("storageList").innerHTML='<div class="media-empty">'+esc(e.message||"Could not load storage status.")+'<p>Check that the Glances endpoint is online.</p></div>';
 }finally{loading=false;$("storageRefresh").textContent="↻";}
}
$("storageRefresh").addEventListener("click",loadStorage);
$("restartServer").addEventListener("click",async()=>{
 const button=$("restartServer");
 if(!confirm("Restart the entire server now? All hosted services will go offline until it starts again."))return;
 button.disabled=true;button.textContent="Requesting…";
 $("restartStatus").textContent="Sending restart request to the secure server agent…";
 try{
  const r=await fetch("/api/storage",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify({action:"restart"})});
  const d=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(d?.error||"Restart request was not accepted.");
  $("restartStatus").textContent=d?.message||"Restart request accepted.";
  button.textContent="Request accepted";
 }catch(e){
  $("restartStatus").textContent=e.message||"Restart is not configured.";
  button.textContent="Restart server";
  button.disabled=false;
 }
});
loadStorage();
setInterval(loadStorage,30000);

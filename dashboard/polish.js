(() => {
  const $ = id => document.getElementById(id);
  const read = (key, fallback) => { try { const v=JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const favorites = () => read("homebase-favorites", []);
  const isFavorite = name => favorites().includes(name);
  const allWidgets = [
    ["metrics","Server metrics"],["featured","Media shortcuts heading"],["featuredGrid","Featured services"],["apps","Applications heading"],["appGrid","All applications"]
  ];
  const setTheme = theme => {
    document.documentElement.dataset.theme = theme;
    const btn=$("themeToggle"); if(btn){btn.textContent=theme==="light"?"☾":"☼";btn.title=theme==="light"?"Switch to dark theme":"Switch to light theme";}
    const meta=document.querySelector('meta[name="theme-color"]'); if(meta)meta.content=theme==="light"?"#f4f6fb":"#0b1020";
  };
  setTheme(read("homebase-theme","dark"));
  $("themeToggle")?.addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="light"?"dark":"light";write("homebase-theme",next);setTheme(next);});
  function applyWidgets(){
    const visible=read("homebase-widgets",allWidgets.map(x=>x[0]));
    document.querySelectorAll("[data-widget]").forEach(el=>el.hidden=!visible.includes(el.dataset.widget));
    const options=$("widgetOptions"); if(!options)return;
    options.innerHTML=allWidgets.map(([id,label])=>'<label class="widget-option"><input type="checkbox" data-widget-toggle="'+id+'" '+(visible.includes(id)?"checked":"")+'><span>'+label+'</span></label>').join("");
  }
  function openCustomize(){applyWidgets();$("customizePanel").hidden=false;$("customizeClose").focus();}
  function closeCustomize(){$("customizePanel").hidden=true;$("customizeOpen").focus();}
  $("customizeOpen")?.addEventListener("click",openCustomize);
  $("customizeClose")?.addEventListener("click",closeCustomize);
  $("customizeDone")?.addEventListener("click",closeCustomize);
  $("customizePanel")?.addEventListener("click",e=>{if(e.target.id==="customizePanel")closeCustomize();});
  $("widgetOptions")?.addEventListener("change",e=>{
    const input=e.target.closest("[data-widget-toggle]");if(!input)return;
    let visible=read("homebase-widgets",allWidgets.map(x=>x[0]));
    visible=input.checked?[...new Set([...visible,input.dataset.widgetToggle])]:visible.filter(x=>x!==input.dataset.widgetToggle);
    write("homebase-widgets",visible);applyWidgets();
  });
  $("layoutReset")?.addEventListener("click",()=>{localStorage.removeItem("homebase-widgets");applyWidgets();});
  applyWidgets();
  function paintFavorites(){
    document.querySelectorAll("[data-favorite]").forEach(btn=>{
      const on=isFavorite(btn.dataset.favorite);
      const star=on?"★":"☆";if(btn.textContent!==star)btn.textContent=star;btn.classList.toggle("is-favorite",on);
      btn.title=on?"Unpin favorite":"Pin favorite";btn.setAttribute("aria-label",(on?"Unpin ":"Pin ")+btn.dataset.favorite);
    });
  }
  document.addEventListener("click",e=>{
    const btn=e.target.closest("[data-favorite]");if(!btn)return;
    const name=btn.dataset.favorite;let list=favorites();
    list=list.includes(name)?list.filter(x=>x!==name):[...list,name];
    write("homebase-favorites",list);
    if(typeof render==="function")render();
    paintFavorites();
  });
  const overlay=$("commandPalette"),input=$("commandInput"),results=$("commandResults");
  let entries=[],selected=0,recentMediaEntries=[];
  const staticEntries=[
    {title:"Overview",subtitle:"Dashboard page",url:"/#overview",kind:"Page"},
    {title:"Media Hub",subtitle:"Search and manage movies and shows",url:"/media/",kind:"Page"},
    {title:"All applications",subtitle:"Browse every configured service",url:"/#apps",kind:"Page"},
    {title:"Toggle theme",subtitle:"Switch between light and dark appearance",action:"theme",kind:"Action"},
    {title:"Customize dashboard",subtitle:"Show or hide dashboard sections",action:"customize",kind:"Action"}
  ];
  function makeEntries(){
    const apps=(Array.isArray(window.HOMEBASE_CONFIG?.services)?window.HOMEBASE_CONFIG.services:[]).map(s=>({title:s.name,subtitle:s.desc||s.group||"Self-hosted service",url:s.url,kind:isFavorite(s.name)?"★ Favorite · App":"App"}));
    return [...staticEntries,...apps,...recentMediaEntries];
  }
  fetch("/api/media/recent",{cache:"no-store",credentials:"same-origin"}).then(r=>r.ok?r.json():null).then(d=>{recentMediaEntries=(Array.isArray(d?.items)?d.items:[]).slice(0,5).map(item=>({title:item.title,subtitle:[item.episodeLabel,item.episodeTitle].filter(Boolean).join(" · ")||"Recently imported",url:"/media/",kind:"Recent media"}));if(!overlay.hidden)renderResults(input.value);}).catch(()=>{});
  function renderResults(query){
    const q=query.trim().toLowerCase();
    const matches=makeEntries().filter(x=>(x.title+" "+x.subtitle+" "+x.kind).toLowerCase().includes(q));
    entries=matches.slice(0,12);selected=0;
    results.innerHTML=entries.length?entries.map((x,i)=>'<button type="button" class="command-result '+(i===0?"selected":"")+'" data-command-index="'+i+'"><span class="command-result-icon">'+(x.kind==="App"||x.kind.includes("Favorite")?"↗":x.kind==="Action"?"⚙":"⌘")+'</span><span class="command-result-copy"><strong>'+escapeHtml(x.title)+'</strong><small>'+escapeHtml(x.subtitle)+'</small></span><span class="command-result-kind">'+escapeHtml(x.kind)+'</span></button>').join(""):'<div class="command-no-results">No matches. Try an app name or open Media Hub to search your library.</div>';
  }
  function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function openPalette(seed=""){overlay.hidden=false;input.value=seed;renderResults(seed);input.focus();}
  function closePalette(){overlay.hidden=true;$("commandOpen").focus();}
  function activate(index){
    const item=entries[index];if(!item)return;
    if(item.action==="theme"){$("themeToggle").click();closePalette();return;}
    if(item.action==="customize"){closePalette();openCustomize();return;}
    if(item.url){location.href=item.url;return;}
  }
  $("commandOpen")?.addEventListener("click",()=>openPalette());
  input?.addEventListener("input",()=>renderResults(input.value));
  results?.addEventListener("click",e=>{const b=e.target.closest("[data-command-index]");if(b)activate(Number(b.dataset.commandIndex));});
  input?.addEventListener("keydown",e=>{
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!entries.length)return;selected=(selected+(e.key==="ArrowDown"?1:-1)+entries.length)%entries.length;results.querySelectorAll(".command-result").forEach((el,i)=>el.classList.toggle("selected",i===selected));results.querySelectorAll(".command-result")[selected]?.scrollIntoView({block:"nearest"});}
    if(e.key==="Enter"){e.preventDefault();activate(selected);}
    if(e.key==="Escape")closePalette();
  });
  overlay?.addEventListener("click",e=>{if(e.target===overlay)closePalette();});
  document.addEventListener("keydown",e=>{
    const target=e.target;const typing=target instanceof HTMLElement&&(target.isContentEditable||["INPUT","TEXTAREA","SELECT"].includes(target.tagName));
    if(e.key==="Escape"){if(!overlay.hidden)closePalette();if(!$("customizePanel").hidden)closeCustomize();return;}
    if(!typing&&(e.key==="/"||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"))){e.preventDefault();openPalette();}
  });
  const observer=new MutationObserver(paintFavorites);
  ["featured","appGrid"].forEach(id=>{const el=$(id);if(el)observer.observe(el,{childList:true,subtree:true});});
  paintFavorites();
})();
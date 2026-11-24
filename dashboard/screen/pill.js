/* The MinePad's own bar (slim white pill, Home / Back) for pages that are not the shared page, wired to the shared home instead of the old one.
   Only shows when this PC has opened the shared home before (shared.html remembers its address in wd.sbhome). */
(() => {
  let home = null; try { home = localStorage.getItem("wd.sbhome"); } catch {}
  if (!home || document.getElementById("__wdpill")) return;
  const st = document.createElement("style"); st.textContent = "#__wdbar{display:none!important}"; document.head.append(st);   // the mod's own pill goes to the old home
  const svg = d => { const ns = "http://www.w3.org/2000/svg", e = document.createElementNS(ns, "svg"), q = document.createElementNS(ns, "path"); e.setAttribute("viewBox", "0 0 24 24"); e.setAttribute("width", "22"); e.setAttribute("height", "22"); e.setAttribute("fill", "#fff"); q.setAttribute("d", d); e.append(q); return e; };
  const wrap = document.createElement("div"), pill = document.createElement("div"); wrap.id = "__wdpill"; wrap.style.cssText = "position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:2147483646;font:600 15px system-ui,sans-serif;color:#fff;";
  const SLIM = "height:7px;width:150px;border-radius:99px;background:#fffd;box-shadow:0 0 8px #000a;transition:all .2s;cursor:pointer;", OPEN = "height:auto;width:auto;border-radius:99px;background:#1c1c1ee6;backdrop-filter:blur(14px);box-shadow:0 4px 18px #000a;transition:all .2s;display:flex;gap:8px;padding:6px;cursor:default;";
  let open = false, t; pill.style.cssText = SLIM;
  const btn = (path, label, fn) => { const b = document.createElement("div"), l = document.createElement("span"); l.style.marginLeft = "6px"; l.textContent = label; b.append(svg(path), l);
    b.style.cssText = "display:flex;align-items:center;padding:8px 14px;border-radius:99px;background:#ffffff22;white-space:nowrap;"; b.onmouseenter = () => { b.style.background = "#ffffff55"; }; b.onmouseleave = () => { b.style.background = "#ffffff22"; }; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
  const items = [btn("M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z", "Home", () => { location.href = home; }), btn("M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z", "Back", () => history.back())];
  const show = () => { clearTimeout(t); if (open) return; open = true; pill.style.cssText = OPEN; pill.replaceChildren(...items); };
  wrap.onmouseenter = show; wrap.onclick = show; wrap.onmouseleave = () => { t = setTimeout(() => { open = false; pill.replaceChildren(); pill.style.cssText = SLIM; }, 700); };
  wrap.append(pill); document.body.append(wrap);
})();

/* The brain (Daniel, 2026-11-13): the home screen's live map of what Jarvis has and knows, from /api/jarvis/brain, as a force graph
   filling the screen behind the panels. Drag nodes, drag the background to pan, scroll or pinch to zoom, click a node to see what it
   links to. A tool Jarvis uses lights up with the path back to him. It draws nothing once settled, nor while an answer is open or the
   tab is hidden, so an idle page costs no CPU. Everything from the server is drawn on the canvas or set with textContent. */
(() => {
  const $ = id => document.getElementById(id);
  const KINDS = [
    { id: "skill", name: "Skills", color: "#8FB8A8" }, { id: "tool", name: "Tools", color: "#6E8FB8" },
    { id: "service", name: "Services", color: "#C9A86A" }, { id: "show", name: "Shows", color: "#A9A4D8" },
    { id: "film", name: "Films", color: "#D08C6A" }, { id: "person", name: "People", color: "#E6B8C8" },
    { id: "memory", name: "Memories", color: "#9FCB8F" }];
  const COLOR = { core: "#ECEDEF" };
  KINDS.forEach(k => { COLOR[k.id] = k.color; });
  const RADIUS = { core: 10, skill: 5, tool: 2.4, service: 4.5, show: 2.2, film: 2.2, person: 6.5, memory: 4.5 };
  const KIND_NAMES = { core: "Jarvis", skill: "Skill", tool: "Tool", service: "Service", show: "Show", film: "Film", person: "Person", memory: "Memory" };
  const PULSE_MS = 3200;
  let api = null, nodes = [], links = [], by = {}, adj = {}, hidden = {}, sel = null, hover = null, query = "", labels = true;
  let graphData = null, archiveExpanded = false, archiveCount = 0;
  let alpha = 0, raf = 0, view = { k: 0.6, px: 0, py: 0 }, drag = null, press = null, pulses = {}, fitted = false, repel = 90, linkLen = 46;
  let box = null, canvas = null, ctx = null, inspect = null, note = null, w = 0, h = 0, dpr = 1;
  const camera = { pitch: 0.48, yaw: 0, focal: 760 };

  window.addEventListener("jarvis:ready", e => { api = e.detail.api; if (!nodes.length) load(); });
  window.addEventListener("jarvis:tool", e => pulse("t:" + e.detail));

  async function load() {
    const r = await api("brain");
    if (!r.ok || !Array.isArray(r.data.nodes)) { const c = $("brainCount"); if (c) c.textContent = "The brain isn't reachable"; return; }
    graphData = r.data;
    build(graphData);
    mount();
    alpha = 1; wake();
  }

  function build(data) {
    nodes = []; links = []; by = {}; adj = {};
    const memories = data.nodes.filter(n => n.cat === "memory"), keep = 18;
    archiveCount = Math.max(0, memories.length - keep);
    const recentMemoryIds = new Set(memories.slice(-keep).map(n => n.id));
    const graphNodes = data.nodes.filter(n => n.cat !== "memory" || archiveExpanded || recentMemoryIds.has(n.id));
    if (archiveCount && !archiveExpanded) graphNodes.push({ id: "m:archive", label: `Earlier memories (${archiveCount})`, cat: "memory", archive: true });
    graphNodes.forEach(n => {
      const node = { ...n, x: 0, y: 0, z: (Math.random() - 0.5) * ({ show: 210, film: 230, tool: 150 }[n.cat] || 120), vx: 0, vy: 0, vz: 0, deg: 0, r: RADIUS[n.cat] || 3 };
      const ring = { skill: 170, tool: 270, service: 230, show: 430, film: 470, person: 150, memory: 200 }[n.cat] || 0, a = Math.random() * Math.PI * 2;
      node.x = Math.cos(a) * ring * (0.7 + Math.random() * 0.6); node.y = Math.sin(a) * ring * (0.7 + Math.random() * 0.6);
      if (n.cat === "core") node.z = 0;
      nodes.push(node); by[n.id] = node; adj[n.id] = [];
    });
    data.links.forEach(([a, b, len]) => {
      if (!by[a] || !by[b] || (by[a].archive || by[b].archive)) return;
      links.push({ a: by[a], b: by[b], len }); by[a].deg++; by[b].deg++; adj[a].push(by[b]); adj[b].push(by[a]);
    });
    if (archiveCount && !archiveExpanded && by.core && by["m:archive"]) {
      const a = by.core, b = by["m:archive"]; links.push({ a, b, len: 2.2 }); a.deg++; b.deg++; adj[a.id].push(b); adj[b.id].push(a);
    }
    nodes.forEach(n => { if (n.cat === "skill") n.r = 4 + Math.sqrt(n.deg) * 1.3; if (n.cat === "service") n.r = 4 + Math.sqrt(n.deg) * 0.9; });
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function button(text, cls, onClick) { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", onClick); return b; }

  function rebuildMemories(expanded) {
    archiveExpanded = expanded; hidden = {}; sel = null; hover = null;
    build(graphData);
    $("brainSide").replaceChildren(); $("brainFilter").replaceChildren();
    sidebar(); filter(); alpha = 1; fitted = false; view.px = 0; view.py = 0; wake();
  }

  function mount() {
    box = $("brain");
    if (!box || canvas) return;
    canvas = el("canvas"); canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Jarvis's brain: ${nodes.length} things he has and knows, and how they link. Drag to move, scroll to zoom, click one to see its links.`);
    ctx = canvas.getContext("2d");
    box.append(canvas);
    box.hidden = false;
    const count = $("brainCount");
    if (count) count.textContent = `${nodes.length} nodes · ${links.length} links`;
    sidebar();
    filter();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", () => { if (hover) { hover = null; draw(); } });
    canvas.addEventListener("wheel", wheel, { passive: false });
    new ResizeObserver(() => { resize(); draw(); }).observe(box);
    new MutationObserver(() => { if (active()) wake(); }).observe(document.body, { attributes: true, attributeFilter: ["data-scene", "data-mode"] });
    document.addEventListener("visibilitychange", () => { if (active()) wake(); });
    resize();
  }

  /* the left panel: find, labels and fit, the inspector, the busiest hubs and the forces */
  function sidebar() {
    const side = $("brainSide");
    if (!side) return;
    const find = el("input", "bs-search"); find.type = "search"; find.placeholder = "Search the brain…"; find.setAttribute("aria-label", "Search the brain");
    note = el("div", "bs-note", "Try “Traitors”, “Mum” or “timer”");
    find.addEventListener("input", () => {
      query = find.value.trim().toLowerCase();
      const hits = query ? nodes.filter(n => n.label.toLowerCase().includes(query)) : [];
      note.textContent = !query ? "Try “Traitors”, “Mum” or “timer”" : hits.length === 1 ? "1 match, focused" : `${hits.length} matches`;
      if (hits.length === 1) focus(hits[0]); else draw();
    });
    const lab = button("Labels", "", () => { labels = !labels; lab.setAttribute("aria-pressed", String(labels)); draw(); });
    lab.setAttribute("aria-pressed", "true");
    const row = el("div", "bs-row");
    row.append(button("Fit", "", () => { view.px = 0; view.py = 0; view.k = fitScale(); draw(); }), lab,
               button("Re-settle", "", () => { nodes.forEach(n => { n.vx += (Math.random() - 0.5) * 30; n.vy += (Math.random() - 0.5) * 30; }); alpha = 1; fitted = false; wake(); }));
    const s1 = el("div"); s1.append(find, note);
    const s2 = el("div"); s2.append(el("div", "bs-label", "Inspector"));
    inspect = el("div", "bs-inspect"); s2.append(inspect); select(null);
    const s3 = el("div", "bs-hide-small"); s3.append(el("div", "bs-label", "Top hubs"));
    const hubs = el("div", "bs-hubs");
    nodes.filter(n => n.cat === "skill" || n.cat === "service").sort((a, b) => b.deg - a.deg).slice(0, 8).forEach(n => {
      const b = button("", "", () => focus(n)), dot = el("i"); dot.style.background = COLOR[n.cat];
      b.append(dot, el("span", "", n.label), el("em", "", String(n.deg))); hubs.append(b);
    });
    s3.append(hubs);
    const s4 = el("div", "bs-hide-small"); s4.append(el("div", "bs-label", "Forces"));
    [["Spread", 20, 200, () => repel, v => { repel = v; }], ["Link length", 10, 120, () => linkLen, v => { linkLen = v; }]].forEach(([name, min, max, get, set]) => {
      const lab2 = el("label", "bs-force"), input = el("input"); input.type = "range"; input.min = min; input.max = max; input.value = get();
      input.addEventListener("input", () => { set(+input.value); alpha = Math.max(alpha, 0.5); wake(); });
      lab2.append(el("span", "", name), input); s4.append(lab2);
    });
    side.append(s1, row, s2, s3, s4);
  }

  /* the right panel: show or hide each kind of node */
  function filter() {
    const box2 = $("brainFilter");
    if (!box2) return;
    box2.append(el("div", "bs-label", "Filter"));
    KINDS.forEach(k => {
      const count = nodes.filter(n => n.cat === k.id).length;
      if (!count) return;
      const b = button("", "", () => { hidden[k.id] = !hidden[k.id]; b.setAttribute("aria-pressed", String(!hidden[k.id])); if (sel && hidden[sel.cat]) select(null); draw(); });
      b.setAttribute("aria-pressed", "true"); b.title = `Show or hide ${k.name.toLowerCase()}`;
      const dot = el("i"); dot.style.background = k.color;
      b.append(dot, el("span", "", k.name), el("em", "", String(count)));
      box2.append(b);
    });
  }

  function active() { return canvas && !document.hidden && !document.body.dataset.scene && !box.hidden; }
  function visible(n) { return n.cat === "core" || !hidden[n.cat]; }

  function resize() {
    if (!canvas) return;
    w = box.clientWidth; h = box.clientHeight; dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }

  /* the open space between the panels, where Jarvis sits */
  function space() {
    const b = box.getBoundingClientRect(), left = document.querySelector(".col.left"), right = document.querySelector(".col.right");
    let l = 0, r = w, t = 0, bt = h;
    const lr = left && left.offsetParent ? left.getBoundingClientRect() : null, rr = right && right.offsetParent ? right.getBoundingClientRect() : null;
    if (lr && lr.top < b.bottom && lr.bottom > b.top && lr.right - b.left < w / 2) l = lr.right - b.left;
    if (rr && rr.top < b.bottom && rr.bottom > b.top && rr.left - b.left > w / 2) r = rr.left - b.left;
    if (w > 1000) { t = 64; bt = h - 150; }
    return { l, r, t, b: bt };
  }
  function origin() { const s = space(); return { x: (s.l + s.r) / 2 + view.px, y: (s.t + s.b) / 2 + view.py }; }
  function project(n) {
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const rx = n.x * cy + n.z * sy, rz = -n.x * sy + n.z * cy;
    const depth = n.y * sp + rz * cp, scale = camera.focal / Math.max(260, camera.focal + depth);
    return { x: rx * scale, y: (n.y * cp - rz * sp) * scale, scale, depth };
  }

  function wake() { if (!raf && active()) raf = requestAnimationFrame(frame); }

  function frame() {
    raf = 0;
    if (!active()) return;
    const now = performance.now(), busy = alpha > 0.004 || drag || Object.values(pulses).some(t => t > now) || document.body.dataset.mode === "thinking";
    if (alpha > 0.004 || drag) tick();
    draw();
    if (busy) raf = requestAnimationFrame(frame);
  }

  function tick() {
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j], dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z, d2 = dx * dx + dy * dy + dz * dz + 0.01;
        if (d2 > 160000) continue;
        const f = repel * (p.r + q.r + 2) * 0.6 / d2 * alpha;
        p.vx -= dx * f; p.vy -= dy * f; p.vz -= dz * f; q.vx += dx * f; q.vy += dy * f; q.vz += dz * f;
      }
    }
    for (const l of links) {
      const ex = l.b.x - l.a.x, ey = l.b.y - l.a.y, ez = l.b.z - l.a.z, d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1, g = (d - linkLen * l.len) / d * 0.06 * alpha;
      l.a.vx += ex * g; l.a.vy += ey * g; l.a.vz += ez * g; l.b.vx -= ex * g; l.b.vy -= ey * g; l.b.vz -= ez * g;
    }
    for (const n of nodes) {
      if (n.id === "core") { n.x = 0; n.y = 0; n.z = 0; n.vx = n.vy = n.vz = 0; continue; }
      n.vx -= n.x * 0.004 * alpha; n.vy -= n.y * 0.004 * alpha; // z is free to settle into a 3D volume; do not pull it back to the flat plane
      if (n === drag) { n.vx = n.vy = n.vz = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6; n.vz *= 0.6; n.x += n.vx; n.y += n.vy; n.z += n.vz;
    }
    alpha *= 0.985;
    if (!fitted && alpha < 0.05) { fitted = true; view.px = 0; view.py = 0; view.k = fitScale(); }
  }

  /* the zoom at which nearly everything shown fits in the open space; the furthest few may sit past its edge */
  function fitScale() {
    if (!w) return 0.5;
    const s = space(), cx = (s.l + s.r) / 2, cy = (s.t + s.b) / 2, pad = 20, limits = [];
    for (const n of nodes) {
      if (n.cat === "core" || !visible(n)) continue;
      const p = project(n);
      const kx = p.x > 1 ? (s.r - cx - pad) / p.x : p.x < -1 ? (cx - s.l - pad) / -p.x : Infinity;
      const ky = p.y > 1 ? (s.b - cy - pad) / p.y : p.y < -1 ? (cy - s.t - pad) / -p.y : Infinity;
      limits.push(Math.min(kx, ky));
    }
    if (!limits.length) return 0.5;
    limits.sort((a, b) => a - b);
    return Math.max(0.2, Math.min(1.4, limits[Math.floor(limits.length * 0.04)]));
  }

  function draw() {
    if (!ctx || !active()) return;
    const o = origin(), k = view.k, now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * o.x, dpr * o.y);
    const near = {};
    if (sel) { near[sel.id] = 1; adj[sel.id].forEach(n => { near[n.id] = 1; }); }
    const lit = {};
    Object.entries(pulses).forEach(([id, until]) => { if (until > now && by[id]) { lit[id] = (until - now) / PULSE_MS; adj[id].forEach(n => { if (n.cat === "skill") lit[n.id] = lit[id]; }); } });
    ctx.lineWidth = 0.8 / k;
    for (const l of links) {
      if (!visible(l.a) || !visible(l.b)) continue;
      const on = sel && (l.a === sel || l.b === sel), glow = (lit[l.a.id] && (lit[l.b.id] || l.b.id === "core")) || (lit[l.b.id] && (lit[l.a.id] || l.a.id === "core"));
      ctx.globalAlpha = glow ? 0.9 : sel ? (on ? 0.7 : 0.03) : 0.12;
      ctx.strokeStyle = glow ? "#ECEDEF" : on ? COLOR[l.a === sel ? l.b.cat : l.a.cat] : "#8C97A3";
      const a = project(l.a), b = project(l.b);
      ctx.globalAlpha *= Math.max(0.035, 1 - Math.max(0, (a.depth + b.depth) / 2) / 900);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const thinking = document.body.dataset.mode === "thinking";
    if (thinking) {
      const routes = links.filter(l => l.a.id === "core" && l.b.cat === "skill").slice(0, 8);
      const phase = now / 1200;
      routes.forEach((l, i) => {
        const t = (phase + i / Math.max(1, routes.length)) % 1, a = project(l.a), b = project(l.b);
        for (const trail of [0, 0.09, 0.18]) {
          const q = (t - trail + 1) % 1; ctx.globalAlpha = (1 - trail * 3.4) * (0.72 + 0.28 * Math.sin(now / 90 + i));
          ctx.fillStyle = trail ? "#75D8E8" : "#F6E7A8"; ctx.shadowColor = "#6EDAF3"; ctx.shadowBlur = trail ? 7 / k : 13 / k;
          ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * q, a.y + (b.y - a.y) * q, (trail ? 1.7 : 2.5) / k, 0, Math.PI * 2); ctx.fill();
        }
      }); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    for (const n of nodes) {
      if (!visible(n)) continue;
      const hit = query && n.label.toLowerCase().includes(query);
      if (n.cat === "core") {  // Jarvis himself: a ring that breathes while he's thinking
        const r = n.r + (thinking ? Math.sin(now / 220) * 2 : 0);
        ctx.globalAlpha = 1; ctx.fillStyle = "#0D0F12"; ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = thinking ? "#D6A35C" : "#8FB8A8"; ctx.lineWidth = 1.6 / k; ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = COLOR.core; ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 0.8 / k;
        continue;
      }
      ctx.globalAlpha = lit[n.id] ? 1 : sel ? (near[n.id] ? 1 : 0.1) : query ? (hit ? 1 : 0.12) : 0.9;
      ctx.fillStyle = COLOR[n.cat];
      const p = project(n), radius = (n.r + (lit[n.id] ? 2 : 0)) * p.scale;
      ctx.globalAlpha *= Math.max(0.3, 1 - Math.max(0, p.depth) / 1100);
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
      if (n === sel || n === hover || hit || lit[n.id]) {
        ctx.globalAlpha = lit[n.id] ? lit[n.id] : 1; ctx.strokeStyle = "#ECEDEF"; ctx.lineWidth = 1.4 / k;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius + (lit[n.id] ? 6 : 3) / k, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 0.8 / k;
      }
    }
    if (labels) {
      ctx.font = `${11 / k}px Inter, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const n of nodes) {
        if (!visible(n)) continue;
        const hit = query && n.label.toLowerCase().includes(query);
        const show = n.cat === "core" || (sel ? near[n.id] : lit[n.id] || hit || n === hover || n.cat === "skill" || n.cat === "person" || (n.cat === "service" && k > 0.6) || k > 1.7);
        if (!show) continue;
        ctx.globalAlpha = 1; ctx.fillStyle = n === sel || n.cat === "core" ? "#ECEDEF" : "#AEB3BA";
        if (n.cat === "core") { ctx.font = `600 ${12 / k}px Inter, system-ui, sans-serif`; ctx.fillText("Jarvis", 0, n.r + 10 / k); ctx.font = `${11 / k}px Inter, system-ui, sans-serif`; continue; }
        const p = project(n);
        ctx.globalAlpha = Math.max(0.45, 1 - Math.max(0, p.depth) / 1100);
        ctx.fillText(n.label.length > 34 ? n.label.slice(0, 33) + "…" : n.label, p.x, p.y + n.r * p.scale + 3 / k);
      }
    }
    ctx.globalAlpha = 1;
  }

  function at(e) {
    const b = canvas.getBoundingClientRect(), o = origin(), k = view.k;
    const x = (e.clientX - b.left - o.x) / k, y = (e.clientY - b.top - o.y) / k;
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (!visible(n)) continue;
      const p = project(n), d = (p.x - x) ** 2 + (p.y - y) ** 2, r = n.r * p.scale + 8 / k;
      if (d < r * r && d < bd) { bd = d; best = n; }
    }
    return { node: best, x, y, sx: e.clientX, sy: e.clientY };
  }

  const touches = new Map();
  function down(e) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (touches.size > 1) { press = null; drag = null; return; }
    press = at(e); press.moved = false;
    if (press.node && press.node.cat !== "core") { drag = press.node; alpha = Math.max(alpha, 0.25); wake(); }
    canvas.style.cursor = "grabbing";
  }
  function move(e) {
    const prev = touches.get(e.pointerId);
    if (touches.size === 2 && prev) {  // pinch to zoom
      const [a, b] = [...touches.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [c, d] = [...touches.values()], after = Math.hypot(c.x - d.x, c.y - d.y);
      if (before > 0) { view.k = Math.max(0.15, Math.min(5, view.k * after / before)); draw(); }
      return;
    }
    if (prev) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (press) {
      if (Math.abs(e.clientX - press.sx) + Math.abs(e.clientY - press.sy) > 4) press.moved = true;
      if (drag) { const p = at(e), depth = project(drag); drag.x += (p.x - depth.x) / depth.scale; drag.y += (p.y - depth.y) / depth.scale / Math.cos(camera.pitch); alpha = Math.max(alpha, 0.15); wake(); }
      else if (prev) {
        if (e.shiftKey) { view.px += e.clientX - prev.x; view.py += e.clientY - prev.y; }
        else { camera.yaw += (e.clientX - prev.x) * 0.004; camera.pitch = Math.max(-0.9, Math.min(0.9, camera.pitch + (e.clientY - prev.y) * 0.003)); }
        draw();
      }
      return;
    }
    const h2 = at(e).node;
    if (h2 !== hover) { hover = h2; canvas.style.cursor = h2 ? "pointer" : "grab"; draw(); }
  }
  function up(e) {
    touches.delete(e.pointerId);
    if (press && !press.moved) select(press.node);
    press = null; drag = null; canvas.style.cursor = "grab";
  }
  function wheel(e) {
    e.preventDefault();
    const b = canvas.getBoundingClientRect(), o = origin(), mx = e.clientX - b.left, my = e.clientY - b.top;
    const k = Math.max(0.15, Math.min(5, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.px += (mx - o.x) * (1 - k / view.k); view.py += (my - o.y) * (1 - k / view.k); view.k = k;
    draw();
  }

  function focus(n) {
    select(n);
    view.k = Math.max(view.k, 0.9);
    const s = space(), o = origin();
    const p = project(n);
    view.px += (s.l + s.r) / 2 - (o.x + p.x * view.k); view.py += (s.t + s.b) / 2 - (o.y + p.y * view.k);
    draw();
  }

  function suggestion(n) {
    if (n.cat === "show") return `Play the newest episode of ${n.label}`;
    if (n.cat === "film") return `Play ${n.label}`;
    if (n.cat === "service") return `How's ${n.label} doing?`;
    if (n.cat === "skill") return `What can you do with ${n.label.toLowerCase()}?`;
    if (n.cat === "tool") return `What does ${n.label} do?`;
    return "";
  }

  function select(n) {
    sel = n || null;
    if (!inspect) return;
    inspect.replaceChildren();
    if (!sel) {
      inspect.append(el("span", "", "Click a node to focus it: only it and what it links to stay lit. Drag nodes to move them, the background to pan, scroll to zoom."));
      draw();
      return;
    }
    const k = el("div", "k"), dot = el("i"); dot.style.background = COLOR[sel.cat];
    k.append(dot, el("span", "", `${KIND_NAMES[sel.cat] || sel.cat} · ${sel.deg} link${sel.deg === 1 ? "" : "s"}`));
    const list = el("div", "links");
    adj[sel.id].filter(visible).filter(n => n.cat !== "core").slice(0, 14).forEach(n => {
      list.append(button(n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label, "", () => focus(n)));
    });
    const acts = el("div", "acts"), ask = suggestion(sel);
    if (ask) { const go = button("Ask Jarvis", "go", () => { const c = $("command"); if (c) { c.value = ask; c.focus(); } }); go.title = ask; acts.append(go); }
    if (sel.archive) acts.append(button("Expand older memories", "go", () => rebuildMemories(true)));
    else if (archiveExpanded && sel.cat === "memory") acts.append(button("Collapse older memories", "", () => rebuildMemories(false)));
    acts.append(button("Clear", "", () => select(null)));
    inspect.append(k, el("b", "", sel.label), list, acts);
    draw();
  }

  function pulse(id) {
    if (!by[id]) return;
    pulses[id] = performance.now() + PULSE_MS;
    wake();
  }
})();

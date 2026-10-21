/* ================================================================
   人物关系网络图（纯前端力导向布局，无第三方依赖，离线可用）
   依赖 index.html 内联脚本里的全局工具：$ $$ T esc personById companyById coName groupLabel openPerson showView debounce
   数据依赖 data.js 的 DATA.personAliases / orgAliases / orgLabels / schoolAliases
   ================================================================ */
const NET_GROUP_COLOR = {global_bd:'#2563eb',global_rnd:'#7c3aed',china_mgmt:'#be123c',china_bd:'#dc6803',china_rnd:'#0891b2',venture:'#b7791f'};
const NET = {
  mode:'org', includeCurrent:false, topOnly:false, minWeight:1,
  layout:'radial', clusterBy:'group',
  company:'', group:'',
  nodes:[], edges:[], byId:new Map(), adj:new Map(), pairKeys:new Map(),
  w:900, h:560, dpr:1, scale:1, ox:0, oy:0,
  hover:null, selected:null, drag:null, pan:null, alpha:1,
  imgs:new Map(), ctx:null, canvas:null, masked:0, pin:null, sim:null, hasD3:false
};

function netPersonLabel(p){ return (LANG === 'en' ? (p.name || p.name_zh) : (p.name_zh || p.name)) || p.id; }
function netOrgKey(org){ const t = String(org || '').trim(); return t ? ((DATA.orgAliases || {})[t] || '') : ''; }
function netOrgLabel(key){ return (DATA.orgLabels || {})[key] || key; }
function netSchoolKey(school){ const t = String(school || '').trim(); return t ? ((DATA.schoolAliases || {})[t] || '') : ''; }
function netLabelOf(key){ return NET.mode === 'org' ? netOrgLabel(key) : key; }

/** 某人在当前模式下拥有的特征 key 集合（公司 or 学校） */
function netKeySet(p){
  const out = new Set();
  if(NET.mode === 'org'){
    for(const e of (p.linkedin_exp || [])){ const k = netOrgKey(e.org); if(k) out.add(k); }
    out.delete(p.company_id);                      // 默认只看「历史公司」
    if(NET.includeCurrent) out.add(p.company_id);  // 开关打开时才计入当前公司
  } else {
    const list = [];
    for(const e of (p.linkedin_edu || [])){ const k = netSchoolKey(e.school); if(k) list.push(k); }
    (NET.topOnly ? list.slice(0, 1) : list).forEach(k => out.add(k));
  }
  return out;
}

/** 依据当前筛选重建节点与边 */
function netRebuild(){
  const pool = DATA.people.filter(p =>
    (!NET.company || p.company_id === NET.company) &&
    (!NET.group || p.group === NET.group));

  const keys = new Map();
  for(const p of pool){ const s = netKeySet(p); if(s.size) keys.set(p.id, s); }

  const byKey = new Map();
  for(const [id, set] of keys) for(const k of set){
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(id);
  }

  const edgeMap = new Map();
  for(const [k, ids] of byKey){
    if(ids.length < 2) continue;
    if(ids.length > 80) continue;   // 过滤「全员同源」式密集团，避免糊成一团
    for(let i = 0; i < ids.length; i++) for(let j = i + 1; j < ids.length; j++){
      const a = ids[i], b = ids[j];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      let e = edgeMap.get(ek);
      if(!e){ e = { a, b, w:0, keys:[] }; edgeMap.set(ek, e); }
      e.w++; e.keys.push(k);
    }
  }

  const edges = [...edgeMap.values()].filter(e => e.w >= NET.minWeight);
  const used = new Set();
  edges.forEach(e => { used.add(e.a); used.add(e.b); });
  // 搜索定位到的人即使没有共同项，也强制留在图里（否则无法聚焦）
  const poolIds = new Set(pool.map(p => p.id));
  if(NET.pin && poolIds.has(NET.pin)) used.add(NET.pin);
  NET.masked = Math.max(0, keys.size - used.size);

  const nodes = [...used].map(id => ({ id, p: personById(id), x:0, y:0, vx:0, vy:0, deg:0 }));
  NET.nodes = nodes;
  NET.edges = edges;
  NET.byId = new Map(nodes.map(n => [n.id, n]));

  NET.pairKeys = new Map();
  for(const e of edges){
    NET.pairKeys.set(e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a, e.keys);
  }

  const adj = new Map();
  nodes.forEach(n => adj.set(n.id, new Map()));
  for(const e of edges){
    adj.get(e.a).set(e.b, e.w); adj.get(e.b).set(e.a, e.w);
    NET.byId.get(e.a).deg++; NET.byId.get(e.b).deg++;
  }
  NET.adj = adj;
  if(NET.selected && !NET.byId.has(NET.selected)) NET.selected = null;
  if(NET.hover && !NET.byId.has(NET.hover)) NET.hover = null;

  netLayout();
  netRefreshChrome();
  netPanelRender();
  netDraw();
}

/** 初始位置：黄金角螺旋铺开（按画布长宽比铺成椭圆） */
function netInitPositions(){
  const n = NET.nodes.length;
  const cx = NET.w / 2, cy = NET.h / 2;
  const rx = NET.w * 0.40, ry = NET.h * 0.40;
  NET.nodes.forEach((node, i) => {
    const a = i * 2.399963;
    const r = Math.sqrt((i + 0.5) / Math.max(1, n));
    node.x = cx + rx * r * Math.cos(a);
    node.y = cy + ry * r * Math.sin(a);
    node.vx = 0; node.vy = 0;
  });
}

/** 宽屏画布：把布局在水平方向拉开，避免图挤在中间 */
function netStretchX(){
  if(NET.layout === 'radial') return;
  const ratio = NET.w / Math.max(1, NET.h);
  const stretch = Math.max(1, Math.min(2.4, ratio / 1.15));
  if(stretch > 1.02){
    const cx = NET.w / 2;
    NET.nodes.forEach(n => { n.x = cx + (n.x - cx) * stretch; });
  }
}

/** 从某点出发的跳数（用于径向布局与邻域高亮） */
function netHops(root){
  const hop = new Map();
  if(!root) return hop;
  hop.set(root, 0);
  const queue = [root];
  while(queue.length){
    const cur = queue.shift();
    const nb = NET.adj.get(cur);
    if(!nb) continue;
    nb.forEach((w, id) => {
      if(!hop.has(id)){ hop.set(id, hop.get(cur) + 1); queue.push(id); }
    });
  }
  return hop;
}

/** 布局入口：初始化位置 → 跑选定的布局 → 宽屏拉伸 */
function netLayout(){
  if(NET.layout === 'radial'){ netPlaceRadial(); netStretchX(); return; }
  netInitPositions();
  netRunLayout(NET.layout === 'force' ? 340 : 300);
  netStretchX();
}

/**
 * 径向同心圆的分环规划：从内向外，每一环按人数算出「需要几层子环」，
 * 再反推节点半径——保证环带能装下这一环的人，且整图不超过画布。
 */
function netRadialPlan(){
  const MAXH = 4;
  const root = NET.pin || NET.selected || netHubId(NET.nodes);
  const hop = netHops(root);
  const hopOf = id => Math.min(hop.get(id) === undefined ? 3 : hop.get(id), MAXH);
  const counts = new Array(MAXH + 1).fill(0);
  NET.nodes.forEach(n => { counts[hopOf(n.id)]++; });
  const rMax = Math.max(140, Math.min(NET.w, NET.h) / 2 - 12);
  const gap = 7;                                   // 节点之间的最小空隙
  // 期望的节点半径：人少就画大（最多 30），塞不下再按比例收
  let base = Math.max(8, Math.min(30, 220 / Math.sqrt(Math.max(1, NET.nodes.length))));
  let ringR = [0], layersArr = [1];
  for(let pass = 0; pass < 4; pass++){
    const rWorst = base * 1.08;                    // 度数高的节点会稍大，规划按最坏情况留量
    const step = rWorst * 2 + gap;
    ringR = [0]; layersArr = [1];
    let edge = 0;
    for(let h = 1; h <= MAXH; h++){
      const need = counts[h];
      let layers = 1;
      // 子环层数封顶：层数太多环带会糊成一片，看不出同心圆
      while(layers < 3){
        let cap = 0;
        for(let k = 0; k < layers; k++){
          const rr = edge + (k + 0.5) * step;
          cap += Math.max(1, Math.floor((2 * Math.PI * rr) / step));
        }
        if(cap >= need) break;
        layers++;
      }
      ringR[h] = edge + layers * step;
      layersArr[h] = layers;
      edge = ringR[h];
    }
    if(ringR[MAXH] <= rMax || base <= 7) break;
    base = Math.max(7, base * (rMax / ringR[MAXH]));
  }
  return { hopOf, ringR, layers: layersArr, base };
}

/**
 * 直接按同心圆摆放：每一环在自己的环带内分层、同层角度均分。
 * 不跑力导向，避免斥力把节点推出圆环（那样 fit 之后头像又被缩得很小）。
 */
function netPlaceRadial(){
  const nodes = NET.nodes;
  if(!nodes.length) return;
  const B = netRadialPlan();
  NET.radialBase = B.base;
  const cx = NET.w / 2, cy = NET.h / 2;
  const byHop = new Map();
  nodes.forEach(n => {
    const h = B.hopOf(n.id);
    if(!byHop.has(h)) byHop.set(h, []);
    byHop.get(h).push(n);
  });
  byHop.forEach((list, h) => {
    // 度数高的排前面，密集环里大小分布更均匀
    list.sort((a, b) => b.deg - a.deg || String(a.id).localeCompare(String(b.id)));
    if(h === 0){
      list.forEach(n => { n.x = cx; n.y = cy; n.vx = 0; n.vy = 0; });
      return;
    }
    const rIn = B.ringR[h - 1], rOut = B.ringR[h];
    const layers = Math.max(1, B.layers[h] || 1);
    const perLayer = Math.ceil(list.length / layers);
    list.forEach((n, i) => {
      const layer = i % layers;
      const slot = Math.floor(i / layers);
      const r = rIn + (layer + 0.5) * ((rOut - rIn) / layers);
      const a = (slot / Math.max(1, perLayer)) * Math.PI * 2 + h * 0.5;
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
      n.vx = 0; n.vy = 0;
    });
  });
}

function netRunLayout(ticks){
  NET.hasD3 = !!(typeof window !== 'undefined' && window.d3 && window.d3.forceSimulation);
  if(NET.hasD3) return netRunD3(ticks);
  NET.alpha = 1;          // 回退到内置简版力导向
  netSimulate(ticks);
}

/** d3-force 布局：力导向 / 分组分簇 / 径向同心圆 */
function netRunD3(ticks){
  const d3 = window.d3;
  const nodes = NET.nodes;
  if(!nodes.length) return;
  if(NET.sim){ try{ NET.sim.stop(); }catch(e){} NET.sim = null; }
  const links = NET.edges.map(e => ({ source:e.a, target:e.b, w:e.w }));
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id)
      .distance(e => 150 - Math.min(e.w, 4) * 16)
      .strength(e => 0.10 + Math.min(e.w, 4) * 0.05))
    .force('charge', d3.forceManyBody().strength(NET.layout === 'force' ? -300 : -180).distanceMax(1000))
    .force('center', d3.forceCenter(NET.w / 2, NET.h / 2).strength(0.06))
    .force('collide', d3.forceCollide().radius(n => netRadius(n) + 5).iterations(2))
    .stop();

  if(NET.layout === 'cluster'){
    const key = NET.clusterBy === 'company' ? 'company_id' : 'group';
    const keys = [...new Set(nodes.map(n => n.p[key]))];
    const R = Math.min(NET.w, NET.h) * 0.33;
    const anchor = new Map();
    keys.forEach((k, i) => {
      const a = (i / Math.max(1, keys.length)) * Math.PI * 2 - Math.PI / 2;
      anchor.set(k, { x: NET.w / 2 + Math.cos(a) * R, y: NET.h / 2 + Math.sin(a) * R });
    });
    const at = d => anchor.get(d.p[key]) || { x: NET.w / 2, y: NET.h / 2 };
    sim.force('x', d3.forceX(d => at(d).x).strength(0.25))
       .force('y', d3.forceY(d => at(d).y).strength(0.25));
  }

  for(let i = 0; i < ticks; i++) sim.tick();
  nodes.forEach(n => {
    if(!isFinite(n.x) || !isFinite(n.y)){
      n.x = NET.w / 2 + (Math.random() - 0.5) * 120;
      n.y = NET.h / 2 + (Math.random() - 0.5) * 120;
    }
  });
  NET.sim = sim;
}

/** 拖动节点后重新升温（d3 或内置回退） */
function netReheat(steps){
  const n = steps || 30;
  if(NET.hasD3 && NET.sim){
    NET.sim.alpha(0.35);
    for(let i = 0; i < n; i++) NET.sim.tick();
  } else {
    NET.alpha = Math.max(NET.alpha, 0.25);
    netSimulate(n);
  }
}

function netSimulate(steps){
  const nodes = NET.nodes;
  if(!nodes.length) return;
  const cx = NET.w / 2, cy = NET.h / 2;
  const minD = nodes.length > 120 ? 22 : 26;   // 节点间最小间距，防止糊成一团
  for(let s = 0; s < steps; s++){
    const a = NET.alpha;
    for(let i = 0; i < nodes.length; i++){
      const A = nodes[i];
      for(let j = i + 1; j < nodes.length; j++){
        const B = nodes[j];
        let dx = A.x - B.x, dy = A.y - B.y;
        let d2 = dx * dx + dy * dy;
        if(d2 < 1){ dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if(d2 > 260000) continue;   // 远距离不再互斥，省算力
        const d = Math.sqrt(d2);
        const f = Math.min(30, 5200 * a / d2);   // 上限防止近距节点被弹飞
        const fx = dx / d * f, fy = dy / d * f;
        A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
        if(d < minD){                       // 硬性分离，避免节点重叠
          const push = Math.min(8, (minD - d) * 0.5 * a);
          const ux = dx / d * push, uy = dy / d * push;
          A.vx += ux; A.vy += uy; B.vx -= ux; B.vy -= uy;
        }
      }
    }
    for(const e of NET.edges){
      const A = NET.byId.get(e.a), B = NET.byId.get(e.b);
      if(!A || !B) continue;
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      // 共同经历越多，弹簧越短（连得越紧）
      const rest = 150 - Math.min(e.w, 4) * 14;
      const f = Math.max(-40, Math.min(40, (d - rest) * 0.013 * a * (1 + Math.min(e.w, 4) * 0.25)));
      const fx = dx / d * f, fy = dy / d * f;
      A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
    }
    for(const A of nodes){
      A.vx += (cx - A.x) * 0.0011 * a;
      A.vy += (cy - A.y) * 0.0011 * a;
      A.vx *= 0.86; A.vy *= 0.86;
      A.vx = Math.max(-25, Math.min(25, A.vx));
      A.vy = Math.max(-25, Math.min(25, A.vy));
      A.x += A.vx; A.y += A.vy;
    }
    NET.alpha *= 0.986;
    if(NET.alpha < 0.006) break;
  }
}

function netImage(p){
  const src = p && p.photo;
  if(!src || /^https?:/i.test(src)) return null;   // 外链头像离线可能失败，直接跳过
  if(NET.imgs.has(src)) return NET.imgs.get(src);
  const img = new Image();
  img.onload = () => { const v = document.getElementById('view-people-network'); if(v && v.classList.contains('active')) netDraw(); };
  img.src = src;
  NET.imgs.set(src, img);
  return img;
}

function netFocusId(){ return NET.selected || NET.hover || null; }
function netIsDim(id){
  const f = netFocusId();
  if(!f || id === f) return false;
  return !NET.adj.get(f) || !NET.adj.get(f).has(id);
}
function netRadius(n){
  // 径向布局由 netRadialPlan() 反推出「画布能容纳的最大半径」，这里跟它保持一致
  if(NET.layout === 'radial' && NET.radialBase){
    return NET.radialBase * (0.92 + 0.16 * (Math.min(n.deg, 12) / 12));
  }
  // 其余布局：半径跟着「画布面积 / 节点数」走，避免 fit 之后头像被缩成几个像素
  const N = Math.max(1, NET.nodes.length);
  const area = Math.max(1, NET.w * NET.h);
  const fit = Math.sqrt((area * 0.34) / (N * Math.PI));
  const k = Math.max(0.55, Math.min(1, fit / 17));
  return (12 + Math.min(n.deg, 12) * 1.3) * k;
}
/** 径向布局默认圆心：取连线最多的人，比取数组第一个更有意义 */
function netHubId(nodes){
  let best = null;
  for(const n of nodes){
    if(!best || n.deg > best.deg || (n.deg === best.deg && String(n.id) < String(best.id))) best = n;
  }
  return best ? best.id : '';
}

function netResize(force){
  const cv = NET.canvas; if(!cv) return;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(360, Math.round(rect.width || 900));
  const h = Math.max(320, Math.round(rect.height || 560));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if(!force && w === NET.w && h === NET.h && dpr === NET.dpr) return;
  NET.w = w; NET.h = h; NET.dpr = dpr;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
}

function netDraw(){
  const ctx = NET.ctx, cv = NET.canvas;
  if(!ctx || !cv) return;
  const f = netFocusId();
  ctx.setTransform(NET.dpr, 0, 0, NET.dpr, 0, 0);
  ctx.fillStyle = '#fbfdff';
  ctx.fillRect(0, 0, NET.w, NET.h);
  ctx.save();
  ctx.translate(NET.ox, NET.oy);
  ctx.scale(NET.scale, NET.scale);

  for(const e of NET.edges){
    const A = NET.byId.get(e.a), B = NET.byId.get(e.b);
    if(!A || !B) continue;
    const dim = f ? (netIsDim(e.a) || netIsDim(e.b)) : false;
    const active = f && !dim && (e.a === f || e.b === f);
    ctx.strokeStyle = active ? 'rgba(37,99,235,.85)'
      : 'rgba(100,116,139,' + (dim ? 0.05 : Math.min(0.34, 0.10 + e.w * 0.06)).toFixed(2) + ')';
    ctx.lineWidth = active ? 1.6 : Math.min(3, 0.6 + e.w * 0.5);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
  }

  for(const n of NET.nodes){
    const r = netRadius(n);
    const dim = f ? netIsDim(n.id) : false;
    ctx.globalAlpha = dim ? 0.22 : 1;
    const img = netImage(n.p);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    if(img && img.complete && img.naturalWidth){
      ctx.save(); ctx.clip();
      ctx.drawImage(img, n.x - r, n.y - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = (n.id === f) ? '#111827' : 'rgba(17,24,39,.4)';
      ctx.lineWidth = (n.id === f) ? 2.2 : 1; ctx.stroke();
    } else {
      ctx.fillStyle = NET_GROUP_COLOR[n.p.group] || '#64748b';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 ' + Math.max(9, r * 0.85) + 'px -apple-system,BlinkMacSystemFont,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((netPersonLabel(n.p) || '?').slice(0, 1).toUpperCase(), n.x, n.y + 0.5);
    }
    if(n.id === NET.pin){          // 搜索定位到的人加一圈橙色标记
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 同心圆布局里高度数的人都在内环，标 14 个名字会叠成一团，只标聚焦节点
  const top = NET.layout === 'radial'
    ? []
    : [...NET.nodes].sort((a, b) => b.deg - a.deg).slice(0, 14).map(n => n.id);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for(const n of NET.nodes){
    if(f && netIsDim(n.id)) continue;
    if(n.id !== f && top.indexOf(n.id) < 0) continue;
    const label = netPersonLabel(n.p);
    if(!label) continue;
    ctx.font = (n.id === f ? '650 ' : '') + '11.5px -apple-system,BlinkMacSystemFont,sans-serif';
    const w = ctx.measureText(label).width;
    const y = n.y + netRadius(n) + 2;
    ctx.fillStyle = 'rgba(251,253,255,.82)';
    ctx.fillRect(n.x - w / 2 - 3, y, w + 6, 14);
    ctx.fillStyle = (n.id === f) ? '#111827' : '#475569';
    ctx.fillText(label, n.x, y + 1);
  }
  ctx.restore();
}

function netRefreshChrome(){
  const stat = document.getElementById('netStat');
  if(stat){
    stat.textContent = NET.nodes.length
      ? NET.nodes.length + (LANG === 'en' ? ' nodes · ' : ' 节点 · ') + NET.edges.length + (LANG === 'en' ? ' links' : ' 连线')
        + (NET.masked > 0 ? (LANG === 'en' ? ' · ' + NET.masked + ' hidden' : ' · ' + NET.masked + ' 人无共同项未显示') : '')
      : '';
  }
  const empty = document.getElementById('netEmpty');
  if(empty){
    if(NET.nodes.length){ empty.style.display = 'none'; }
    else {
      empty.style.display = 'block';
      empty.textContent = LANG === 'en'
        ? 'No shared history under current filters. Try lowering “min shared”, switching mode, or relaxing filters.'
        : '当前筛选下没有可连边的人物。可尝试降低「最少共同项」、切换模式或放宽公司/类别筛选。';
    }
  }
  const legend = document.getElementById('netLegend');
  if(legend){
    legend.innerHTML = Object.keys(NET_GROUP_COLOR).map(g =>
      '<span><i class="dot" style="background:' + NET_GROUP_COLOR[g] + '"></i>' + groupLabel(g) + '</span>').join('')
      + '<span>' + T('连线越粗表示共同经历越多', 'Thicker line = more shared items') + '</span>'
      + '<span>' + T('点击节点查看档案 · 拖动可微调位置 · 滚轮缩放 · 双击空白复位', 'Click a node for profile · drag to adjust · wheel to zoom · double-click to reset') + '</span>';
  }
}

function netBounds(ids){
  // 用 2%~98% 分位数取景：个别被弹远的节点不会把整体缩放到最小
  const xs = [], ys = [];
  for(const n of NET.nodes){
    if(ids && !ids.has(n.id)) continue;
    xs.push(n.x); ys.push(n.y);
  }
  if(!xs.length) return { minX:0, minY:0, maxX:0, maxY:0, ok:false };
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];
  return { minX:q(xs, 0.02), maxX:q(xs, 0.98), minY:q(ys, 0.02), maxY:q(ys, 0.98), ok:true };
}
function netFitView(){
  const b = netBounds(null);
  if(!b.ok) return;
  const pad = 70;
  const sx = NET.w / Math.max(1, (b.maxX - b.minX + pad * 2));
  const sy = NET.h / Math.max(1, (b.maxY - b.minY + pad * 2));
  NET.scale = Math.max(0.2, Math.min(1.5, Math.min(sx, sy)));
  NET.ox = NET.w / 2 - (b.minX + b.maxX) / 2 * NET.scale;
  NET.oy = NET.h / 2 - (b.minY + b.maxY) / 2 * NET.scale;
}
function netFitNeighborhood(pid){
  const ids = new Set([pid]);
  const nb = NET.adj.get(pid);
  if(nb) nb.forEach((w, id) => ids.add(id));
  const b = netBounds(ids);
  if(!b.ok) return;
  const pad = 110;
  const sx = NET.w / Math.max(1, (b.maxX - b.minX + pad));
  const sy = NET.h / Math.max(1, (b.maxY - b.minY + pad));
  NET.scale = Math.max(0.45, Math.min(2.4, Math.min(sx, sy)));
  NET.ox = NET.w / 2 - (b.minX + b.maxX) / 2 * NET.scale;
  NET.oy = NET.h / 2 - (b.minY + b.maxY) / 2 * NET.scale;
}

function netHit(x, y){
  for(let i = NET.nodes.length - 1; i >= 0; i--){
    const n = NET.nodes[i];
    const r = netRadius(n) + 3;
    if((x - n.x) * (x - n.x) + (y - n.y) * (y - n.y) <= r * r) return n;
  }
  return null;
}
function netToWorld(ev){
  const rect = NET.canvas.getBoundingClientRect();
  return { x: (ev.clientX - rect.left - NET.ox) / NET.scale, y: (ev.clientY - rect.top - NET.oy) / NET.scale };
}

/** 两人的共同项 key 列表 */
function netPairKeys(a, b){ return NET.pairKeys.get(a < b ? a + '|' + b : b + '|' + a) || []; }

/** 把共同项拼成一句「原因」，max 控制显示几个 */
function netWhyText(a, b, max){
  const keys = netPairKeys(a, b);
  const n = max || 2;
  const head = NET.mode === 'org'
    ? (LANG === 'en' ? 'shared: ' : '共同：')
    : (LANG === 'en' ? 'school: ' : '共同学校：');
  const shown = keys.slice(0, n).map(k => netLabelOf(k)).join(LANG === 'en' ? ', ' : '、');
  const more = keys.length > n ? (LANG === 'en' ? ' +' + (keys.length - n) : ' 等 ' + keys.length + ' 项') : '';
  return head + shown + more;
}

function netTipShow(n, ev){
  const tip = document.getElementById('netTip');
  if(!tip || !n) return;
  const c = companyById(n.p.company_id);
  const nb = NET.adj.get(n.id) || new Map();
  const shared = [];
  nb.forEach((w, id) => { if(id !== n.id) shared.push({ id, w }); });
  shared.sort((a, b) => b.w - a.w);
  const lines = shared.slice(0, 5).map(s => {
    const q = personById(s.id);
    const qc = q ? companyById(q.company_id) : null;
    const company = qc ? coName(qc) : (q ? q.company_id : '');
    return '· ' + esc(q ? netPersonLabel(q) : s.id)
      + (company ? ' · ' + esc(company) : '')
      + ' — ' + esc(netWhyText(n.id, s.id, 1));
  });
  tip.innerHTML = '<b>' + esc(netPersonLabel(n.p)) + '</b><br>'
    + '<span style="opacity:.85">' + esc(n.p.title || '') + '</span><br>'
    + '<span style="opacity:.85">' + esc(c ? coName(c) : n.p.company_id) + '</span><br>'
    + (LANG === 'en' ? 'Connected to <b>' + nb.size + '</b> people' : '连带 <b>' + nb.size + '</b> 人')
    + (lines.length ? '<br><span style="opacity:.8">' + (LANG === 'en' ? 'Main links:' : '主要关联：') + '</span><br>' + lines.join('<br>') : '');
  const rect = NET.canvas.getBoundingClientRect();
  tip.style.opacity = '1';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = ev.clientX - rect.left + 14;
  let top = ev.clientY - rect.top + 14;
  if(left + tw > rect.width - 6) left = Math.max(6, ev.clientX - rect.left - tw - 14);
  if(top + th > rect.height - 6) top = Math.max(6, ev.clientY - rect.top - th - 14);
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function netTipHide(){ const tip = document.getElementById('netTip'); if(tip) tip.style.opacity = '0'; }

/** 侧栏头像：本地图片优先，否则用分组色首字母块 */
function netAvatarHTML(p, size){
  const label = esc(((p ? netPersonLabel(p) : '?') || '?').slice(0, 1).toUpperCase());
  const src = p && p.photo;
  if(src && !/^https?:/i.test(src)) return '<img src="' + esc(src) + '" alt="" loading="lazy">';
  const color = (p && NET_GROUP_COLOR[p.group]) || '#64748b';
  return '<div class="np-av" style="background:' + color + ';font-size:' + Math.round(size * 0.42) + 'px">' + label + '</div>';
}

/** 右侧关联面板：选中人物的关联人物 + 所属公司 + 关联原因 */
function netPanelRender(){
  const panel = document.getElementById('netPanel');
  if(!panel) return;
  const id = NET.selected;
  if(!id || !NET.byId.has(id)){
    panel.innerHTML = '<h4>' + T('关联人物', 'Connections') + '</h4><div class="np-hint">'
      + T('点击图中任意节点（或在搜索框输入姓名回车），这里会列出该人的关联人物、所属公司与关联原因。',
          'Click a node (or search by name) to list related people, their companies and why they are connected.')
      + '</div>';
    return;
  }
  const node = NET.byId.get(id), p = node.p, c = companyById(p.company_id);
  const rows = [];
  const nb = NET.adj.get(id) || new Map();
  nb.forEach((w, other) => { if(other !== id) rows.push({ id: other, w }); });
  rows.sort((a, b) => b.w - a.w || String(a.id).localeCompare(String(b.id)));

  const head = '<div class="np-head">' + netAvatarHTML(p, 44)
    + '<div><div class="np-name">' + esc(netPersonLabel(p)) + '</div>'
    + '<div class="np-sub">' + esc(p.title || '') + '</div>'
    + '<div class="np-sub">' + esc(c ? coName(c) : p.company_id)
    + (p.status === 'former' ? ' · ' + T('已离任', 'Former') : '') + '</div></div></div>';

  if(!rows.length){
    panel.innerHTML = head + '<h4>' + T('关联人物', 'Connections') + '（0）</h4><div class="np-hint">'
      + T('当前模式下该人物没有共同项，因此没有连线。可切换模式、勾选「含当前公司」，或换用人多的布局再试。',
          'No shared items in this mode, so this person has no links.')
      + '</div>';
    return;
  }

  const whyLabel = NET.mode === 'org'
    ? T('标签为共同任职机构（含高校 / 医院）', 'tags = shared employers (incl. academia)')
    : T('标签为共同学校', 'tags = shared schools');
  const body = rows.slice(0, 80).map(r => {
    const q = personById(r.id);
    const qc = q ? companyById(q.company_id) : null;
    const tags = netPairKeys(id, r.id).slice(0, 4).map(k => '<span>' + esc(netLabelOf(k)) + '</span>').join('');
    return '<div class="np-row" data-pid="' + esc(r.id) + '">' + netAvatarHTML(q, 30)
      + '<div class="np-rt"><div class="np-rn">' + esc(q ? netPersonLabel(q) : r.id) + '</div>'
      + (q && q.title ? '<div class="np-rc">' + esc(q.title) + '</div>' : '')
      + '<div class="np-rc">' + esc(qc ? coName(qc) : (q ? q.company_id : '')) + '</div>'
      + '<div class="np-why">' + tags + '</div></div></div>';
  }).join('');

  panel.innerHTML = head + '<h4>' + T('关联人物', 'Connections') + '（' + rows.length + '）'
    + ' <span style="font-weight:400;font-size:11.5px">' + esc(whyLabel) + '</span></h4>' + body;

  panel.querySelectorAll('.np-row').forEach(el => el.addEventListener('click', () => {
    const pid = el.dataset.pid;
    if(NET.byId.has(pid)){ NET.selected = pid; netFitNeighborhood(pid); netDraw(); netPanelRender(); }
  }));
}

function netFocusPerson(pid){
  const n = NET.byId.get(pid);
  if(!n) return false;
  NET.selected = pid;
  netFitNeighborhood(pid);
  netPanelRender();
  netDraw();
  return true;
}

function netSvgString(){
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(NET.w) + '" height="' + Math.round(NET.h) + '" viewBox="0 0 ' + Math.round(NET.w) + ' ' + Math.round(NET.h) + '">');
  parts.push('<rect width="100%" height="100%" fill="#fbfdff"/>');
  parts.push('<g transform="translate(' + NET.ox.toFixed(1) + ',' + NET.oy.toFixed(1) + ') scale(' + NET.scale.toFixed(3) + ')">');
  for(const e of NET.edges){
    const A = NET.byId.get(e.a), B = NET.byId.get(e.b);
    if(!A || !B) continue;
    parts.push('<line x1="' + A.x.toFixed(1) + '" y1="' + A.y.toFixed(1) + '" x2="' + B.x.toFixed(1) + '" y2="' + B.y.toFixed(1)
      + '" stroke="rgba(100,116,139,' + Math.min(0.34, 0.10 + e.w * 0.06).toFixed(2) + ')" stroke-width="' + Math.min(3, 0.6 + e.w * 0.5).toFixed(2) + '"/>');
  }
  for(const n of NET.nodes){
    const r = netRadius(n).toFixed(1);
    const color = NET_GROUP_COLOR[n.p.group] || '#64748b';
    parts.push('<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r + '" fill="' + color + '" stroke="rgba(17,24,39,.4)"/>');
    parts.push('<text x="' + n.x.toFixed(1) + '" y="' + (n.y + netRadius(n) + 12).toFixed(1) + '" font-size="11" text-anchor="middle" fill="#475569">' + esc(netPersonLabel(n.p)) + '</text>');
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}

function netDownload(name, url, revoke){
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  if(revoke) setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function netAddInteractions(){
  const cv = NET.canvas;
  if(!cv || cv.dataset.bound) return;
  cv.dataset.bound = '1';

  cv.addEventListener('pointerdown', ev => {
    const w = netToWorld(ev);
    const hit = netHit(w.x, w.y);
    if(hit){
      NET.drag = { id: hit.id, moved:false, sx:ev.clientX, sy:ev.clientY };
    } else {
      NET.pan = { sx:ev.clientX, sy:ev.clientY, ox:NET.ox, oy:NET.oy };
      cv.classList.add('dragging');
    }
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
  });

  cv.addEventListener('pointermove', ev => {
    if(NET.drag){
      const n = NET.byId.get(NET.drag.id);
      const w = netToWorld(ev);
      if(n){ n.x = w.x; n.y = w.y; n.vx = 0; n.vy = 0; }
      if(Math.abs(ev.clientX - NET.drag.sx) + Math.abs(ev.clientY - NET.drag.sy) > 4) NET.drag.moved = true;
      netDraw();
      return;
    }
    if(NET.pan){
      NET.ox = NET.pan.ox + (ev.clientX - NET.pan.sx);
      NET.oy = NET.pan.oy + (ev.clientY - NET.pan.sy);
      netDraw();
      return;
    }
    const w = netToWorld(ev);
    const hit = netHit(w.x, w.y);
    const id = hit ? hit.id : null;
    if(id !== NET.hover){ NET.hover = id; netDraw(); }
    if(hit) netTipShow(hit, ev); else netTipHide();
    cv.style.cursor = hit ? 'pointer' : 'grab';
  });

  const endPointer = ev => {
    if(NET.drag){
      const wasClick = !NET.drag.moved;
      const id = NET.drag.id;
      NET.drag = null;
      if(wasClick){
        // 不能在这里直接 openPerson：随后的 click 事件会落在弹窗遮罩上，
        // 触发遮罩的「点击空白关闭」逻辑，弹窗会一闪而过。改为在 click 里打开。
        NET.selected = id;
        NET.pendingOpen = id;
        netDraw(); netPanelRender();
      }
      else { netReheat(40); netDraw(); }
    }
    if(NET.pan){ NET.pan = null; cv.classList.remove('dragging'); }
    try{ cv.releasePointerCapture(ev.pointerId); }catch(e){}
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('click', () => {
    if(NET.pendingOpen){ const id = NET.pendingOpen; NET.pendingOpen = null; openPerson(id); }
  });
  cv.addEventListener('pointerleave', () => {
    if(!NET.drag && !NET.pan){ NET.hover = null; netTipHide(); netDraw(); }
  });

  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const k = ev.deltaY < 0 ? 1.12 : 0.89;
    const ns = Math.max(0.2, Math.min(3.5, NET.scale * k));
    NET.ox = mx - (mx - NET.ox) * (ns / NET.scale);
    NET.oy = my - (my - NET.oy) * (ns / NET.scale);
    NET.scale = ns;
    netDraw();
  }, { passive:false });

  cv.addEventListener('dblclick', () => { NET.selected = null; netFitView(); netDraw(); });
}

function netFillSelects(){
  const sel = document.getElementById('netCompany');
  if(sel && sel.dataset.filled !== '1'){
    sel.dataset.filled = '1';
    sel.innerHTML = '<option value="">' + T('全部公司', 'All companies') + '</option>'
      + DATA.companies.map(c => '<option value="' + c.id + '">' + esc(coName(c)) + '</option>').join('');
  }
}

/** 进入该视图时调用：初始化画布、绑定事件、构建并绘制 */
function netOnShow(){
  const cv = document.getElementById('netCanvas');
  if(!cv) return;
  NET.canvas = cv;
  NET.ctx = cv.getContext('2d');
  window.__net = NET;   // 调试钩子：控制台可直接读取布局状态
  netFillSelects();
  netResize(true);
  netAddInteractions();
  netRebuild();
  netFitView();
  netDraw();
}

function initPeopleNetwork(){
  const on = (sel, ev, fn) => { const el = document.querySelector(sel); if(el) el.addEventListener(ev, fn); };
  const redraw = () => { NET.selected = null; netRebuild(); netFitView(); netDraw(); };
  const relayout = () => { netLayout(); netRefreshChrome(); netPanelRender(); netFitView(); netDraw(); };

  document.querySelectorAll('#netMode button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#netMode button').forEach(x => x.classList.toggle('on', x === b));
    NET.mode = b.dataset.mode;
    const topWrap = document.getElementById('netTopWrap');
    if(topWrap) topWrap.style.display = (NET.mode === 'school') ? '' : 'none';
    redraw();
  }));
  on('#netCompany', 'change', e => { NET.company = e.target.value; redraw(); });
  on('#netGroup', 'change', e => { NET.group = e.target.value; redraw(); });
  on('#netIncludeCurrent', 'change', e => { NET.includeCurrent = e.target.checked; redraw(); });
  on('#netTopOnly', 'change', e => { NET.topOnly = e.target.checked; redraw(); });
  on('#netLayout', 'change', e => {
    NET.layout = e.target.value;
    const wrap = document.getElementById('netClusterWrap');
    if(wrap) wrap.style.display = (NET.layout === 'cluster') ? '' : 'none';
    relayout();
  });
  on('#netClusterBy', 'change', e => { NET.clusterBy = e.target.value; relayout(); });
  on('#netMinWeight', 'change', e => {
    NET.minWeight = Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1));
    e.target.value = NET.minWeight;
    redraw();
  });
  on('#netSearch', 'keydown', e => {
    if(e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if(!q) return;
    const norm = s => String(s || '').toLowerCase();
    const people = DATA.people;
    const hit = people.find(p => norm(p.name) === q || norm(p.name_zh) === q)
      || people.find(p => norm(p.name).indexOf(q) === 0 || norm(p.name_zh).indexOf(q) === 0)
      || people.find(p => [p.name, p.name_zh].filter(Boolean).some(x => norm(x).indexOf(q) >= 0));
    if(!hit){
      const st = document.getElementById('netStat');
      if(st) st.textContent = T('未找到匹配人物：' + e.target.value, 'No match: ' + e.target.value);
      return;
    }
    // 始终在图内聚焦：不跳转到人物库
    NET.pin = hit.id;
    if(!NET.byId.has(hit.id)){
      // 该人不在当前图里（被筛选掉或没有共同项）→ 放宽筛选后重建，必要时作为孤立节点保留
      NET.company = ''; NET.group = ''; NET.minWeight = 1;
      const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
      set('netCompany', ''); set('netGroup', ''); set('netMinWeight', 1);
      netRebuild();
    }
    netFocusPerson(hit.id);
    netDraw();
  });
  on('#netReset', 'click', () => {
    NET.company = ''; NET.group = ''; NET.minWeight = 1;
    NET.includeCurrent = false; NET.topOnly = false; NET.selected = null; NET.hover = null; NET.pin = null;
    const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if(el) el.checked = v; };
    set('netCompany', ''); set('netGroup', ''); set('netMinWeight', 1); set('netSearch', '');
    chk('netIncludeCurrent', false); chk('netTopOnly', false);
    redraw();
  });
  on('#netPng', 'click', () => {
    netDraw();
    netDownload((NET.mode === 'org' ? 'people-network-org' : 'people-network-school') + '.png', NET.canvas.toDataURL('image/png'));
  });
  on('#netSvg', 'click', () => {
    const blob = new Blob([netSvgString()], { type: 'image/svg+xml' });
    netDownload('people-network.svg', URL.createObjectURL(blob), true);
  });
  window.addEventListener('resize', debounce(() => {
    const v = document.getElementById('view-people-network');
    if(!v || !v.classList.contains('active')) return;
    netResize(true); netDraw();
  }, 200));
}

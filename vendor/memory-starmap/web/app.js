/* 记忆星图 · 渲染层
 * 只读 starmap.json，3D 投影 + 拖拽旋转 + 滚轮缩放 + 图例筛选 + 搜索 + 详情卡
 * 呼吸动效（2026-10-28）：节点按各自相位缓慢漂移；连线分两拨，34% 骨架线常亮微呼吸，
 * 其余按 7.5~14.5 秒一轮从一头长出、再淡回薄底；面板「呼吸动效」或按 B 可整体关掉。
 */
(function () {
  'use strict';

  var KIND = {
    fact:       { name: '事实',   color: '#7fc8ff' },
    lesson:     { name: '教训',   color: '#ffb86b' },
    preference: { name: '偏好',   color: '#ff8fc7' },
    msg:        { name: '原话',   color: '#5d7099' },
    doc:        { name: '知识库', color: '#9fe6c8' }
  };
  var DAY_COLOR = '#ffd479';

  /* ---------- 仿生脑区 ----------
   * 每种记忆落到一个脑区，节点在展示时被轻轻拉向自己的脑区锚点：
   * 位置只是排布，不改数据；锚点在单位球面上，按数据半径缩放。
   */
  var REGION = {
    fact:       { cn: '大脑中枢 · 检索', en: 'RETRIEVAL CORTEX', color: '#7fc8ff', a: [ 0.02, -0.86,  0.10] },
    msg:        { cn: '语言中区 · 表达', en: 'LANGUAGE AREA',    color: '#7f93bd', a: [-0.92, -0.12,  0.22] },
    doc:        { cn: '神经图谱 · 外源', en: 'NEURAL ATLAS',     color: '#9fe6c8', a: [ 0.84, -0.34, -0.34] },
    lesson:     { cn: '突触矫正 · 教训', en: 'SYNAPTIC FIX',     color: '#ffb86b', a: [ 0.72,  0.56,  0.30] },
    preference: { cn: '边缘系统 · 偏好', en: 'LIMBIC SYSTEM',    color: '#ff8fc7', a: [-0.62,  0.52, -0.50] },
    day:        { cn: '海马体 · 写入',   en: 'HIPPOCAMPUS',      color: '#ffd479', a: [ 0.00,  0.24,  0.92] }
  };
  var REG = {};          // 脑区：世界坐标圆心 c、半径 r、投影用缓存
  var halo = {};         // 每个脑区预渲染的柔光
  var REG_EXT = 1;       // 数据在 XZ 平面的最大半径（皮层导航用）

  var cv = document.getElementById('stage');
  var ctx = cv.getContext('2d', { alpha: true });  /* 2026-11-07 改透明画布，让底层素材透上来 */
  var elLegend = document.getElementById('legend');
  var elSub = document.getElementById('sub');
  var elFoot = document.getElementById('foot');
  var elQ = document.getElementById('q');
  var elBoot = document.getElementById('boot');
  var elErr = document.getElementById('berr');
  var elCard = document.getElementById('card');
  var elTag = document.getElementById('ctag');
  var elDay = document.getElementById('cday');
  var elTxt = document.getElementById('ctxt');
  var elEv = document.getElementById('cev');
  document.getElementById('cx').addEventListener('click', hideCard);

  /* ---------- 状态 ---------- */
  var DATA = null;
  var N = 0;
  var px, py, pz, pscale;        // 投影缓存
  var sprite = {};               // 预渲染光点
  var W = 0, H = 0, DPR = 1;
  var zoom = 1, targetZoom = 1;   // 镜头朝向改用 rot 矩阵（见投影段）
  var spin = true, dragging = false, lastX = 0, lastY = 0, moved = 0;
  // 自转 + 拖拽手感（2026-11-01）：按下立刻停转并跟随手/鼠标；松手带一点惯性滑行，
  // 滑行衰减完再由 spinFactor 缓慢爬回常速自转，别一松手就猛地开始转。
  var spinFactor = 1, yawVel = 0, pitchVel = 0, lastMoveAt = 0;
  var offX = 0, offY = 0, targetOffX = 0, targetOffY = 0;
  var hidden = {};               // 被关掉的层
  var matchSet = null;           // 搜索命中集
  var hoverIdx = -1;
  var cardIdx = -1;
  var t0 = 0;

  /* ---------- 视觉层：雾体 / 环形轨道 / 聚焦压暗（2026-11-01） ----------
   * 三件改动都只动渲染，不碰数据与投影：
   *   1) 中心雾核 + 脑区厚雾，把「一堆光点」变成有体积的星云；
   *   2) 两圈 3D 椭圆轨道，随视角自转，环上零散光点；
   *   3) 点开一条记忆时其余压暗，只留焦点与一圈粉紫光圈。
   * 窄屏（MOBILE）下所有尺寸按 min(W,H) 归一，另加命中半径放大与帧率降档。
   */
  var MOBILE = false;        // resize 里按窗口宽判定
  var fogMain = null;        // 中心雾核 sprite
  var fogSoft = {};          // 脑区厚雾 sprite（比 halo 更有体积）
  var focusGlow = null;      // 聚焦时的粉紫光圈
  var orbits = [];           // 环形轨道参数
  var focusOn = 0;           // 0 无 / 1 悬停轻压 / 2 卡片全压
  var focusMix = 0;          // 压暗强度（缓动，切换不再硬跳）
  var nearBit = null;        // 与焦点直接相连的节点
  var nearList = [];         // 同上，按序号存一份
  var lastFocus = -2;        // 上一帧的焦点，变了才重建邻接
  var quality = 1;           // 恒定最高画质（2026-11-02 设计决定：星图不做降级）
  var frameMs = 16, slowN = 0, fastN = 0, lastT = 0;
  var fogCool = null;        // 第二层冷雾
  var coreGlow = null;       // 中心亮芯
  var bgCv = null;           // 烘焙好的背景（径向渐变 + 暗角）

  /* ---------- 呼吸动效 ---------- */
  var breath = true;             // 总开关
  var T = 0;                     // 页面存活秒数
  var frame = 0;                 // 帧计数（漂移分批刷新用）
  var ox, oy, oz;                // 每点漂移偏移（世界坐标）
  var driftA, dPh1, dPh2, dPh3;  // 每点振幅与相位
  var lPh, lDur, lStable;        // 每线生长相位、周期、是否骨架线

  /* ---------- 取数 ----------
   * 面板用 sandbox="allow-scripts allow-forms allow-downloads" 的 iframe 装插件页，
   * 没有 allow-same-origin → 页面源是不透明的 "null"，里面任何 fetch 都算跨域，
   * 而网关/后端不回 ACAO，于是四个候选全被 CORS 拦掉（Safari 报 Load failed）。
   * 脚本标签不受 CORS 限制、还会照常带 cookie，所以主路径改成先拉 starmap.js
   * （里面就一句 window.__STARMAP_DATA__ = {...}），fetch 只留作退路。
   */
  var DATA_SCRIPT = 'starmap.js';
  var CANDIDATES = [
    'starmap.json',
    '/api/v1/plugins/astrbot_plugin_memory_starmap/views/starmap/starmap.json'
  ];

  function start(d) {
    if (!d || !d.nodes || !d.nodes.length) return false;
    boot(d);
    return true;
  }

  function loadDataByScript(done) {
    if (start(window.__STARMAP_DATA__)) return;
    var s = document.createElement('script');
    s.src = DATA_SCRIPT + '?v=' + Date.now();
    s.async = true;
    s.onload = function () {
      if (!start(window.__STARMAP_DATA__)) done();
    };
    s.onerror = function () { done(); };
    (document.head || document.documentElement).appendChild(s);
  }

  function loadData(i) {
    i = i || 0;
    if (i >= CANDIDATES.length) { fail('数据没读到：' + CANDIDATES.join(' / ')); return; }
    fetch(CANDIDATES[i], { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!start(d)) throw new Error('空数据');
      })
      .catch(function () {
        if (i + 1 < CANDIDATES.length) loadData(i + 1);
        else fail('数据没读到：' + (window.__STARMAP_ERR__ || 'starmap.js 与 starmap.json 都没拿到'));
      });
  }

  function fail(msg) {
    elErr.textContent = msg;
    elSub.textContent = '没醒过来';
  }

  /* ── 记忆褪色面板（2026-11-04） ──────────────────────────────
     数据走 <script> 而不是 fetch：页面在沙箱 iframe 里，fetch 会被 CORS 拦。
     取不到就把卡收起来，绝不挡星图本身的启动。 */
  // 插件自注册的 web api 走 /api/plug/<插件名>/<路由>，且要带面板 JWT（iframe 里没有，得从父页面拿）。
  var FADE_JS = '/api/plug/astrbot_plugin_memory_starmap/erosion_js';
  var FADE_STATIC = 'erosion.js';

  function renderFade(d) {
    var card = document.getElementById('fadeCard');
    if (!card) return;
    var head = document.getElementById('fadeHead');
    var tag = document.getElementById('fadeTag');
    var bars = document.getElementById('fadeBars');
    var foot = document.getElementById('fadeFoot');
    var list = document.getElementById('fadeList');
    if (!d || !d.ok || !d.stats) { card.style.display = 'none'; return; }

    var st = d.stats, lv = st.levels || [0, 0, 0];
    var total = st.total || 0;
    var hurt = (lv[1] || 0) + (lv[2] || 0);
    tag.textContent = hurt ? (hurt + ' 条褪色') : '全部在位';
    tag.style.color = hurt ? '#f0ca7a' : '#6fe0bd';

    bars.innerHTML = '';
    ['l0', 'l1', 'l2'].forEach(function (cls, i) {
      var n = lv[i] || 0;
      if (!n || !total) return;
      var s = document.createElement('span');
      s.className = cls;
      s.style.width = (n / total * 100) + '%';
      s.title = ['完整 ', '半擦 ', '重擦 '][i] + n + ' 条';
      bars.appendChild(s);
    });

    foot.innerHTML = '<span>半衰 <b>' + (st.half_life || '—') + '</b> 天</span>'
      + '<span>底线 <b>' + (st.floor || '—') + '</b></span>'
      + '<span>在位 <b>' + (lv[0] || 0) + '</b>／共 <b>' + total + '</b></span>';

    list.innerHTML = '';
    var items = d.items || [];
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'fade-empty';
      e.textContent = '没有条目掉到线下，原话都还完整。';
      list.appendChild(e);
    } else {
      items.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'fade-item';
        var kind = { fact: '事实', lesson: '经验', preference: '偏好' }[it.kind] || it.kind || '';
        row.innerHTML = '<div class="fh"><em class="lv' + it.level + '">'
          + (it.level === 2 ? '重擦' : '半擦') + '</em><span>' + kind + '</span>'
          + '<span>' + it.day + '</span><span>闲置 ' + it.idle + ' 天</span>'
          + '<span>权 ' + (it.w || 0).toFixed(2) + '</span></div>'
          + '<div class="fb"></div><div class="fa"></div>';
        row.querySelector('.fb').textContent = it.before;
        row.querySelector('.fa').textContent = it.after;
        list.appendChild(row);
      });
    }

    // 折叠自己管：默认收起（星图是主角），点标题或按回车展开。
    if (!card.__wired) {
      card.__wired = true;
      var toggle = function () {
        var open = card.classList.toggle('collapsed') === false;
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
      card.classList.add('collapsed');
      head.setAttribute('aria-expanded', 'false');
    }
  }

  // 优先静态 js：iframe 里拿不到面板 JWT，走 /api/plug 必 401；
  // 静态那份由插件启动时写盘，取不到再退回带 token 的动态口。
  function loadFade() {
    window.__FADE_DATA__ = null;
    var tried = false;
    function hideCard() {
      var card = document.getElementById('fadeCard');
      if (card) card.style.display = 'none';
    }
    function inject(src, onload, onerror) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = onload; s.onerror = onerror;
      (document.head || document.documentElement).appendChild(s);
    }
    function tryDynamic() {
      var tk = '';
      try {
        tk = window.parent.localStorage.getItem('token')
          || window.parent.localStorage.getItem('astrbot_token')
          || window.localStorage.getItem('token') || '';
      } catch (e) { tk = ''; }
      if (!tk || tried) { hideCard(); return; }
      tried = true;
      inject(FADE_JS + '?v=' + Date.now() + '&token=' + encodeURIComponent(tk),
        function () {
          if (window.__FADE_DATA__ && window.__FADE_DATA__.ok !== false) renderFade(window.__FADE_DATA__);
          else hideCard();
        }, hideCard);
    }
    inject(FADE_STATIC + '?v=' + Date.now(), function () {
      if (window.__FADE_DATA__) renderFade(window.__FADE_DATA__);
      else tryDynamic();
    }, tryDynamic);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(loadFade, 900); });
  } else {
    setTimeout(loadFade, 900);
  }

  /* ---------- 预渲染光点 ---------- */
  function makeSprite(color, lum) {
    var s = 64, c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var L = (lum == null) ? 1 : lum;
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    // 2026-11-01：从「一点亮芯 + 一圈急衰减」改成「整颗实心圆 + 柔边」
    // 原来 0.22 处就掉到本色、0.48 只剩 0.22，画出来是硬针尖；
    // 现在中段还留 0.6 以上的实体，边缘用 0.28→0 慢慢化开，才是一颗圆光斑。
    // lum 是整颗的亮度系数：参考片里的点是「发光的珠子」，不是曝光过头的白斑。
    grd.addColorStop(0, 'rgba(255,255,255,' + (0.92 * L).toFixed(3) + ')');
    grd.addColorStop(0.18, hexA(color, 0.86 * L));
    grd.addColorStop(0.44, hexA(color, 0.62 * L));
    grd.addColorStop(0.72, hexA(color, 0.24 * L));
    grd.addColorStop(0.90, hexA(color, 0.07 * L));
    grd.addColorStop(1, hexA(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ---------- 启动 ---------- */
  /* 连线剪枝（2026-11-01）：全量 4331 条线在中心区一定糊成一束扫帚。
   * 只留「关键线」——按权重降序贪心，每个节点最多挂 LINK_CAP 条，
   * 权重相同时优先短距离，线就贴着本地结构走，不再满天乱射。 */
  var LINK_CAP = 1;
  function pruneLinks(d) {
    var lk = d.links || [], nd = d.nodes || [];
    if (!lk.length) return;
    var order = [], i;
    for (i = 0; i < lk.length; i++) order.push(i);
    var CACHE = window._ld2 || {};
    function d2(j) {
      if (CACHE[j] !== undefined) return CACHE[j];
      var a = nd[lk[j][0]], b = nd[lk[j][1]];
      var v = 1e12;
      if (a && b && a.p && b.p) {
        var dx = a.p[0] - b.p[0], dy = a.p[1] - b.p[1], dz = a.p[2] - b.p[2];
        v = dx * dx + dy * dy + dz * dz;
      }
      CACHE[j] = v;
      return v;
    }
    order.sort(function (x, y) {
      var wx = lk[x][2] || 0, wy = lk[y][2] || 0;
      if (wx !== wy) return wy - wx;
      return d2(x) - d2(y);
    });
    var deg = new Uint8Array(nd.length), keep = [];
    for (i = 0; i < order.length; i++) {
      var j = order[i], a = lk[j][0], b = lk[j][1];
      if (deg[a] >= LINK_CAP || deg[b] >= LINK_CAP) continue;
      deg[a]++; deg[b]++;
      keep.push(lk[j]);
    }
    d.linksTotal = lk.length;
    d.links = keep;
  }

  function boot(d) {
    DATA = d;
    pruneLinks(d);
    N = d.nodes.length;
    px = new Float32Array(N); py = new Float32Array(N); pz = new Float32Array(N);
    pscale = new Float32Array(N);

    // 亮度系数 0.58：参考片里的点是暗底上的一颗亮珠，不是过曝的白团
    Object.keys(KIND).forEach(function (k) { sprite[k] = makeSprite(KIND[k].color, 0.58); });
    sprite.day = makeSprite(DAY_COLOR, 0.78);

    initRegions();
    initBreath();
    buildLegend();
    buildMix();
    fillFoot();
    buildPersona();
    buildStream();
    buildRetrieval();
    buildActivity();
    startClock();
    resize();
    drawMinimap();
    SORTED = [];
    for (var z0 = 0; z0 < N; z0++) SORTED.push(z0);
    elSub.textContent = '记忆已点亮';
    elBoot.classList.add('off');
    setTimeout(function () { elBoot.style.display = 'none'; }, 600);
    t0 = performance.now();
    requestAnimationFrame(loop);
  }

  function counts() {
    var c = {};
    DATA.nodes.forEach(function (n) { c[n.t] = (c[n.t] || 0) + 1; });
    return c;
  }

  function buildLegend() {
    var c = counts();
    elLegend.innerHTML = '';
    Object.keys(KIND).forEach(function (k) {
      if (!c[k]) return;
      var row = document.createElement('div');
      row.className = 'lg';
      row.dataset.k = k;
      row.innerHTML = '<i class="dot" style="color:' + KIND[k].color + '"></i>' +
        '<span class="nm">' + KIND[k].name + '</span>' +
        '<span class="ct">' + c[k] + '</span>';
      row.addEventListener('click', function () {
        hidden[k] = !hidden[k];
        row.classList.toggle('off', !!hidden[k]);
        syncMix();
      });
      elLegend.appendChild(row);
    });
  }

  function syncMix() {
    var bar = document.getElementById('mixbar');
    if (!bar) return;
    Array.prototype.forEach.call(bar.children, function (seg) {
      seg.classList.toggle('off', !!hidden[seg.dataset.k]);
    });
  }

  function fillFoot() {
    var g = (DATA.generated_at || '').replace('T', ' ').slice(0, 16);
    var days = DATA.days ? DATA.days.length : 0;
    elFoot.innerHTML =
      '构建于 <b>' + (g || '—') + '</b> · 耗时 <b>' + (DATA.build_seconds || '—') + 's</b>' +
      ' · 指纹 <b>' + (DATA.fingerprint || '—') + '</b>';
    elSub.innerHTML = '仿生脑区图谱 · 数据全部来自 dream / cold / daybook / 知识库真实记忆';
    var elCounts = document.getElementById('counts');
    if (elCounts) {
      var fmt = function (v) { return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
      elCounts.innerHTML =
        '<div class="c"><b>' + fmt(N) + '</b><span>记忆点</span></div>' +
        '<div class="c"><b>' + fmt(DATA.links.length) + '</b><span>关键线</span></div>' +
        '<div class="c"><b>' + Object.keys(REGION).length + '</b><span>脑区</span></div>' +
        '<div class="c"><b>' + days + '</b><span>天跨度</span></div>';
    }
    var elTotal = document.getElementById('mixTotal');
    if (elTotal) elTotal.textContent = N + ' 条';
    var elSpan = document.getElementById('actspan');
    if (elSpan && DATA.days && DATA.days.length) {
      elSpan.textContent = DATA.days[0].day.slice(5) + ' → ' + DATA.days[DATA.days.length - 1].day.slice(5);
    }
  }

  /* ---------- 呼吸动效 ---------- */
  function hashN(v) {
    v = (v ^ 61) ^ (v >>> 16);
    v = (v + (v << 3)) | 0;
    v = v ^ (v >>> 4);
    v = Math.imul(v, 0x27d4eb2d);
    v = v ^ (v >>> 15);
    return v >>> 0;
  }

  function initBreath() {
    var i, h;
    ox = new Float32Array(N); oy = new Float32Array(N); oz = new Float32Array(N);
    driftA = new Float32Array(N);
    dPh1 = new Float32Array(N); dPh2 = new Float32Array(N); dPh3 = new Float32Array(N);
    for (i = 0; i < N; i++) {
      h = hashN(i * 2654435 + 17);
      driftA[i] = 1.0 + (h % 1000) / 1000 * 1.6;        // 振幅 1.0 ~ 2.6 世界单位
      dPh1[i] = (h % 6283) / 1000;                      // 相位 0 ~ 2π
      dPh2[i] = ((h >>> 10) % 6283) / 1000;
      dPh3[i] = ((h >>> 20) % 6283) / 1000;
      driftStep(i);
    }
    var L = (DATA.links && DATA.links.length) || 0;
    lPh = new Float32Array(L); lDur = new Float32Array(L); lStable = new Uint8Array(L);
    for (i = 0; i < L; i++) {
      h = hashN(i * 40503 + 91);
      lPh[i] = (h % 1000) / 1000;
      lDur[i] = 7.5 + (h % 700) / 100;                  // 每线 7.5 ~ 14.5 秒一轮
      lStable[i] = ((h >>> 8) % 100) < 34 ? 1 : 0;      // 34% 当骨架线，常亮微呼吸
    }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setBreath(false);
    }
  }

  function driftStep(i) {
    var a = driftA[i];
    ox[i] = Math.sin(T * 0.52 + dPh1[i]) * a;
    oy[i] = Math.cos(T * 0.41 + dPh2[i]) * a * 0.9;
    oz[i] = Math.sin(T * 0.33 + dPh3[i]) * a * 0.8;
  }

  function setBreath(on) {
    breath = !!on;
    if (ox) { ox.fill(0); oy.fill(0); oz.fill(0); }
    var row = document.getElementById('breathRow');
    var st = document.getElementById('breathState');
    if (row) row.classList.toggle('off', !breath);
    if (st) st.textContent = breath ? '开' : '关';
  }

  /* ---------- 尺寸 ---------- */
  /* 清晰度（2026-11-02 反馈：不同分辨率下都不糊）：
     老写法一律封顶 DPR 2，手机那块 3 倍屏就被拉大 1.5 倍，糊在放大这一步。
     现在按真实 DPR 走，只留一个总像素闸门（8MP ≈ 32MB 画布），
     手机 402×874@3 是 3.16MP、桌面 1920×909@2 是 6.98MP，两边都是原生像素。 */
  var PIXEL_CAP = 8e6;
  function pickDPR() {
    var real = window.devicePixelRatio || 1;
    var area = Math.max(1, window.innerWidth * window.innerHeight);
    var fit = Math.sqrt(PIXEL_CAP / area);
    /* 2 倍及以下完全不动（桌面保持原来的原生渲染），只有超过 2 的高分屏才受闸门约束 */
    var d = real <= 2 ? real : Math.min(real, fit);
    if (d > 2) d = Math.floor(d * 20) / 20;   // 高分屏取 0.05 步进，别留半像素
    return Math.max(1, d);
  }

  function resize() {
    DPR = pickDPR();
    W = window.innerWidth; H = window.innerHeight;
    var wasMobile = MOBILE;
    MOBILE = W <= 900 || Math.min(W, H) < 560;
    if (wasMobile !== MOBILE && DATA && REG && Object.keys(REG).length) initViz();
    cv.width = Math.floor(W * DPR);
    cv.height = Math.floor(H * DPR);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildBackdrop();
    if (typeof drawMinimap === 'function') drawMinimap();
  }

  /* 背景：径向渐变 + 暗角，一次烘焙，每帧只贴图（比纯色底有空间感） */
  function buildBackdrop() {
    if (!W || !H) return;
    bgCv = document.createElement('canvas');
    bgCv.width = Math.max(2, Math.floor(W));
    bgCv.height = Math.max(2, Math.floor(H));
    var g = bgCv.getContext('2d');
    // 2026-11-07 底色改半透明，让最底层的素材视频透上来（星点仍在上面）
    g.fillStyle = 'rgba(4,6,13,0.20)';
    g.fillRect(0, 0, W, H);
    var cx = W / 2, cy = H * 0.47;
    var R = Math.max(W, H) * 0.78;
    var grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grd.addColorStop(0, 'rgba(34,24,70,0.30)');
    grd.addColorStop(0.34, 'rgba(16,18,46,0.22)');
    grd.addColorStop(0.70, 'rgba(7,10,22,0.13)');
    grd.addColorStop(1, 'rgba(3,4,10,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    var vg = g.createRadialGradient(cx, cy, Math.min(W, H) * 0.38, cx, cy, Math.max(W, H) * 0.80);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.72, 'rgba(0,0,0,0.26)');
    vg.addColorStop(1, 'rgba(0,0,0,0.66)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }

  /* 远景星尘：固定位置 + 各自闪烁相位，手机减半 */
  function drawDust() {
    var n = Math.floor((MOBILE ? 54 : 120) * (quality ? 1 : 0.5));
    for (var s = 0; s < n; s++) {
      var h = hashN(s * 2654435 + 7);
      var ax = (h % 10000) / 10000 * W;
      var ay = ((h >>> 14) % 10000) / 10000 * H;
      var ph = ((h >>> 26) % 100) / 100;
      var tw = 0.5 + 0.5 * Math.sin(T * (0.55 + ph) + ph * 6.28);
      var sz = 0.8 + ph * 1.5;
      ctx.globalAlpha = (0.12 + 0.52 * tw * ph) * (1 - 0.5 * focusMix);
      ctx.fillStyle = (s % 7 === 0) ? '#cfd8ff' : '#8fb4ff';
      ctx.fillRect(ax, ay, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  /* 焦点邻接：卡片/悬停变了才重算，别每帧扫 4331 条边 */
  function buildFocusNear(idx) {
    if (!nearBit || nearBit.length !== N) nearBit = new Uint8Array(N);
    else { for (var z = 0; z < N; z++) nearBit[z] = 0; }
    nearList = [];
    if (idx < 0 || !DATA) return;
    var links = DATA.links;
    for (var i = 0; i < links.length; i++) {
      var a = links[i][0], b = links[i][1];
      if (a === idx && !nearBit[b]) { nearBit[b] = 1; nearList.push(b); }
      else if (b === idx && !nearBit[a]) { nearBit[a] = 1; nearList.push(a); }
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 220); });
  // 手机地址栏收起/展开时只有 visualViewport 会变，光靠 resize 会漏一段
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
  }

  /* ---------- 交互：单指旋转 / 双指缩放+平移 / 滚轮缩放 / 双击归位 ---------- */
  var ptrs = {};                 // pointerId -> {x,y}，双指要一起看
  var pinchD = 0, pinchMX = 0, pinchMY = 0;
  var spinHold = 0;              // 缩放/平移期间暂停自转，免得一边放大一边转、看着像抽搐

  function ptrList() {
    var a = [];
    for (var k in ptrs) { if (Object.prototype.hasOwnProperty.call(ptrs, k)) a.push(ptrs[k]); }
    return a;
  }
  function clampOff(v, span) {
    var lim = span * 0.6;
    return Math.max(-lim, Math.min(lim, v));
  }

  var elHome = document.getElementById('homeBtn');
  function syncHome() {
    if (!elHome) return;
    var off = Math.abs(targetOffX) > 12 || Math.abs(targetOffY) > 12 ||
              Math.abs(targetZoom - 1) > 0.06;
    elHome.classList.toggle('on', off);
  }
  function resetView() {
    targetZoom = 1; targetOffX = 0; targetOffY = 0;
    rotReset(-0.35, 0.22);
    yawVel = 0; pitchVel = 0; spinFactor = 1;
    syncHome();
  }
  if (elHome) {
    elHome.addEventListener('click', function (e) { e.stopPropagation(); resetView(); });
  }

  cv.addEventListener('pointerdown', function (e) {
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = ptrList().length;
    if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (x) {} }
    if (n === 1) {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
      yawVel = 0; pitchVel = 0; lastMoveAt = performance.now();
      cv.classList.add('dragging');
    } else if (n === 2) {
      // 双指：不旋转、不算点击，交给缩放+平移
      dragging = false; moved = 99;
      var a = ptrList();
      pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      pinchMX = (a[0].x + a[1].x) / 2; pinchMY = (a[0].y + a[1].y) / 2;
    }
  });

  window.addEventListener('pointermove', function (e) {
    if (ptrs[e.pointerId]) { ptrs[e.pointerId].x = e.clientX; ptrs[e.pointerId].y = e.clientY; }
    if (ptrList().length >= 2) {
      var a = ptrList();
      var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      var mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
      if (pinchD > 0) targetZoom = Math.max(0.35, Math.min(4.5, targetZoom * (d / pinchD)));
      targetOffX = clampOff(targetOffX + (mx - pinchMX), W);
      targetOffY = clampOff(targetOffY + (my - pinchMY), H);
      pinchD = d; pinchMX = mx; pinchMY = my;
      spinHold = performance.now() + 1200;
      syncHome();
      return;
    }
    if (!dragging) { hover(e.clientX, e.clientY); return; }
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    // 按住 Shift 或右键拖 = 平移画面，把跑偏的星云拖回中间
    if (e.shiftKey || e.buttons === 2) {
      targetOffX = clampOff(targetOffX + dx, W);
      targetOffY = clampOff(targetOffY + dy, H);
      spinHold = performance.now() + 900;
      syncHome();
      return;
    }
    var dYaw = dx * 0.0055, dPitch = dy * 0.0042;
    rotSpin(dYaw);
    rotTilt(dPitch);
    // 记下这一下的角速度（按帧归一），松手后当惯性用
    var nowMs = performance.now(), dt = Math.max(8, nowMs - (lastMoveAt || nowMs - 16));
    lastMoveAt = nowMs;
    yawVel = yawVel * 0.55 + (dYaw / dt * 16.67) * 0.45;
    pitchVel = pitchVel * 0.55 + (dPitch / dt * 16.67) * 0.45;
  });

  function endPtr(e) {
    if (ptrs[e.pointerId]) delete ptrs[e.pointerId];
    var n = ptrList().length;
    if (n === 1) {
      // 双指松掉一根：接回单指旋转，别跳一下
      var a = ptrList();
      lastX = a[0].x; lastY = a[0].y;
      dragging = true; moved = 99; pinchD = 0;
      return;
    }
    if (n === 0) {
      pinchD = 0;
      if (dragging) {
        dragging = false;
        cv.classList.remove('dragging');
        if (moved < 5) pick(e.clientX, e.clientY);
      }
    }
  }
  window.addEventListener('pointerup', endPtr);
  window.addEventListener('pointercancel', endPtr);
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  cv.addEventListener('dblclick', function () { resetView(); });

  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    var f = Math.exp(-step * 0.0016);          // 指数档，触控板连发也不会一下冲到顶
    var ax = e.clientX - W / 2, ay = e.clientY - H / 2;
    targetZoom = Math.max(0.35, Math.min(4.5, targetZoom * f));
    // 以光标为锚点缩放，锚点那块别跑出画面
    targetOffX = clampOff(ax + (targetOffX - ax) * f, W);
    targetOffY = clampOff(ay + (targetOffY - ay) * f, H);
    spinHold = performance.now() + 1200;
    syncHome();
  }, { passive: false });
  cv.addEventListener('click', function () { /* 点空处由 pointerup 处理 */ });

  elQ.addEventListener('input', function () {
    var q = elQ.value.trim().toLowerCase();
    if (!q) { matchSet = null; return; }
    matchSet = {};
    DATA.nodes.forEach(function (n) {
      if ((n.text || '').toLowerCase().indexOf(q) >= 0 || (n.ev || '').toLowerCase().indexOf(q) >= 0) {
        matchSet[n.i] = 1;
      }
    });
    var k = Object.keys(matchSet).length;
    elSub.innerHTML = k ? ('命中 <b>' + k + '</b> 条记忆') : '没有命中，换个词试试';
  });
  elQ.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !matchSet) return;
    var first = Object.keys(matchSet)[0];
    if (first === undefined) return;
    focusNode(+first, true);
  });

  /* ---------- 投影：3x3 矩阵而不是 yaw/pitch 欧拉角 ----------
   * 2026-11-01 反馈：手动旋转要能转满 360°。欧拉角纵向卡在 ±77° 的两道墙上，
   * 干脆换成累积旋转矩阵：横向绕世界 Y、纵向绕屏幕 X，随便转多少圈都不会锁死，
   * 也没有「转到顶上就翻不动」的死角。
   */
  var rot = [1, 0, 0, 0, 1, 0, 0, 0, 1], focal = 900;

  function rotReset(yw2, pt2) {
    var cy = Math.cos(yw2), sy = Math.sin(yw2);
    var cp = Math.cos(pt2), sp = Math.sin(pt2);
    rot[0] = cy;       rot[1] = 0;   rot[2] = sy;
    rot[3] = sp * sy;  rot[4] = cp;  rot[5] = -sp * cy;
    rot[6] = -cp * sy; rot[7] = sp;  rot[8] = cp * cy;
  }
  rotReset(-0.35, 0.22);

  function rotSpin(d) {              // 绕世界 Y 轴（自转、横向拖）
    var c = Math.cos(d), s = Math.sin(d);
    for (var r = 0; r < 9; r += 3) {
      var x = rot[r], z = rot[r + 2];
      rot[r] = x * c - z * s;
      rot[r + 2] = x * s + z * c;
    }
  }
  function rotTilt(d) {              // 绕屏幕 X 轴（纵向拖）
    var c = Math.cos(d), s = Math.sin(d);
    for (var j = 0; j < 3; j++) {
      var y = rot[3 + j], z = rot[6 + j];
      rot[3 + j] = y * c - z * s;
      rot[6 + j] = y * s + z * c;
    }
  }

  function project(x, y, z) {
    return [rot[0] * x + rot[1] * y + rot[2] * z,
            rot[3] * x + rot[4] * y + rot[5] * z,
            rot[6] * x + rot[7] * y + rot[8] * z];
  }

  function loop(now) {
    T = (now - t0) / 1000;
    frame++;
    // 按下 → spinFactor 快速归零（自转停手，人接手）；松手 → 惯性滑行 + 自转缓慢爬回
    if (dragging) {
      spinFactor += (0 - spinFactor) * 0.35;
      if (spinFactor < 0.003) spinFactor = 0;
    } else {
      spinFactor += (1 - spinFactor) * 0.016;
      if (Math.abs(yawVel) > 0.00004 || Math.abs(pitchVel) > 0.00004) {
        rotSpin(yawVel); rotTilt(pitchVel);
        yawVel *= 0.93; pitchVel *= 0.93;
      } else { yawVel = 0; pitchVel = 0; }
    }
    if (spin && now > spinHold) rotSpin(0.0016 * spinFactor);
    zoom += (targetZoom - zoom) * 0.12;
    offX += (targetOffX - offX) * 0.1;
    offY += (targetOffY - offY) * 0.1;

    focal = Math.min(W, H) * (MOBILE ? 1.34 : 1.02) * zoom;

    var cx = W / 2 + offX, cy = H / 2 + offY;

    // 压暗强度缓动：悬停轻压、点开重压，来回切不再一帧跳完
    var fTarget = cardIdx >= 0 ? 1 : (hoverIdx >= 0 ? 0.30 : 0);
    focusMix += (fTarget - focusMix) * 0.13;
    if (Math.abs(focusMix - fTarget) < 0.002) focusMix = fTarget;
    focusOn = focusMix > 0.6 ? 2 : (focusMix > 0.05 ? 1 : 0);

    var fIdx = cardIdx >= 0 ? cardIdx : hoverIdx;
    if (fIdx !== lastFocus) { lastFocus = fIdx; buildFocusNear(fIdx); }

    // 2026-11-07 底层视频背景：画布改成每帧先清空再贴半透明底，否则会叠影成一团黑
    ctx.clearRect(0, 0, W, H);
    if (bgCv) ctx.drawImage(bgCv, 0, 0, W, H);
    else { ctx.fillStyle = 'rgba(4,6,13,.72)'; ctx.fillRect(0, 0, W, H); }

    drawDust();

    var nodes = DATA.nodes, i, n, p, X, Y, Z, sc;

    // 雾核 → 亮芯 → 脑区厚雾 → 轨道环：先铺体积，再画线，cluster 才有「组织」的层次
    drawFog(cx, cy);
    drawCore(cx, cy);
    drawHalos(cx, cy);
    drawOrbits(cx, cy);

    // 投影全部节点（呼吸时带缓慢漂移）
    for (i = 0; i < N; i++) {
      n = nodes[i];
      if (breath && (i + frame) % 3 === 0) driftStep(i);
      p = project(n.p[0] + ox[i], n.p[1] + oy[i], n.p[2] + oz[i]);
      var depth = 420 + p[2];
      var k = focal / Math.max(depth, 60);
      px[i] = cx + p[0] * k;
      py[i] = cy + p[1] * k;
      pz[i] = p[2];
      pscale[i] = k;
    }

    // 2026-11-01 反馈：同色点太密才亮成色块 → 以所属脑区中心为原点径向散开，
    // 只动屏幕坐标（连线/命中都用同一组 px，不会错位）。
    // 蓝（事实）黄（教训）两团点最多，额外再散一档；散开系数写死，珠子大小靠密度自适应。
    var kk0, cp0, ck0, rr0, exb;
    for (kk0 in REG) {
      cp0 = project(REG[kk0].c[0], REG[kk0].c[1], REG[kk0].c[2]);
      ck0 = focal / Math.max(420 + cp0[2], 60);
      REG[kk0]._sx = cx + cp0[0] * ck0;
      REG[kk0]._sy = cy + cp0[1] * ck0;
    }
    for (i = 0; i < N; i++) {
      rr0 = REG[nodes[i].t];
      if (!rr0 || rr0._sx === undefined) continue;
      exb = exFor(nodes[i].t);
      rr0.ex = exb;
      px[i] = rr0._sx + (px[i] - rr0._sx) * exb;
      py[i] = rr0._sy + (py[i] - rr0._sy) * exb;
    }

    // 连线：呼吸时一根根长出，再淡下去
    var links = DATA.links;
    var LK = links.length;
    var linkDim = 1 - 0.86 * focusMix;
    var LB = 8, lbuck = [], lb;
    for (lb = 0; lb < LB; lb++) lbuck.push([]);
    ctx.lineWidth = 1;
    for (i = 0; i < LK; i++) {
      var a = links[i][0], b = links[i][1], w = links[i][2];
      var na = nodes[a], nb = nodes[b];
      if (!na || !nb) continue;
      if (hidden[na.t] || hidden[nb.t]) continue;
      var dimA = matchSet && !matchSet[a], dimB = matchSet && !matchSet[b];
      if (matchSet && dimA && dimB) continue;
      var hot = (cardIdx === a || cardIdx === b || hoverIdx === a || hoverIdx === b);

      var grow = 1, lv = 1;
      if (breath && !hot) {
        if (lStable[i]) {
          lv = 0.86 + 0.14 * Math.sin(T * 0.6 + lPh[i] * 6.2832);   // 骨架线：亮度轻呼吸
        } else {
          var pp = T / lDur[i] + lPh[i];
          pp -= Math.floor(pp);
          if (pp < 0.5) {
            var u = pp / 0.5;
            grow = u * u * (3 - 2 * u);        // 0→1 平滑长出
            lv = 0.2 + 0.8 * grow;
          } else if (pp > 0.74) {
            var v = (pp - 0.74) / 0.26;
            lv = 1 - 0.8 * v * v;              // 淡下去，留一层薄底
          }
          if (grow < 0.04) continue;
        }
      }

      var xa = px[a], ya = py[a], xb = px[b], yb = py[b];
      if (grow < 1) { xb = xa + (xb - xa) * grow; yb = ya + (yb - ya) * grow; }

      if (hot) {                                  // 焦点相关的几条单独提亮
        ctx.strokeStyle = '#9db8dc';
        ctx.globalAlpha = 0.62;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xb, yb);
        ctx.stroke();
        ctx.lineWidth = 1;
        continue;
      }
      // 同区连线压暗、跨区提亮：结构关系一眼能分出来，也不至于糊成一束扫帚
      var sameGrp = (na.t === nb.t);
      var la = Math.min(0.22, (0.030 + (w || 0.5) * 0.075)) *
        (1 - Math.min(Math.abs(pz[a]) / 320, 0.62)) * lv * linkDim *
        (sameGrp ? 0.55 : 1.06);
      if (la < 0.010) continue;
      var bi = Math.floor(la / 0.5 * LB);
      if (bi < 0) bi = 0; if (bi > LB - 1) bi = LB - 1;
      lbuck[bi].push(xa, ya, xb, yb);
    }
    // 分档一次性描完：少几千次 stroke，也给曲线留出预算
    ctx.lineCap = 'round';
    ctx.lineWidth = MOBILE ? 0.85 : 0.7;
    ctx.strokeStyle = 'rgba(108,142,200,1)';
    for (lb = 0; lb < LB; lb++) {
      var larr = lbuck[lb];
      if (!larr.length) continue;
      ctx.globalAlpha = ((lb + 0.5) / LB) * 0.40;
      ctx.beginPath();
      for (var j = 0; j < larr.length; j += 4) {
        var ax1 = larr[j], ay1 = larr[j + 1], bx1 = larr[j + 2], by1 = larr[j + 3];
        var ddx = bx1 - ax1, ddy = by1 - ay1;
        if (Math.abs(ddx) + Math.abs(ddy) < 42) {
          ctx.moveTo(ax1, ay1);
          ctx.lineTo(bx1, by1);
        } else {
          // 统一朝一侧微弯，直束散成旋涡星轨
          ctx.moveTo(ax1, ay1);
          ctx.quadraticCurveTo((ax1 + bx1) / 2 - ddy * 0.16, (ay1 + by1) / 2 + ddx * 0.16, bx1, by1);
        }
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;

    // 节点：先远后近。2026-11-01 改成「失焦光斑」——
    // 靠后的点更大更柔更暗（景深越深越虚），靠前的点小而实，
    // 叠在 lighter 上就是参考片那种一颗一颗的圆光珠，不再是硬针尖。
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    var order = SORTED;
    for (var oi = 0; oi < N; oi++) {
      i = order[oi];
      n = nodes[i];
      if (hidden[n.t]) continue;
      var base = KIND[n.t] ? KIND[n.t].color : '#8899bb';
      var blur = Math.min(Math.abs(pz[i]) / 320, 1);                 // 0 近 / 1 远
      var r = Math.max(0.95, 1.7 * pscale[i] * (n.w || 1) * 0.72 * (MOBILE ? 1.2 : 1));
      var depthFade = 1 - Math.min(Math.abs(pz[i]) / 340, 0.72);
      var alpha = depthFade * (1 - 0.38 * blur);                     // 远点压暗，但光斑变大
      if (breath) alpha *= 0.92 + 0.08 * (ox[i] / (driftA[i] || 1));   // 星点明暗微呼吸
      if (matchSet) alpha = matchSet[i] ? 1 : alpha * 0.14;
      if (focusMix > 0.02) {
        if (i === cardIdx) alpha = Math.min(1, alpha + 0.30 * focusMix);
        else if (i === hoverIdx) alpha = Math.min(1, alpha + 0.22 * focusMix);
        else if (nearBit && nearBit[i]) alpha *= (1 - 0.58 * focusMix);   // 邻居留一线，结构还在
        else {
          alpha *= Math.max(0.04, 1 - 1.02 * focusMix);
          if (alpha < 0.02) continue;
        }
      }
      if (i === hoverIdx || i === cardIdx) r *= (MOBILE ? 2.0 : 1.8);

      var sz, isBead = beadBit && beadBit[i];
      var bsc = beadScale[n.t] || 1;
      if (isBead) {
        sz = r * (9.2 + 9.6 * blur) * bsc * (MOBILE ? 1.12 : 1) * (quality ? 1 : 0.86);
        ctx.globalAlpha = Math.min(0.60, alpha * 0.46);
        ctx.drawImage(sprite[n.t] || sprite.fact, px[i] - sz / 2, py[i] - sz / 2, sz, sz);
        // 珠子补一颗实芯：有芯才像发光，不然是糊开的软糖
        ctx.globalAlpha = Math.min(0.34, alpha * (0.26 - blur * 0.15));
        ctx.fillStyle = (i === hoverIdx || i === cardIdx) ? '#ffffff' : base;
        ctx.beginPath();
        ctx.arc(px[i], py[i], Math.max(0.45, r * 0.30 * (1.1 - blur) * Math.sqrt(bsc)), 0, 6.2832);
        ctx.fill();
      } else {
        // 细尘：一颗点占一格，只留一点微光，凑成雾里的层次
        sz = r * 2.3 * (0.72 + 0.28 * bsc) * (quality ? 1 : 0.85);
        ctx.globalAlpha = Math.min(0.5, alpha * 0.36);
        ctx.drawImage(sprite[n.t] || sprite.fact, px[i] - sz / 2, py[i] - sz / 2, sz, sz);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // 丝缕盖在连线上，烟才有流动感
    drawFilaments();

    // 日期星
    if (DATA.days) {
      ctx.textAlign = 'center';
      var lastLabX = -999, lastLabY = -999;
      for (i = 0; i < DATA.days.length; i++) {
        var d = DATA.days[i];
        p = project(d.p[0], d.p[1], d.p[2]);
        var kk = focal / Math.max(420 + p[2], 60);
        var dx = cx + p[0] * kk, dy = cy + p[1] * kk;
        var da = (0.34 + 0.5 * (1 - Math.min(Math.abs(p[2]) / 340, 1))) *
                 (1 - 0.84 * focusMix);
        ctx.globalAlpha = da;
        var pd = (MOBILE ? 24 : 30) * (breath ? (1 + 0.07 * Math.sin(T * 1.05 + i * 1.7)) : 1);
        ctx.drawImage(sprite.day, dx - pd / 2, dy - pd / 2, pd, pd);
        // 手机上日期标签隔天出、且躲开上一个，免得挤成一团
        var showLab = !MOBILE || (i % 2 === 0);
        if (showLab && Math.hypot(dx - lastLabX, dy - lastLabY) < (MOBILE ? 34 : 26)) showLab = false;
        if (showLab) {
          ctx.font = (MOBILE ? '500 9.5px ' : '500 10.5px ') +
            '-apple-system,"PingFang SC",system-ui,sans-serif';
          ctx.fillStyle = 'rgba(255,212,121,' + Math.min(0.95, da + 0.25).toFixed(2) + ')';
          ctx.fillText(d.day.slice(5), dx, dy + (MOBILE ? 18 : 22));
          lastLabX = dx; lastLabY = dy;
        }
        d._x = dx; d._y = dy;
      }
      ctx.globalAlpha = 1;
    }

    // 聚焦连线 + 光圈 + 神经脉冲 + 脑区标签（画在节点之上，字才不会被点淹掉）
    drawFocusLinks();
    drawFocus();
    drawPulses();
    drawRegionLabels(cx, cy);

    // 帧率自适应：连续掉到 30ms 以上降档，稳在 20ms 以下再升回来
    var nowT = performance.now();
    if (lastT) {
      var dt = nowT - lastT;
      if (dt > 0 && dt < 220) frameMs = frameMs * 0.9 + dt * 0.1;
      if (frameMs > 30) { slowN++; fastN = 0; }
      else if (frameMs < 20) { fastN++; slowN = 0; }
    }
    lastT = nowT;

    requestAnimationFrame(loop);
  }

  // 每帧前按深度排一次序（简单插入式分桶，965 个足够快）
  var SORTED = [];
  function resort() {
    if (!DATA) return;
    var arr = [];
    for (var i = 0; i < N; i++) arr.push(i);
    arr.sort(function (a, b) { return pz[a] - pz[b]; });
    SORTED = arr;
  }
  setInterval(resort, 220);

  /* ---------- 拾取 ---------- */
  function nearest(x, y, tol) {
    var best = -1, bd = tol * tol;
    for (var i = 0; i < N; i++) {
      if (hidden[DATA.nodes[i].t]) continue;
      var dx = px[i] - x, dy = py[i] - y;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function hover(x, y) {
    hoverIdx = nearest(x, y, MOBILE ? 20 : 14);
    cv.style.cursor = hoverIdx >= 0 ? 'pointer' : 'grab';
  }

  function pick(x, y) {
    // 先按手准的半径找；没中就把网再放大一档，别让点了半天没动静
    var i = nearest(x, y, MOBILE ? 30 : 20);
    if (i < 0) i = nearest(x, y, MOBILE ? 52 : 40);
    if (i >= 0) {
      showCard(i);
      // 手机屏幕小，卡片会顶到脸上：把焦点抬到上半屏，别被卡片盖住
      if (MOBILE && px[i] != null) {
        targetOffY = clampOff(H * 0.34 - py[i], H);
        syncHome();
      }
      return;
    }
    // 日期星
    if (DATA.days) {
      for (var j = 0; j < DATA.days.length; j++) {
        var d = DATA.days[j];
        if (d._x == null) continue;
        if (Math.hypot(d._x - x, d._y - y) < 26) { focusDay(d.day); return; }
      }
    }
    hideCard();
  }

  function focusNode(i, open) {
    var n = DATA.nodes[i];
    if (!n) return;
    // 目标：把这一点挪到屏幕中间偏上（手机上半屏），避开底部详情卡
    var wantY = MOBILE ? H * 0.34 : H * 0.5;
    targetOffX = clampOff(W / 2 - px[i], W);
    targetOffY = clampOff(wantY - py[i], H);
    targetZoom = Math.min(2.2, targetZoom * 1.15);
    if (typeof syncHome === 'function') syncHome();
    if (open) showCard(i);
  }

  function focusDay(day) {
    hidden = {};
    Array.prototype.forEach.call(document.querySelectorAll('.lg'), function (el) { el.classList.remove('off'); });
    syncMix();
    var hit = {};
    DATA.nodes.forEach(function (n) { if (n.day === day) hit[n.i] = 1; });
    matchSet = hit;
    elQ.value = '';
    elSub.innerHTML = day + ' · <b>' + Object.keys(hit).length + '</b> 条记忆';
    var first = Object.keys(hit)[0];
    if (first !== undefined) focusNode(+first, false);
  }

  /* ---------- 详情卡 ---------- */
  function showCard(i) {
    var n = DATA.nodes[i];
    if (!n) return;
    cardIdx = i;
    var meta = KIND[n.t] || { name: n.t, color: '#8899bb' };
    elTag.textContent = meta.name;
    elTag.style.color = meta.color;
    elDay.textContent = n.day || '';
    elTxt.textContent = n.full || n.text || '';
    if (n.ev) { elEv.style.display = 'block'; elEv.innerHTML = '<em>证据链 · </em>' + esc(n.ev); }
    else elEv.style.display = 'none';
    elCard.classList.add('on');
  }

  function hideCard() {
    cardIdx = -1;
    elCard.classList.remove('on');
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { hideCard(); if (document.activeElement !== elQ) { elQ.value = ''; matchSet = null; } }
    if (e.key === ' ' && document.activeElement !== elQ) {
      e.preventDefault(); spin = !spin;
    }
    if ((e.key === 'b' || e.key === 'B') && document.activeElement !== elQ) setBreath(!breath);
    if ((e.key === 'p' || e.key === 'P') && document.activeElement !== elQ) togglePanel();
  });

  var elBreathRow = document.getElementById('breathRow');
  if (elBreathRow) elBreathRow.addEventListener('click', function () { setBreath(!breath); });

  /* ---------- 右上设置面板：展开 / 收起 ---------- */
  var elPanel = document.getElementById('panel');
  var elPanelHead = document.getElementById('panelHead');

  function setPanelCollapsed(on, remember) {
    if (!elPanel) return;
    on = !!on;
    elPanel.classList.toggle('collapsed', on);
    if (elPanelHead) elPanelHead.setAttribute('aria-expanded', on ? 'false' : 'true');
    // 只有用户自己点的时候才落盘，自动适配不该覆盖他的选择
    if (remember) {
      try { localStorage.setItem('starmap_panel_collapsed', on ? '1' : '0'); } catch (e) {}
    }
  }

  function togglePanel() {
    if (!elPanel) return;
    setPanelCollapsed(!elPanel.classList.contains('collapsed'), true);
    // 收起时把焦点还给画布，免得搜索框里的光标还占着键盘
    if (elPanel.classList.contains('collapsed') && document.activeElement === elQ) elQ.blur();
  }

  // 首次进来（没有保存过偏好）：窄屏交给抽屉，胶囊收起状态一律展开
  function autoPanel() {
    if (window.innerWidth <= 900) { setPanelCollapsed(false, false); return; }
    var v = null;
    try { v = localStorage.getItem('starmap_panel_collapsed'); } catch (e) {}
    if (v === null || v === undefined) setPanelCollapsed(false, false);
    else setPanelCollapsed(v === '1', false);
  }
  autoPanel();
  window.addEventListener('resize', function () {
    if (elPanel && !elPanel.classList.contains('collapsed') &&
        window.innerWidth <= 720 && document.activeElement === elQ) elQ.blur();
  });

  if (elPanelHead) {
    elPanelHead.addEventListener('click', togglePanel);
    elPanelHead.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
    });
  }

  /* ---------- 窄屏左侧抽屉：记忆构成 ---------- */
  var elLeft = document.querySelector('.hud-left');
  var elLeftTab = document.getElementById('leftTab');
  var elLeftClose = document.getElementById('leftClose');

  function leftOpen() {
    if (!elLeft) return;
    elLeft.classList.add('open');
    document.body.classList.add('left-open');
    if (elLeftTab) elLeftTab.setAttribute('aria-expanded', 'true');
    drawerClose();
  }
  function leftCloseDrawer() {
    if (!elLeft) return;
    elLeft.classList.remove('open');
    document.body.classList.remove('left-open');
    if (elLeftTab) elLeftTab.setAttribute('aria-expanded', 'false');
  }
  function leftToggle() {
    if (!elLeft) return;
    if (elLeft.classList.contains('open')) leftCloseDrawer(); else leftOpen();
  }

  if (elLeftTab) {
    elLeftTab.addEventListener('click', function (e) {
      e.stopPropagation();
      leftToggle();
    });
  }
  if (elLeftClose) {
    elLeftClose.addEventListener('click', function (e) {
      e.stopPropagation();
      leftCloseDrawer();
    });
  }

  /* ---------- 窄屏右侧抽屉：人格内核 / 认知流 / 记忆活跃 ---------- */
  var elDrawer = document.querySelector('.hud-right');
  var elAct = document.querySelector('.hud-bottom');
  var elDrawerTab = document.getElementById('drawerTab');
  var actHome = null;

  function drawerOpen() {
    if (!elDrawer) return;
    leftCloseDrawer();
    elDrawer.classList.add('open');
    document.body.classList.add('drawer-open');
    if (elDrawerTab) elDrawerTab.setAttribute('aria-expanded', 'true');
  }
  function drawerClose() {
    if (!elDrawer) return;
    elDrawer.classList.remove('open');
    document.body.classList.remove('drawer-open');
    if (elDrawerTab) elDrawerTab.setAttribute('aria-expanded', 'false');
  }
  function drawerToggle() {
    if (!elDrawer) return;
    if (elDrawer.classList.contains('open')) drawerClose(); else drawerOpen();
  }
  // 窄屏把「记忆活跃」搬进抽屉，宽屏放回原位
  function drawerSync() {
    if (!elDrawer || !elAct) return;
    var narrow = window.innerWidth <= 900;
    if (narrow) {
      if (!actHome) actHome = { p: elAct.parentNode, n: elAct.nextSibling };
      if (elAct.parentNode !== elDrawer) elDrawer.appendChild(elAct);
    } else {
      drawerClose();
      leftCloseDrawer();
      if (actHome && elAct.parentNode === elDrawer) {
        try { actHome.p.insertBefore(elAct, actHome.n); } catch (e) { actHome.p.appendChild(elAct); }
      }
      // 宽屏回到卡片形态，恢复用户存下的收起偏好
      var pv = null;
      try { pv = localStorage.getItem('starmap_panel_collapsed'); } catch (e) {}
      if (pv !== null && pv !== undefined) setPanelCollapsed(pv === '1', false);
    }
    // 窄屏里记忆构成归抽屉管，胶囊收起状态一律展开
    if (narrow) setPanelCollapsed(false, false);
  }

  if (elDrawerTab) {
    elDrawerTab.addEventListener('click', function (e) {
      e.stopPropagation();
      drawerToggle();
    });
  }
  var elDrawerClose = document.getElementById('drawerClose');
  if (elDrawerClose) {
    elDrawerClose.addEventListener('click', function (e) {
      e.stopPropagation();
      drawerClose();
    });
  }
  // 点星图区域收起抽屉
  var elStage = document.getElementById('stage');
  if (elStage) {
    elStage.addEventListener('pointerdown', function () {
      if (elDrawer && elDrawer.classList.contains('open')) drawerClose();
      if (elLeft && elLeft.classList.contains('open')) leftCloseDrawer();
    });
  }
  drawerSync();
  window.addEventListener('resize', drawerSync);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', drawerSync);

  /* ---------- 仿生脑区：排布 / 柔光 / 标签 / 脉冲 ---------- */

  /* 碎星尘/闪点的圆点贴图：以前一个 fillRect 方块，DPR 3 下近处的点会被放大成
   * 5~6 个物理像素的实心方块，远看就是一片脏。改成预烘的柔边圆点，小尺寸也圆。 */
  var dotCache = {};
  function dotSprite(color) {
    var c = dotCache[color];
    if (c) return c;
    var s = 24, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    var g = cv.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, hexA(color, 1));
    grd.addColorStop(0.50, hexA(color, 0.95));
    grd.addColorStop(0.80, hexA(color, 0.18));
    grd.addColorStop(1, hexA(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    dotCache[color] = cv;
    return cv;
  }

  function makeHalo(color) {
    var s = 256, c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, hexA(color, 0.18));
    grd.addColorStop(0.42, hexA(color, 0.14));
    grd.addColorStop(0.74, hexA(color, 0.05));
    grd.addColorStop(1, hexA(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  }

  /* ---------- 噪声：值噪声 + fbm，一次烘焙成星云雾 ----------
   * 原来的雾是三层径向渐变叠出来的，边缘圆得像气球，没有体积。
   * 现在按极坐标采样 fbm，再乘一个径向衰减遮罩：大团里套小团、带旋臂亮丝，
   * 运行期只 drawImage，不占每帧算力。
   */
  function rgbOf(hex) {
    var h = hex.replace('#', '');
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
  }

  function nz(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var s = seed * 2654435;
    var h00 = (hashN((xi * 374761 + yi * 668265 + s) | 0) % 4096) / 4096;
    var h10 = (hashN(((xi + 1) * 374761 + yi * 668265 + s) | 0) % 4096) / 4096;
    var h01 = (hashN((xi * 374761 + (yi + 1) * 668265 + s) | 0) % 4096) / 4096;
    var h11 = (hashN(((xi + 1) * 374761 + (yi + 1) * 668265 + s) | 0) % 4096) / 4096;
    var a = h00 + (h10 - h00) * u, b = h01 + (h11 - h01) * u;
    return a + (b - a) * v;
  }

  function fbm(x, y, seed, oct) {
    var sum = 0, amp = 0.5, tot = 0, f = 1;
    for (var i = 0; i < oct; i++) {
      sum += nz(x * f, y * f, seed + i * 71) * amp;
      tot += amp; amp *= 0.52; f *= 2.07;
    }
    return sum / tot;
  }

  function makeNebula(inner, outer, size, seed, strength) {
    var s = size || 256, c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var img = g.createImageData(s, s), d = img.data;
    var A = rgbOf(inner), B = rgbOf(outer);
    var half = s / 2, inv = 1 / half;
    var str = (strength == null) ? 1 : strength;
    var x, y, p;
    for (y = 0; y < s; y++) {
      var dy = (y + 0.5 - half) * inv;
      for (x = 0; x < s; x++) {
        var dx = (x + 0.5 - half) * inv;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > 1.02) continue;
        var th = Math.atan2(dy, dx);
        // 极坐标 + 角度拉伸：烟团沿角向拉长，才有旋臂的走向
        var nx = Math.cos(th) * r * 6.2 + 3.1;
        var ny = (Math.sin(th) * r * 6.2 + 1.9 + r * 2.2) * 0.62;
        var v = fbm(nx, ny, seed, 5);
        // 两条主旋臂：雾往臂上收，臂间留暗，才不是一圈均匀的磨砂
        var armS = Math.sin(th * 2 + r * 3.6 - v * 1.8);
        var swirl = armS > 0 ? Math.pow(armS, 1.90) : 0;
        var m = Math.pow(Math.max(0, 1 - r), 1.35);
        // 高对比映射：噪声低谷直接抠成洞，雾才是一缕一缕的，不是一层磨砂膜
        var t2 = v * 2.10 - 0.62;
        if (t2 <= 0) continue;
        // 再取一次幂压掉中间调：只留峰值丝缕，叠起来才不会糊成灰纱
        var a = Math.pow(t2, 1.45) * m * (0.11 + 1.30 * swirl) * str;
        if (a <= 0.004) continue;
        if (a > 0.96) a = 0.96;
        var mix = (v - 0.32) * 2.5;
        if (mix < 0) mix = 0; if (mix > 1) mix = 1;
        p = (y * s + x) * 4;
        d[p] = A[0] + (B[0] - A[0]) * mix;
        d[p + 1] = A[1] + (B[1] - A[1]) * mix;
        d[p + 2] = A[2] + (B[2] - A[2]) * mix;
        d[p + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    // 细亮丝：雾里撒一层极淡的白点，像悬浮的尘埃被照亮
    var cnt = Math.floor(s * 0.55);
    for (var i = 0; i < cnt; i++) {
      var h = hashN(i * 7919 + seed * 131 + 13);
      var rd = Math.sqrt((h % 1000) / 1000) * half * 0.94;
      var tha = ((h >>> 10) % 3600) / 3600 * 6.2832;
      g.globalAlpha = 0.03 + ((h >>> 20) % 100) / 1500;
      g.fillStyle = '#ffffff';
      g.fillRect(half + Math.cos(tha) * rd, half + Math.sin(tha) * rd * 0.82, 1.4, 1.4);
    }
    g.globalAlpha = 1;
    return c;
  }

  /* ---------- 碎星辰：每颗星认领一条记忆 ----------
   * 2026-11-03 反馈：环上的碎星辰原来跟自己一点关系都没有（纯随机铺满）。
   * 现在一颗碎星对一条记忆，谁亮谁暗、谁闪得急，全由那条记忆有多深刻决定：
   *   L5 最深刻：最亮、闪得最快；L4 / L3 / L2 / L1 依次往下降级（更暗、更慢）。
   * 深刻度 = 节点权重 w 0.52 + 连边度 0.28 + 类型 0.20
   *   （lesson / preference 最高，fact 次之，msg 最低）。
   * 档位按全部记忆的分位切：6% / 12% / 27% / 27% / 28%。
   * 点数、位置、密度、粒径一概不动 —— 只改每颗星的亮度与节拍；
   * 亮度倍率与速度倍率都做了均值归一，整条环的总亮度、总节奏跟改之前一样，
   * 星河原来的走向和雾感不变，变的是「哪几颗星在替深刻的记忆发光」。
   */
  var RING = null, RING_ORDER = null;

  function buildRing() {
    if (RING || !DATA || !DATA.nodes || !DATA.nodes.length) return;
    var nodes = DATA.nodes, n = nodes.length, i, k;
    var deg = new Uint16Array(n), links = DATA.links || [];
    for (i = 0; i < links.length; i++) { deg[links[i][0]]++; deg[links[i][1]]++; }
    var maxD = 1;
    for (i = 0; i < n; i++) if (deg[i] > maxD) maxD = deg[i];
    var lmax = Math.log(1 + maxD);
    var TW = { lesson: 1.0, preference: 0.95, fact: 0.68, doc: 0.34, msg: 0.14 };
    var IMP = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var nd = nodes[i];
      var wN = ((nd.w || 1) - 0.35) / 1.55;
      wN = wN < 0 ? 0 : (wN > 1 ? 1 : wN);
      var tw = TW[nd.t]; if (tw == null) tw = 0.5;
      IMP[i] = 0.52 * wN + 0.28 * Math.log(1 + deg[i]) / lmax + 0.20 * tw;
    }
    // 按深刻度从高到低排；再切五档
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (x, y) { return IMP[y] - IMP[x] || x - y; });
    var EDGE = [0.06, 0.18, 0.45, 0.72];          // 累计分位：L5 前 6%，L4 到 18%……
    var lvNode = new Uint8Array(n), cnt = [0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) {
      var rank = i / n, k2 = 0;
      while (k2 < 4 && rank >= EDGE[k2]) k2++;
      var lv = 4 - k2;                       // lv 4 = 最深刻，lv 0 = 最浅
      lvNode[order[i]] = lv; cnt[lv]++;
    }
    // 两池：最深刻那批单独一池，按节拍均匀撒进环里；其余用步长跳着取，不扎堆也不重样
    var B = cnt[4] || 0;
    var bright = order.slice(0, B), rest = order.slice(B);
    if (!rest.length) { bright = order.slice(0, n >> 1); rest = order.slice(n >> 1); B = bright.length; }
    var stepR = 7919 % rest.length;
    while (stepR < 2) stepR += 7;
    while (gcd(stepR, rest.length) !== 1) stepR++;
    RING_ORDER = { bright: bright, rest: rest, stepR: stepR, B: B };
    // 亮度 / 速度倍率，按档位实际占比做均值归一到 1
    var A = [0.45, 0.62, 0.85, 1.25, 1.90];
    var S = [0.55, 0.72, 1.00, 1.45, 2.10];
    var am = 0, sm = 0;
    for (k = 0; k < 5; k++) { am += A[k] * cnt[k]; sm += S[k] * cnt[k]; }
    am /= n; sm /= n;
    if (!(am > 0)) am = 1;
    if (!(sm > 0)) sm = 1;
    var AA = [], SS = [];
    for (k = 0; k < 5; k++) { AA[k] = A[k] / am; SS[k] = S[k] / sm; }
    RING = { n: n, lvNode: lvNode, a: AA, s: SS, cnt: cnt,
             bright: RING_ORDER.bright, rest: RING_ORDER.rest,
             stepR: RING_ORDER.stepR, B: RING_ORDER.B };
  }

  function gcd(a, b) {
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  /* 雾体与轨道：等 REG 建好后一次成型，窄屏切换时重建 */
  function initViz() {
    buildRing();
    // 2026-11-02 手机端雾体贴图从 0.7 抬到 1.0：0.7 时 168px 的贴图被拉到屏幕上放大六七倍，
    // 那几团脑区雾就糊成一块棉花。抬到 1.0 是像素量翻倍，手机上仍是一次性开销。
    var q = MOBILE ? 1.0 : 1.0;
    fogMain = makeNebula('#f4eeff', '#8f6bff', Math.round(300 * q), 11, 1.22);
    fogCool = makeNebula('#d8ecff', '#4f7fd8', Math.round(300 * q), 29, 0.92);
    coreGlow = makeNebula('#ffffff', '#ffd9f4', Math.round(190 * q), 47, 0.88);
    fogSoft = {};
    var i = 0;
    for (var k in REG) {
      fogSoft[k] = makeNebula('#ffffff', REG[k].color, Math.round(168 * q), 101 + i * 17, 1.04);
      i++;
    }
    focusGlow = makeNebula('#ffd6f2', '#a97bff', Math.round(168 * q), 211, 1.1);
    initOrbits();
  }

  function initOrbits() {
    var R = REG_EXT || 120;
    var dseq = 0, bi = 0, ri = 0;    // 碎星序号 + 两个记忆池的游标
    // 2026-11-01 反馈：轨道不止两圈，按参考图加回多圈（内紧外松、越外越淡）。
    // 线不再是实线：贴着轨道铺碎星尘（雾面）+ 各自眨眼的小星。
    orbits = [
      { r: R * 1.12, tilt: -0.44, yaw0: 1.15, spd: -0.036, color: '#8fc6ff', a: 0.52, bs: 0.37, ph: 1.85, gk: 1.18, dots: [], dust: [], stars: [] },
      { r: R * 1.40, tilt:  0.58, yaw0: 2.40, spd:  0.023, color: '#9fe6ff', a: 0.40, bs: 0.30, ph: 3.60, gk: 1.45, dots: [], dust: [], stars: [] },
      { r: R * 1.72, tilt: -0.22, yaw0: 0.62, spd: -0.017, color: '#aac9ff', a: 0.30, bs: 0.25, ph: 5.10, gk: 0.98, dots: [], dust: [], stars: [] },
      { r: R * 2.06, tilt:  0.34, yaw0: 1.88, spd:  0.013, color: '#bcb6ff', a: 0.22, bs: 0.21, ph: 2.65, gk: 0.80, dots: [], dust: [], stars: [] },
      { r: R * 2.44, tilt: -0.55, yaw0: 3.10, spd: -0.010, color: '#d6b8ff', a: 0.15, bs: 0.18, ph: 4.30, gk: 0.64, dots: [], dust: [], stars: [] }
    ];
    for (var oi = 0; oi < orbits.length; oi++) {
      var o = orbits[oi], cnt = (MOBILE ? 5 : 8) - Math.min(oi, 4);
      for (var i = 0; i < cnt; i++) {
        var h = hashN(oi * 7717 + i * 131 + 3);
        o.dots.push({
          ph: (h % 1000) / 1000,
          sz: 0.5 + ((h >>> 8) % 100) / 90,
          sp: 0.7 + ((h >>> 16) % 100) / 180,
          warm: ((h >>> 22) % 2) === 0
        });
      }
      // 碎星尘：密而极小，粒径 1~2.3px，各自慢涨慢落，叠出「点状的雾」
      // 圈数加多后总量按圈递减，内侧密、外侧稀，别把手机压垮
      // 2026-11-01 反馈：碎星要一眼看见 → 点数按各圈周长分配，内外密度一致，
      // 原来是按圈递减，外圈点距 50px 以上只剩孤立星子，连不成环。
      var dN = Math.round((MOBILE ? 165 : 300) * (1.12 + oi * 0.33) * (quality ? 1 : 0.55));
      for (var d = 0; d < dN; d++) {
        var hd = hashN(oi * 91193 + d * 7919 + 11);
        var dAng = ((hd % 4096) / 4096) * 6.2832;
        // 认领一条记忆：约每 17 颗里的一颗拿「最深刻」池（均匀撒满一整圈），其余顺序铺开
        var mIdx = -1;
        if (RING) {
          if (bi < RING.B && ((dseq * 13 + 7) % 17) === 0) { mIdx = RING.bright[bi++]; }
          else { mIdx = RING.rest[(ri++ * RING.stepR) % RING.rest.length]; }
        }
        o.dust.push({
          ang: dAng,
          lv: (RING && mIdx >= 0) ? RING.lvNode[mIdx] : 2,   // 深刻度档位 0~4
          mi: mIdx,
          rr: 1 + (((hd >>> 12) % 200) / 200 - 0.5) * 0.032,
          jy: ((((hd >>> 20) % 200) / 200) - 0.5) * o.r * 0.055,
          sz: 0.7 + ((hd >>> 4) % 100) / 100 * 1.6,
          a: 0.30 + ((hd >>> 8) % 100) / 100 * 0.70,
          ph: ((hd >>> 16) % 1000) / 1000 * 6.2832,
          sp: 0.82 + ((hd >>> 24) % 100) / 100 * 2.30,   // 2026-11-01 反馈：闪烁再快一点点
          warm: ((hd >>> 3) % 5) === 0
        });
        dseq++;
      }
      // 闪星：少而亮，正弦抬到三次方，多数时候暗着，亮起来才闪一下
      var sN = Math.round((MOBILE ? 14 : 28) * (1 - oi * 0.12));
      for (var s2 = 0; s2 < sN; s2++) {
        var hs = hashN(oi * 31337 + s2 * 7919 + 97);
        o.stars.push({
          ang: ((hs % 4096) / 4096) * 6.2832,
          rr: 1 + (((hs >>> 12) % 120) / 120 - 0.5) * 0.020,
          jy: ((((hs >>> 20) % 200) / 200) - 0.5) * o.r * 0.035,
          sz: 1.5 + ((hs >>> 4) % 100) / 100 * 1.7,
          ph: ((hs >>> 8) % 1000) / 1000 * 6.2832,
          sp: 1.42 + ((hs >>> 18) % 100) / 100 * 4.05,  // 同上，闪星同步加快
          warm: ((hs >>> 6) % 6) === 0
        });
      }
    }
  }

  function orbitPoint(o, ang, rr, dy) {
    var rad = (rr == null) ? o.r : rr;
    var x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    var ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
    var y1 = -z * st + (dy || 0), z1 = z * ct;
    var yw = o.yaw0 + T * o.spd;
    var cyw = Math.cos(yw), syw = Math.sin(yw);
    return [x * cyw + z1 * syw, y1, -x * syw + z1 * cyw];
  }

  /* ---------- 珠子与星尘：两千颗点挤在一起只会糊成雾，得先分层 ----------
   * 参考片里是几十颗圆珠散在烟里，不是两千颗针尖。做法：
   * 按节点权重挑一批「珠」（桌面 260 / 手机 150）画成大圆光斑，
   * 剩下的压成极淡的细尘，近看还在，远看是雾——数据一颗没少，只是分了主次。
   */
  var beadBit = null;

  /* 散开系数：蓝（事实）黄（教训）点最多、糊成色块，桌面再散一档；其余保持原样，红团不动。 */
  function exFor(t) {
    if (MOBILE) {
      if (t === 'fact') return 1.16;
      if (t === 'lesson') return 1.17;
      if (t === 'preference') return 1.10;
      if (t === 'day') return 1.05;
      return 1.10;
    }
    if (t === 'fact') return 1.28;
    if (t === 'lesson') return 1.29;
    if (t === 'preference') return 1.17;
    if (t === 'day') return 1.10;
    return 1.17;
  }

  /* 珠子大小按「本团节点数」自适应：团里越多，单颗越细，整团直径不跟着涨。
   * 200 是参照量（当前事实区数量级），指数 0.22 收得慢一些；只往细里收，不往大里放。 */
  var beadScale = {};
  function computeBeadScale() {
    var cnt = {}, i, t;
    for (i = 0; i < N; i++) {
      t = DATA.nodes[i].t;
      cnt[t] = (cnt[t] || 0) + 1;
    }
    var HARD = { fact: 0.88, lesson: 0.84 };   // 用户点名蓝黄再小一些
    beadScale = {};
    Object.keys(cnt).forEach(function (k) {
      var s = Math.pow(200 / cnt[k], 0.22);
      if (s > 1) s = 1;
      s *= HARD[k] || 1;
      beadScale[k] = Math.max(0.58, s);
    });
  }

  function buildBeads() {
    beadBit = new Uint8Array(N);
    computeBeadScale();
    var arr = [], i;
    for (i = 0; i < N; i++) arr.push(i);
    arr.sort(function (a, b) {
      var wa = DATA.nodes[a].w || 1, wb = DATA.nodes[b].w || 1;
      if (wb !== wa) return wb - wa;
      return (hashN(a * 2654435 + 91) % 9973) - (hashN(b * 2654435 + 91) % 9973);
    });
    var cap = Math.min(arr.length, MOBILE ? 110 : 180);
    for (i = 0; i < cap; i++) beadBit[arr[i]] = 1;
  }

  function drawFog(cx, cy) {
    if (!fogMain) return;
    var base = Math.min(W, H) * (MOBILE ? 0.92 : 0.80);
    // 2026-11-01 反馈：满屏盖一层雾太糊 → 整体压薄，留两圈极淡的底，主光交给环上光核
    var dim = (1 - 0.58 * focusMix) * (MOBILE ? 0.58 : 0.50);
    var layers = quality ? 2 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < layers; k++) {
      var ph = T * 0.05 + k * 0.85;
      var sc = base * (1 - k * 0.24) * (1 + 0.028 * Math.sin(T * 0.27 + k * 1.9));
      var dx = Math.cos(ph) * base * 0.042;
      var dy = Math.sin(ph * 0.77) * base * 0.038;
      ctx.save();
      ctx.translate(cx + dx, cy + dy);
      ctx.rotate(T * 0.052 + k * 0.19);
      var breathA = 1 + 0.075 * Math.sin(T * (0.30 + k * 0.11) + k * 2.1);
      ctx.globalAlpha = (k === 0 ? 0.54 : 0.30) * dim * breathA;
      ctx.drawImage(k === 1 ? fogCool : fogMain, -sc, -sc * 0.82, sc * 2, sc * 1.64);
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* 中心亮芯：一颗白核 + 两条旋臂，慢慢转；这是整张图的「引力中心」 */
  function drawCore(cx, cy) {
    if (!coreGlow) return;
    var base = Math.min(W, H);
    var dim = 1 - 0.66 * focusMix;
    var R = base * (MOBILE ? 0.34 : 0.31);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 外晕
    ctx.globalAlpha = (0.38 + 0.085 * Math.sin(T * 0.8)) * dim;
    ctx.drawImage(coreGlow, cx - R, cy - R, R * 2, R * 2);

    // 白核：一团爆亮，整张图的曝光中心
    var cr = base * (MOBILE ? 0.076 : 0.062) * (1 + 0.035 * Math.sin(T * 0.9));
    var rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    rg.addColorStop(0, 'rgba(255,252,255,0.72)');
    rg.addColorStop(0.22, 'rgba(232,224,255,0.38)');
    rg.addColorStop(0.55, 'rgba(168,150,255,0.14)');
    rg.addColorStop(1, 'rgba(120,110,255,0)');
    ctx.globalAlpha = 0.70 * dim;
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, 6.2832);
    ctx.fill();

    // 旋臂：2026-11-01 用户反馈那条细亮硬线删掉 → 只留一遍宽柔光打体积，不再描细丝骨架
    var arms = MOBILE ? 2 : 3;
    var spin = T * 0.09, i, u, ang, rr, px2, py2;
    for (var a = 0; a < arms; a++) {
      var off = a * 6.2832 / arms + spin;
      ctx.beginPath();
      for (i = 0; i <= 30; i++) {
        u = i / 30;
        ang = off + u * 2.7;
        rr = base * (0.04 + u * 0.24);
        px2 = cx + Math.cos(ang) * rr;
        py2 = cy + Math.sin(ang) * rr * 0.62;
        if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
      }
      ctx.strokeStyle = '#8f7bff';
      ctx.lineWidth = MOBILE ? 5.0 : 6.5;
      ctx.globalAlpha = (0.10 - a * 0.025) * dim;
      ctx.stroke();
    }

    // 十字星芒：细到几乎只剩一条线，点睛用
    ctx.globalAlpha = 0.08 * dim;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    var L1 = base * 0.30, L2 = base * 0.19;
    ctx.beginPath();
    ctx.moveTo(cx - L1, cy); ctx.lineTo(cx + L1, cy);
    ctx.moveTo(cx, cy - L2); ctx.lineTo(cx, cy + L2);
    ctx.stroke();

    // 融合罩：核的边缘用雾再盖一层，白核才不会像贴上去的灯泡
    if (fogMain) {
      var fR = base * (MOBILE ? 0.62 : 0.54);
      ctx.globalAlpha = 0.22 * dim;
      ctx.drawImage(fogMain, cx - fR, cy - fR * 0.84, fR * 2, fR * 1.68);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function strokeSegs(arr) {
    ctx.beginPath();
    for (var j = 0; j < arr.length; j += 4) {
      ctx.moveTo(arr[j], arr[j + 1]);
      ctx.lineTo(arr[j + 2], arr[j + 3]);
    }
    ctx.stroke();
  }

  function drawOrbits(cx, cy) {
    if (!orbits.length || !DATA) return;
    var fade = 1 - 0.72 * focusMix;
    var SEG = MOBILE ? 64 : 96, LV = 8;
    for (var oi = 0; oi < orbits.length; oi++) {
      var o = orbits[oi];
      // 2026-11-01 反馈：轨道底下那条连续雾带整段删掉——它按屏幕中心铺、不跟缩放走，
      // 远看就是一根硬线。环现在只由碎星尘 + 闪星 + 流星点拼出来，不再描任何整段线。
      // 呼吸：每条轨道一个自己的相位，光雾厚度与亮度一起缓慢涨落
      var br = 0.70 + 0.30 * Math.sin(T * o.bs + o.ph);        // 0.40 ~ 1.00

      // 碎星尘：贴着轨道铺一层小点，远看是会呼吸的雾面，近看是一颗颗星子
      var dust = o.dust, dstep = quality ? 1 : 2;
      // 2026-11-01 反馈：碎星要「一眼看见」→ 星尘改用叠加混合，密集处自然亮成一条星带
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var di = 0; di < dust.length; di += dstep) {
        var q = dust[di];
        var wd = orbitPoint(o, q.ang, o.r * q.rr, q.jy);
        var pd = project(wd[0], wd[1], wd[2]);
        var kd = focal / Math.max(420 + pd[2], 60);
        var DX = cx + pd[0] * kd, DY = cy + pd[1] * kd;
        if (DX < -30 || DX > W + 30 || DY < -30 || DY > H + 30) continue;
        var nd = 1 - Math.min(Math.abs(pd[2]) / 700, 0.76);
        var qlv = q.lv == null ? 2 : q.lv;
        // 2026-11-03 反馈：深刻的那颗亮且闪得急，不深刻的暗且慢，按档依次降级
        var twd = 0.5 + 0.5 * Math.sin(T * q.sp * (RING ? RING.s[qlv] : 1) + q.ph);
        // 2026-11-01 反馈：碎星尘太暗看不出来 → 提亮、放大一档（外圈按 o.a 递减但不至于看不见）
        ctx.globalAlpha = Math.min(1, (0.30 + 0.52 * twd) * q.a * nd * fade * (0.86 + o.a * 1.15) * 1.34 * (RING ? RING.a[qlv] : 1));
        // 2026-11-02 反馈：手机上看碎星辰还是糊、电脑上不糊。
        // 真凶不是分辨率（画布本来就是原生 3 倍），是「点径固定、间距随 focal 缩」：
        // 手机 focal≈538、桌面≈1020，同样的点数压在只有一半长的星带上，
        // 点宽还是 2~3px，间距掉到 2~4px —— 点与点直接叠死成一条灰雾；
        // 近处的点又被放大成 5~6 个物理像素的实心方块，看着发脏。
        // 现在：粒径跟着 focal 一起缩（桌面 1020 为基准，桌面观感不动），
        // 画法从 fillRect 方块换成预烘的柔边圆点贴图，再按物理像素对齐。
        var sbase = q.sz * (0.95 + nd * 0.65) * (focal / 1020);
        var spr = dotSprite(q.warm ? '#ffeadc' : o.color);
        var dd = Math.max(1.25, sbase * 2.2);
        ctx.drawImage(spr, Math.round((DX - dd * 0.5) * DPR) / DPR, Math.round((DY - dd * 0.5) * DPR) / DPR, dd, dd);
      }
      ctx.restore();

      // 闪星：线上真正会闪的那批，各自一个节拍，不跟轨道呼吸同步
      var stars = o.stars;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var si = 0; si < stars.length; si++) {
        var st = stars[si];
        var ws = orbitPoint(o, st.ang, o.r * st.rr, st.jy);
        var ps = project(ws[0], ws[1], ws[2]);
        var ks = focal / Math.max(420 + ps[2], 60);
        var SX = cx + ps[0] * ks, SY = cy + ps[1] * ks;
        if (SX < -40 || SX > W + 40 || SY < -40 || SY > H + 40) continue;
        var ns = 1 - Math.min(Math.abs(ps[2]) / 760, 0.80);
        var twk = Math.pow(0.5 + 0.5 * Math.sin(T * st.sp + st.ph), 2.2);
        var rs = st.sz * (MOBILE ? 2.2 : 2.9) * (0.55 + twk * 1.6) * (0.85 + ns * 0.4);
        ctx.globalAlpha = Math.min(1, (0.24 + 0.80 * twk) * ns * fade * (0.58 + 0.42 * o.a) * (0.85 + 0.30 * br));
        ctx.drawImage(st.warm ? sprite.preference : sprite.fact, SX - rs, SY - rs, rs * 2, rs * 2);
      }
      ctx.restore();

      // 环上流星点：带三段短拖尾，环才有流动感（拖尾越往后越淡）
      for (var d = 0; d < o.dots.length; d++) {
        var q2 = o.dots[d];
        var baseAng = T * o.spd * 1.9 * q2.sp + q2.ph * 6.2832;
        for (var tg = 3; tg >= 0; tg--) {
          var wa = orbitPoint(o, baseAng - tg * 0.013 * (o.spd > 0 ? 1 : -1));
          var pf = project(wa[0], wa[1], wa[2]);
          var kk = focal / Math.max(420 + pf[2], 60);
          var DX2 = cx + pf[0] * kk, DY2 = cy + pf[1] * kk;
          if (DX2 < -40 || DX2 > W + 40 || DY2 < -40 || DY2 > H + 40) continue;
          var near2 = 1 - Math.min(Math.abs(pf[2]) / 700, 0.76);
          var sz = (MOBILE ? 2.4 : 3.0) * q2.sz * (1 - tg * 0.17) * (0.8 + near2 * 0.55);
          ctx.globalAlpha = (tg === 0 ? 0.72 : 0.22 / tg) * near2 * fade;
          ctx.drawImage(q2.warm ? sprite.preference : sprite.fact, DX2 - sz, DY2 - sz, sz * 2, sz * 2);
        }
      }
      // 环上光核：线上亮一颗光，随即向外扩一圈淡雾再散掉——
      // 2026-11-01 反馈：光晕要从环上长出来，不要满屏盖一层。
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var bloomN = MOBILE ? 3 : 5;
      for (var bi = 0; bi < bloomN; bi++) {
        var bAng = bi / bloomN * 6.2832 + T * o.spd * 0.35;
        var bw2 = orbitPoint(o, bAng);
        var bp2 = project(bw2[0], bw2[1], bw2[2]);
        var bk2 = focal / Math.max(420 + bp2[2], 60);
        var BX = cx + bp2[0] * bk2, BY = cy + bp2[1] * bk2;
        var bn = 1 - Math.min(Math.abs(bp2[2]) / 700, 0.78);
        if (BX < -W * 0.25 || BX > W * 1.25 || BY < -H * 0.25 || BY > H * 1.25) continue;
        for (var pu = 0; pu < 3; pu++) {
          var cyp = (T * 0.11 + bi / bloomN + pu / 3) % 1;
          var rr2 = Math.min(W, H) * (0.030 + 0.105 * cyp);
          ctx.globalAlpha = 0.34 * Math.sin(cyp * Math.PI) * bn * (0.45 + 0.55 * o.a) * fade;
          ctx.drawImage(fogSoft.fact || fogMain, BX - rr2, BY - rr2, rr2 * 2, rr2 * 2);
        }
        var cs = (MOBILE ? 2.6 : 3.4) * (0.85 + bn * 0.6);
        ctx.globalAlpha = Math.min(1, 0.95 * bn * (0.55 + 0.45 * o.a) * fade);
        ctx.drawImage(sprite.fact, BX - cs, BY - cs, cs * 2, cs * 2);
      }
      ctx.restore();

      // 环带雾：2026-11-01 用户反馈整段删掉——6 片发光贴图并排叠成一条不跟缩放的色带，
      // 远看就是那根硬线。轨道现在只由碎星尘 + 闪星 + 流星点长出来。
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  /* 聚焦：焦点与相邻节点的连线单独提亮，其余全压下去 */
  function drawFocusLinks() {
    if (focusMix <= 0.02 || !nearList || !nearList.length) return;
    var idx = cardIdx >= 0 ? cardIdx : hoverIdx;
    if (idx < 0 || idx >= N) return;
    var X = px[idx], Y = py[idx];
    if (X == null || isNaN(X)) return;
    var lim = Math.min(W, H) * 0.92;
    ctx.lineCap = 'round';
    for (var i = 0; i < nearList.length; i++) {
      var j = nearList[i];
      var x2 = px[j], y2 = py[j];
      if (x2 == null || isNaN(x2)) continue;
      var dist = Math.hypot(x2 - X, y2 - Y);
      if (dist < 4 || dist > lim) continue;
      var a = 0.40 * focusMix * (1 - dist / lim * 0.8);
      ctx.globalAlpha = a;
      ctx.strokeStyle = (i % 3 === 0) ? '#ffc7ee' : '#b9c9ff';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(X, Y);
      ctx.lineTo(X + (x2 - X) * 0.88, Y + (y2 - Y) * 0.88);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  /* 丝缕：骨架线外面套一层粗而极淡的光，连线就成了流动的烟 */
  function drawFilaments() {
    var links = DATA.links, LK = links.length;
    var want = MOBILE ? 24 : 42;
    var step = Math.max(1, Math.floor(LK / want));
    var fade = 1 - 0.70 * focusMix;
    var lim = Math.min(W, H) * 1.4;
    ctx.lineCap = 'round';
    for (var i = 0; i < LK; i += step) {
      var lk = links[i];
      if (!lk) continue;
      var a = lk[0], b = lk[1];
      var na = DATA.nodes[a], nb = DATA.nodes[b];
      if (!na || !nb || hidden[na.t] || hidden[nb.t]) continue;
      var xa = px[a], ya = py[a], xb = px[b], yb = py[b];
      if (xa == null || xb == null) continue;
      var dist = Math.hypot(xb - xa, yb - ya);
      if (dist < 36 || dist > lim) continue;
      ctx.globalAlpha = 0.016 * fade * (1 - Math.min(dist / lim, 0.7));
      ctx.strokeStyle = (i % 3 === 0) ? '#6c5aa8' : '#4f6d9c';
      ctx.lineWidth = 4 + (i % 4) * 2;
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(xb, yb);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  /* 聚焦：只留焦点与一圈粉紫光圈 */
  function drawFocus() {
    if (cardIdx < 0 || cardIdx >= N || !focusGlow) return;
    var X = px[cardIdx], Y = py[cardIdx];
    if (X == null || Y == null || isNaN(X) || isNaN(Y)) return;
    var f = Math.max(0.25, focusMix);
    var pulse = 0.9 + 0.1 * Math.sin(T * 2.2);
    var R1 = (MOBILE ? 22 : 30) * pulse;
    var R2 = (MOBILE ? 36 : 48) * pulse;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.40 * f;
    ctx.drawImage(focusGlow, X - R2 * 2.2, Y - R2 * 2.2, R2 * 4.4, R2 * 4.4);
    ctx.restore();
    ctx.globalAlpha = 0.82 * f;
    ctx.strokeStyle = '#ffc0ea';
    ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.arc(X, Y, R1, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 0.32 * f;
    ctx.strokeStyle = '#c4a8ff';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(X, Y, R2, 0, 6.2832); ctx.stroke();
    // 十字星芒：把视线钉在焦点上
    var sp = R2 * 2.0;
    ctx.globalAlpha = 0.5 * f;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(X - sp, Y); ctx.lineTo(X - R2 * 1.02, Y);
    ctx.moveTo(X + R2 * 1.02, Y); ctx.lineTo(X + sp, Y);
    ctx.moveTo(X, Y - sp); ctx.lineTo(X, Y - R2 * 1.02);
    ctx.moveTo(X, Y + R2 * 1.02); ctx.lineTo(X, Y + sp);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * f;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(X, Y, 2.4, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function initRegions() {
    var i, k, n, R = 0;
    for (i = 0; i < N; i++) {
      n = DATA.nodes[i];
      R = Math.max(R, Math.abs(n.p[0]), Math.abs(n.p[1]), Math.abs(n.p[2]));
    }
    if (!R) R = 100;
    var ring = R * 0.80, K = 0.78;
    // 一次线性混合：保留原来的相对结构，同时把同类节点拉成一团
    for (i = 0; i < N; i++) {
      n = DATA.nodes[i];
      var rg = REGION[n.t] || REGION.fact;
      n.p[0] = n.p[0] * (1 - K) + rg.a[0] * ring * K;
      n.p[1] = n.p[1] * (1 - K) + rg.a[1] * ring * K;
      n.p[2] = n.p[2] * (1 - K) + rg.a[2] * ring * K;
    }
    var dRg = REGION.day;
    (DATA.days || []).forEach(function (d) {
      d.p[0] = d.p[0] * (1 - K) + dRg.a[0] * ring * K;
      d.p[1] = d.p[1] * (1 - K) + dRg.a[1] * ring * K;
      d.p[2] = d.p[2] * (1 - K) + dRg.a[2] * ring * K;
    });

    // 每区圆心 = 成员均值；半径 = 82% 分位距离
    var acc = {};
    Object.keys(REGION).forEach(function (kk) { acc[kk] = { n: 0, x: 0, y: 0, z: 0 }; });
    for (i = 0; i < N; i++) {
      n = DATA.nodes[i];
      k = REGION[n.t] ? n.t : 'fact';
      acc[k].n++; acc[k].x += n.p[0]; acc[k].y += n.p[1]; acc[k].z += n.p[2];
    }
    (DATA.days || []).forEach(function (d) {
      acc.day.n++; acc.day.x += d.p[0]; acc.day.y += d.p[1]; acc.day.z += d.p[2];
    });
    REG = {};
    Object.keys(acc).forEach(function (kk) {
      var a = acc[kk];
      if (!a.n) return;
      REG[kk] = { c: [a.x / a.n, a.y / a.n, a.z / a.n], r: 10, color: REGION[kk].color };
    });
    var dist = {};
    Object.keys(REG).forEach(function (kk) { dist[kk] = []; });
    for (i = 0; i < N; i++) {
      n = DATA.nodes[i];
      k = REGION[n.t] ? n.t : 'fact';
      if (!REG[k]) continue;
      dist[k].push(Math.hypot(n.p[0] - REG[k].c[0], n.p[1] - REG[k].c[1], n.p[2] - REG[k].c[2]));
    }
    var ext = 1;
    Object.keys(REG).forEach(function (kk) {
      var arr = dist[kk].sort(function (a, b) { return a - b; });
      if (arr.length) REG[kk].r = Math.max(8, arr[Math.floor(arr.length * 0.82)] * 1.1);
      halo[kk] = makeHalo(REG[kk].color);
      ext = Math.max(ext, Math.hypot(REG[kk].c[0], REG[kk].c[2]) + REG[kk].r);
    });
    REG_EXT = ext;
    initPulses();
    initViz();
    buildBeads();
  }

  function drawHalos(cx, cy) {
    var dim = 1 - 0.62 * focusMix;
    var maxA = MOBILE ? 0.48 : 0.55;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k in REG) {
      var r = REG[k], p = project(r.c[0], r.c[1], r.c[2]);
      var sc = focal / Math.max(420 + p[2], 60);
      var rad = r.r * sc * Math.pow(exFor(k) / 1.17, 0.65) * (quality ? 1.60 : 1.42);
      if (rad < 12) continue;
      var near = 1 - Math.min(Math.abs(p[2]) / 560, 0.76);
      var a = maxA * near * dim * (1 + 0.065 * Math.sin(T * 0.38 + r.c[0] * 0.55));
      if (a <= 0.02) continue;
      var X = cx + p[0] * sc, Y = cy + p[1] * sc;
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(Math.sin(T * 0.05 + r.c[0]) * 0.30);
      ctx.globalAlpha = a;
      ctx.drawImage(fogSoft[k] || halo[k], -rad, -rad, rad * 2, rad * 2);
      if (quality) {                       // 反向偏一层，团块不会死成一张贴图
        var r2 = rad * 0.70;
        ctx.globalAlpha = a * 0.52;
        ctx.drawImage(fogSoft[k] || halo[k], -r2 + rad * 0.14, -r2 - rad * 0.10, r2 * 2, r2 * 2);
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawRegionLabels(cx, cy) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var lfade = 1 - 0.9 * focusMix;
    if (lfade <= 0.05) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      return;
    }
    var used = [], fs = MOBILE ? 9.5 : 11;
    var fam = '-apple-system,"PingFang SC",system-ui,sans-serif';
    for (var k in REG) {
      var r = REG[k], p = project(r.c[0], r.c[1], r.c[2]);
      var sc = focal / Math.max(420 + p[2], 60);
      var X = cx + p[0] * sc, Y = cy + p[1] * sc;
      if (X < -70 || X > W + 70 || Y < -30 || Y > H + 30) continue;
      var name = REGION[k].cn;
      if (MOBILE) name = name.split('·')[0].replace(/\s/g, '');
      var boxW = name.length * fs + 28;
      var bx = X - boxW * 0.5, by = Y - fs;
      for (var g = 0; g < 6; g++) {
        var hit = false;
        for (var u = 0; u < used.length; u++) {
          var U = used[u];
          if (Math.abs(U.x - bx) < (U.w + boxW) * 0.5 && Math.abs(U.y - by) < fs * 1.8) { hit = true; break; }
        }
        if (!hit) break;
        by += fs * 1.9;
      }
      used.push({ x: bx, y: by, w: boxW });
      var a = (0.54 + 0.42 * (1 - Math.min(Math.abs(p[2]) / 460, 0.86))) * lfade;
      ctx.globalAlpha = a * 0.85;
      ctx.strokeStyle = hexA(r.color, 0.62);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by + 2, 5, 5);
      ctx.beginPath();
      ctx.moveTo(bx + 6, by + 4.5);
      ctx.lineTo(bx + 12, by + 4.5);
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.fillStyle = hexA(r.color, 0.95);
      ctx.font = (MOBILE ? '500 9.5px ' : '500 11px ') + fam;
      ctx.fillText(name, bx + 15, by + 4.8);
      if (!MOBILE) {
        ctx.globalAlpha = a * 0.45;
        ctx.fillStyle = '#a9c4ef';
        ctx.font = '8px ' + fam;
        ctx.fillText(REGION[k].en, bx + 15, by + 15);
      }
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  }

  /* 神经脉冲：挑一批连线，让光点沿线跑，脑区之间像在传信号 */
  var pulses = [];
  function initPulses() {
    pulses = [];
    var L = (DATA.links && DATA.links.length) || 0;
    if (!L) return;
    var want = Math.min(48, Math.max(10, Math.floor(L / 70)));
    for (var i = 0; i < want; i++) {
      var h = hashN(i * 92821 + 7);
      pulses.push({ l: h % L, ph: (h % 1000) / 1000, sp: 0.09 + ((h >>> 9) % 100) / 700 });
    }
  }

  function drawPulses() {
    if (!pulses.length || !breath) return;
    var pfade = 1 - 0.82 * focusMix;
    for (var i = 0; i < pulses.length; i++) {
      var q = pulses[i], lk = DATA.links[q.l];
      if (!lk) continue;
      var a = lk[0], b = lk[1];
      var na = DATA.nodes[a], nb = DATA.nodes[b];
      if (!na || !nb || hidden[na.t] || hidden[nb.t]) continue;
      var t = (T * q.sp + q.ph) % 1;
      var x = px[a] + (px[b] - px[a]) * t;
      var y = py[a] + (py[b] - py[a]) * t;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      var sz = 4.5 + 3.5 * pscale[a];
      ctx.globalAlpha = (0.14 + 0.86 * Math.sin(Math.PI * t)) * pfade;
      ctx.drawImage(sprite.fact, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- 面板数据：全部从 starmap.json 现算，不编数 ---------- */

  function metrics() {
    var c = counts(), per = {}, maxDay = '';
    DATA.nodes.forEach(function (n) {
      if (!n.day) return;
      per[n.day] = (per[n.day] || 0) + 1;
      if (n.day > maxDay) maxDay = n.day;
    });
    var days = Object.keys(per).sort();
    var todayN = per[maxDay] || 0;
    var maxN = 1, sum = 0;
    days.forEach(function (d) { if (per[d] > maxN) maxN = per[d]; sum += per[d]; });
    var avgN = days.length ? Math.round(sum / days.length) : 0;
    var density = N ? DATA.links.length / N : 0;
    var recent = 0;
    days.slice(-3).forEach(function (d) { recent += per[d]; });
    var fresh = N ? recent / N : 0;
    var types = Object.keys(c).length;
    var score = Math.round(100 * (0.34 * Math.min(1, days.length / 30) +
                                  0.34 * Math.min(1, density / 2.6) +
                                  0.16 * Math.min(1, types / 5) +
                                  0.16 * Math.min(1, fresh / 0.5)));
    return { c: c, per: per, days: days, today: maxDay, todayN: todayN, maxN: maxN,
             avgN: avgN, density: density, fresh: fresh, types: types,
             score: Math.max(1, Math.min(99, score)) };
  }

  function buildMix() {
    var m = metrics(), bar = document.getElementById('mixbar');
    if (!bar) return;
    bar.innerHTML = '';
    Object.keys(KIND).forEach(function (k) {
      var v = m.c[k] || 0;
      if (!v) return;
      var seg = document.createElement('i');
      seg.dataset.k = k;
      seg.style.background = KIND[k].color;
      seg.style.width = (v / N * 100).toFixed(2) + '%';
      seg.title = KIND[k].name + ' ' + v;
      bar.appendChild(seg);
    });
  }

  function buildPersona() {
    var m = metrics(), total = N || 1;
    var sv = document.getElementById('scorev');
    if (sv) sv.textContent = m.score;
    drawRing(m.score);

    var rows = [
      { k: '检索力', v: (m.c.fact || 0) / total, color: '#7fc8ff' },
      { k: '表达力', v: (m.c.msg || 0) / total, color: '#7f93bd' },
      { k: '分辨力', v: (m.c.lesson || 0) / Math.max(1, (m.c.fact || 0) + (m.c.lesson || 0)), color: '#ffb86b' }
    ];
    var box = document.getElementById('pbars');
    if (box) {
      box.innerHTML = rows.map(function (r) {
        var w = Math.round(Math.min(1, r.v) * 100);
        return '<div class="pb"><div class="t"><span>' + r.k + '</span><b>' +
          r.v.toFixed(2) + '</b></div><div class="track"><i style="width:' + w +
          '%;background:' + r.color + ';color:' + r.color + '"></i></div></div>';
      }).join('');
    }

    var pct = Math.round(m.todayN / Math.max(1, m.maxN) * 100);
    var ev = document.getElementById('energyv');
    if (ev) ev.textContent = pct + '%';
    var ef = document.getElementById('efill');
    if (ef) ef.style.width = Math.max(2, pct) + '%';
    var ec = document.getElementById('ecap');
    if (ec) {
      ec.textContent = '今日 ' + m.todayN + ' 条 · 日均 ' + m.avgN + ' 条 · ' +
        (m.todayN >= m.avgN ? '高于' : '低于') + '日均';
    }
    drawRadar(m);
  }

  function drawRing(score) {
    var c = document.getElementById('ring');
    if (!c) return;
    var g = c.getContext('2d'), S = c.width, cx = S / 2, cy = S / 2;
    g.clearRect(0, 0, S, S);
    var r = S / 2 - 16;
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(127,200,255,.11)';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    for (var i = 0; i < 44; i++) {
      var a = i / 44 * Math.PI * 2 - Math.PI / 2;
      var on = (i / 44 * 100) < score;
      g.strokeStyle = on ? 'rgba(150,205,255,.62)' : 'rgba(127,200,255,.13)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
      g.lineTo(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5));
      g.stroke();
    }
    var grd = g.createLinearGradient(0, 0, S, S);
    grd.addColorStop(0, '#7fc8ff');
    grd.addColorStop(1, '#c9e9ff');
    g.strokeStyle = grd;
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (score / 100));
    g.stroke();
  }

  function drawRadar(m) {
    var c = document.getElementById('radar');
    if (!c) return;
    var g = c.getContext('2d'), S = c.width, Hc = c.height;
    g.clearRect(0, 0, S, Hc);
    var dims = [
      { k: '事实', v: m.c.fact || 0, color: '#7fc8ff' },
      { k: '原话', v: m.c.msg || 0, color: '#7f93bd' },
      { k: '知识', v: m.c.doc || 0, color: '#9fe6c8' },
      { k: '教训', v: m.c.lesson || 0, color: '#ffb86b' },
      { k: '偏好', v: m.c.preference || 0, color: '#ff8fc7' }
    ];
    var mx = 1;
    dims.forEach(function (d) { if (d.v > mx) mx = d.v; });
    // 占比开平方再画，别让原话一家把雷达压成一根针
    dims.forEach(function (d) { d.r = Math.sqrt(d.v / mx); });
    var cx = S / 2, cy = Hc / 2 + 4, R = Math.min(S, Hc) * 0.34;
    g.strokeStyle = 'rgba(127,200,255,.13)';
    g.lineWidth = 1;
    for (var ring = 1; ring <= 3; ring++) {
      g.beginPath();
      for (var i = 0; i <= 5; i++) {
        var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
        var x = cx + Math.cos(a) * R * ring / 3, y = cy + Math.sin(a) * R * ring / 3;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    }
    dims.forEach(function (d, i) {
      var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
    });
    g.beginPath();
    dims.forEach(function (d, i) {
      var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      var rr = R * (0.18 + 0.82 * d.r);
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
    g.fillStyle = 'rgba(127,200,255,.15)';
    g.fill();
    g.strokeStyle = 'rgba(160,215,255,.8)';
    g.lineWidth = 2;
    g.stroke();
    g.font = '20px -apple-system,"PingFang SC",system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    dims.forEach(function (d, i) {
      var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      var rr = R * (0.18 + 0.82 * d.r);
      g.fillStyle = d.color;
      g.beginPath();
      g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3.4, 0, 6.2832);
      g.fill();
      g.fillStyle = 'rgba(185,203,230,.88)';
      g.fillText(d.k, cx + Math.cos(a) * (R + 26), cy + Math.sin(a) * (R + 18));
    });
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  var streamIdx = [];
  function buildStream() {
    var box = document.getElementById('stream');
    if (!box) return;
    var arr = DATA.nodes.slice().sort(function (a, b) {
      var da = a.day || '', db = b.day || '';
      if (da !== db) return da < db ? 1 : -1;
      return b.i - a.i;
    }).slice(0, 8);
    streamIdx = arr.map(function (n) { return n.i; });
    box.innerHTML = arr.map(function (n, j) {
      var meta = KIND[n.t] || { name: n.t, color: '#8899bb' };
      var tx = String(n.text || '').replace(/\s+/g, ' ').slice(0, 22);
      return '<div class="srow" data-j="' + j + '">' +
        '<span class="tm">' + (n.day || '').slice(5) + '</span>' +
        '<span class="chip" style="color:' + meta.color + '">' + meta.name + '</span>' +
        '<span class="tx">' + esc(tx) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.srow'), function (el) {
      el.addEventListener('click', function () {
        var j = +el.dataset.j;
        if (streamIdx[j] != null) focusNode(streamIdx[j], true);
      });
    });
  }

  function buildRetrieval() {
    var R = (DATA && DATA.stats && DATA.stats.retrieval) || {};
    var vec = R.vec || {}, ev = R.eval || {};
    var cold = (vec.cold || {}).docs, dream = (vec.dream || {}).docs;
    var chunks = ((vec.cold || {}).chunks || 0) + ((vec.dream || {}).chunks || 0);
    function nf(v) { return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function put(id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = (v == null || v === '') ? '—' : v;
    }
    put('retrCold', cold == null ? null : nf(cold));
    put('retrDream', dream == null ? null : nf(dream));
    put('retrChunk', chunks ? nf(chunks) : null);
    put('retrAt', ev.at ? ev.at : '未跑分');

    var rows = [
      { k: '语义召回 R@5', v: ev.r5, c: '#7fc8ff', pill: false },
      { k: '关键词命中', v: ev.kw, c: '#9fe6c8', pill: false },
      { k: '自然问句', v: ev.nl, c: '#ffb86b', pill: false },
      { k: '误命中率', v: ev.neg, c: '#ff8fc7', pill: true }
    ];
    var box = document.getElementById('retrRows');
    if (!box) return;
    box.innerHTML = rows.map(function (r) {
      var pct = (typeof r.v === 'number') ? Math.round(r.v * 100) : null;
      var txt = pct == null ? '—' : (pct + '%');
      var w = pct == null ? 0 : pct;
      return '<div class="rr" style="color:' + r.c + '">' +
        '<div class="t"><span style="color:#b9cbe6">' + r.k + '</span><b>' + txt + '</b></div>' +
        '<div class="track"><i style="width:' + w + '%"></i></div></div>';
    }).join('');
  }

  function buildActivity() {
    var box = document.getElementById('activity');
    if (!box || !DATA.days) return;
    var max = 1;
    DATA.days.forEach(function (d) { if (d.n > max) max = d.n; });
    box.innerHTML = '';
    DATA.days.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'ab';
      el.title = d.day + ' · ' + d.n + ' 条记忆';
      el.innerHTML = '<i style="height:' + Math.max(3, Math.round(d.n / max * 100)) + '%"></i>' +
        '<span>' + d.day.slice(5) + '</span>';
      el.addEventListener('click', function () { focusDay(d.day); });
      box.appendChild(el);
    });
  }

  function startClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    function tick() {
      var d = new Date();
      function p(v) { return (v < 10 ? '0' : '') + v; }
      el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- 皮层导航（俯视 XZ 平面小图） ---------- */
  var mm = document.getElementById('minimap');
  var mmx = mm && mm.getContext('2d');

  function drawMinimap() {
    if (!mm || !mmx || !DATA) return;
    var w = mm.clientWidth, h = mm.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (mm.width !== Math.round(w * dpr) || mm.height !== Math.round(h * dpr)) {
      mm.width = Math.round(w * dpr);
      mm.height = Math.round(h * dpr);
    }
    var g = mmx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2, sc = Math.min(w, h) / (REG_EXT * 2.3);
    Object.keys(REG).forEach(function (k) {
      var r = REG[k];
      g.strokeStyle = hexA(r.color, 0.26);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx + r.c[0] * sc, cy + r.c[2] * sc, Math.max(3, r.r * sc * 0.85), 0, 6.2832);
      g.stroke();
    });
    for (var i = 0; i < N; i++) {
      var n = DATA.nodes[i];
      if (hidden[n.t]) continue;
      var x = cx + n.p[0] * sc, y = cy + n.p[2] * sc;
      var hot = (i === hoverIdx || i === cardIdx);
      g.globalAlpha = hot ? 1 : 0.6;
      g.fillStyle = hot ? '#ffffff' : (KIND[n.t] ? KIND[n.t].color : '#8899bb');
      g.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(127,200,255,.28)';
    g.beginPath();
    g.moveTo(cx, cy - 5); g.lineTo(cx, cy + 5);
    g.moveTo(cx - 5, cy); g.lineTo(cx + 5, cy);
    g.stroke();
  }
  setInterval(function () { drawMinimap(); }, 900);

  /* ---------- 走起 ---------- */
  loadDataByScript(function () { loadData(0); });
  /* 只读调试口：给外部/自检看当前镜头状态，不改任何东西 */
  window.__STARMAP_VIEW__ = function () {
    return {
      rot: rot.map(function (v) { return Math.round(v * 1e6) / 1e6; }),
      zoom: Math.round(zoom * 1000) / 1000,
      targetZoom: Math.round(targetZoom * 1000) / 1000,
      offX: Math.round(targetOffX), offY: Math.round(targetOffY),
      spin: !!spin
    };
  };
})();

/* 2026-11-07 底层素材视频：打开页面自动播一遍，播完压暗定格当背景
   —— 没声音、不循环；被浏览器拦自动播放时，等第一次点/按再补播 */
(function () {
  var box = document.getElementById('bgv');
  var v = document.getElementById('bgvid');
  if (!box || !v) return;
  var done = false;

  function start() {
    try { v.currentTime = 0; } catch (e) {}
    var p = v.play();
    if (p && p.catch) p.catch(function () {
      var kick = function () {
        document.removeEventListener('pointerdown', kick);
        document.removeEventListener('keydown', kick);
        v.play()['catch'](function () {});
      };
      document.addEventListener('pointerdown', kick, { once: true });
      document.addEventListener('keydown', kick, { once: true });
    });
  }

  function show() { box.classList.add('on'); }

  v.addEventListener('loadeddata', show);
  v.addEventListener('playing', show);
  v.addEventListener('timeupdate', function () {
    // 收尾前 0.9 秒先降一档，免得亮帧闪一下再掉
    if (!done && v.duration && v.duration - v.currentTime < 0.9) {
      done = true; box.classList.add('dim');
    }
  });
  v.addEventListener('ended', function () { box.classList.add('dim'); });

  if (v.readyState >= 2) show();
  start();
})();

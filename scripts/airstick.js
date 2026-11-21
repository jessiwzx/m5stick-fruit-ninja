/*!
 * airstick.js — 让原版 Fruit Ninja 支持 M5StickS3（AirStick 蓝牙鼠标）的体感操作
 *
 * v2：精度加固
 * ------------
 * v1 直接用 movementX 累积坐标，实测手感"挥快了就切不准"。查 AirMouseS3 固件
 * 源码后定位到两个物理层面的误差，v2 全部在页面侧补偿：
 *
 * 1) 固件 kMaxStep = 40px：每次采样最多发 40px，超出部分直接丢弃、不补发。
 *    横向 16px/度 → 40px 只等于 2.5°/采样，按 IMU 约 100Hz 算，
 *    **角速度超过 250°/s 就开始丢角度**。挥砍通常 400~600°/s，
 *    等于一半以上的转动被固件吃掉。表现就是"慢慢转很准，一挥就少一半"。
 *    → 对策：软膝饱和补偿（satKnee 以上渐进放大，40px 时还原到约 2 倍）
 *
 * 2) gyroBias 开机为 0、kGyroDeadzoneDps = 0：不按侧边 B 键就从不标定零偏。
 *    BMI270 未校准零偏 1~5°/s = 16~80px/s 的持续单向漂移。
 *    → 对策：只在真静止（±1px）时学习零偏，用整数累加器长期精确扣除
 *
 * 另外三个手感改进：
 * - 事件级推点：v1 每帧只推一个点（60Hz），挥砍时中间轨迹被压平成折线；
 *   现在每个 mousemove 事件都推一个点（约 130Hz），弧线才是弧线
 * - 边缘软化：刀靠近画布边缘时增益衰减，避免"撞边后手转刀不动"的空转感
 * - 线段外推：判定用的线段末端延长 15%，补足快速挥砍时被截短的轨迹
 *
 * 三个数怎么调
 * ------------
 * - sens（默认 1.2）：转 32° 横穿 640 画布。1:1 是 1.0，越大越省力越不精准
 * - axisFixY（默认 16/9.5）：固件横向 16px/度、纵向只有 9.5px/度，必须补偿
 * - satBoost（默认 2.0）：饱和时的还原倍数，越大越"补得快"，调小更保守
 *
 * 快捷键：空格 回中 · [ ] 灵敏度 · , . 纵向补偿 · F1 调试面板
 */
(function () {
  'use strict';

  var CW = 640, CH = 480;      // 游戏内部坐标系，缩放不影响它
  var TOP_OFFSET = 40;         // 与 control.js 的 canvasTop 计算保持一致

  var CFG = {
    sens: 1.2,                 // 灵敏度倍率（1.0 = 转 40° 横穿画布）
    axisFixY: 16 / 9.5,        // 纵向增益补偿，固件两轴不等
    deadzone: 0.45,            // 像素死区，吃掉亚像素抖动
    satKnee: 34,               // 超过这个位移开始按饱和处理
    satBoost: 1.6,             // 饱和还原倍数（a>=40 时生效）
    hitPad: 0,                 // 判定半径额外容差（px），0 = 完全保持原版
    feedInterval: 4,           // 推点最小间隔（毫秒），防高频鼠标刷爆刀光对象
    extrapolate: 0.15,         // 判定线段末端外推比例
    driftLearn: 0.004,         // 零偏学习率，越大跟得越快也越容易被误学
    edgeSoften: 0.16,          // 边缘软化区宽度（占画布比例）
    edgeFloor: 0.6,            // 贴边时的最低增益
    recenterAfter: 900,        // 静止多久后开始回中（毫秒）
    recenterTau: 2.5,          // 回中时间常数，越大越慢
    maxScale: 2.6,             // 画面放大上限
    debug: false
  };

  var left = 0, top = 0, cx = 0, cy = 0;
  var vx = 0, vy = 0;

  var driftX = 0, driftY = 0;              // 每次事件的平均漂移（px）
  var driftAccX = 0, driftAccY = 0;        // 整数扣除累加器
  var driftN = 0;                          // 已学到的静止样本数

  var lastMoveAt = 0, lastT = 0, lastFeedAt = 0;
  var evCount = 0, evWindowStart = 0, evRate = 0;
  var satCount = 0, satRate = 0;
  var recentering = false;

  var active = false, ready = false, scaled = false, everLocked = false;
  var knife = null, message = null;
  var overlay = null;

  /* ---------------- 画布几何 ---------------- */

  function measure() {
    var de = document.documentElement;
    left = (de.clientWidth - CW) / 2;
    top = (de.clientHeight - CH) / 2 - TOP_OFFSET;
    cx = left + CW / 2;
    cy = top + CH / 2;
  }

  /* ---------------- 等比放大画面 ---------------- */

  function applyScale() {
    if (!document.getElementById('extra')) return false;

    var k = Math.min(window.innerWidth / CW, window.innerHeight / CH);
    k = Math.max(0.6, Math.min(k, CFG.maxScale));

    // 两个图层各自绝对定位在屏幕中心，以自身中心缩放即可对齐
    ['extra', 'view'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.style.transformOrigin = 'center center';
        el.style.transform = 'scale(' + k.toFixed(4) + ')';
      }
    });

    document.body.style.background = '#0a0d12';

    var desc = document.getElementById('desc');
    if (desc) desc.style.display = 'none';

    return true;
  }

  /* ---------------- 坐标 ---------------- */

  function clampV() {
    if (vx < left) vx = left;
    else if (vx > left + CW) vx = left + CW;
    if (vy < top) vy = top;
    else if (vy > top + CH) vy = top + CH;
  }

  function pushV() {
    window.__airV[0] = vx;
    window.__airV[1] = vy;
  }

  // 靠近画布边缘时增益衰减：避免"手还在转、刀已经顶到墙"的空转感。
  // 代价是边缘区略钝，但比撞边后彻底失灵好得多。
  function edgeGain(pos, min, size) {
    var d = Math.min(pos - min, min + size - pos);
    var w = size * CFG.edgeSoften;
    if (d >= w) return 1;
    var t = Math.max(0, d) / w;
    return CFG.edgeFloor + (1 - CFG.edgeFloor) * t;
  }

  // 软膝饱和补偿。固件单次最多 40px，超过就是被截断，
  // 按统计规律还原：34px 以下完全线性（不碰），34→40 渐进放大到 2 倍。
  // 端到端效果：400°/s 的挥砍（真实 64px/帧）还原到 64px，基本补平。
  function boost(d) {
    var a = Math.abs(d);
    if (a <= CFG.satKnee) return d;
    var t = Math.min(1, (a - CFG.satKnee) / (40 - CFG.satKnee));
    return d * (1 + t * (CFG.satBoost - 1));
  }

  /* ---------------- 喂刀 ---------------- */

  // 每推一个点，原版就生成一段刀光 + 一次判定。
  // 从 60Hz（每帧一点）改成事件级（约 130Hz），挥砍轨迹不再被压平。
  function feedKnife() {
    var kf = knife.through(vx - left, vy - top);
    if (!kf || recentering) return;

    var x1 = kf[0], y1 = kf[1], x2 = kf[2], y2 = kf[3];

    // 末端外推：快速挥砍时线段偏短，延长一点补足轨迹。
    // 只影响判定，不影响刀光，所以不会出现"刀没碰到却切开了"的视觉矛盾。
    if (CFG.extrapolate > 0) {
      x2 += (x2 - x1) * CFG.extrapolate;
      y2 += (y2 - y1) * CFG.extrapolate;
    }

    message.postMessage([x1, y1, x2, y2], 'slice');
  }

  function onMove(e) {
    if (!active || !ready) return;

    var dx = e.movementX || 0;
    var dy = e.movementY || 0;
    if (!dx && !dy) return;

    var now = performance.now();

    // 1) 零偏学习：只在真正静止（0 或 ±1px）时学。
    //    快速挥砍位移大，不参与，不会被污染；慢速精细移动通常 >=2px，也不会被学走。
    //    前段用累积平均（1/n）快速收敛——固定学习率太慢，开头几秒的漂移会白吃，
    //    收敛后切成固定小学习率，才能跟上温度变化引起的零偏慢漂移。
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      driftN++;
      var lr = Math.max(CFG.driftLearn, 1 / driftN);
      driftX += (dx - driftX) * lr;
      driftY += (dy - driftY) * lr;
    }

    // 2) 扣除零偏：用整数累加器，长期平均精确，小数不丢
    driftAccX += driftX;
    driftAccY += driftY;
    var cutX = Math.round(driftAccX);
    var cutY = Math.round(driftAccY);
    driftAccX -= cutX;
    driftAccY -= cutY;

    var ax = dx - cutX;
    var ay = dy - cutY;

    // 3) 死区
    if (Math.abs(ax) < CFG.deadzone) ax = 0;
    if (Math.abs(ay) < CFG.deadzone) ay = 0;
    if (!ax && !ay) return;

    // 4) 饱和补偿
    var sat = Math.abs(ax) >= CFG.satKnee || Math.abs(ay) >= CFG.satKnee;
    ax = boost(ax);
    ay = boost(ay);

    // 5) 增益 + 边缘软化 + 纵向补偿
    vx += ax * CFG.sens * edgeGain(vx, left, CW);
    vy += ay * CFG.axisFixY * CFG.sens * edgeGain(vy, top, CH);
    clampV();
    pushV();

    // 6) 事件级推点。带 4ms 节流：AirStick 报告率约 133Hz 完全不触发，
    //    但换成 1000Hz 的游戏鼠标时不会刷出 200 个刀光对象把帧率拖垮。
    recentering = false;
    if (now - lastFeedAt >= CFG.feedInterval) {
      feedKnife();
      lastFeedAt = now;
    }

    lastMoveAt = now;
    evCount++;
    if (sat) satCount++;
  }

  /* ---------------- 每帧：只负责回中 ---------------- */

  function tick(t) {
    requestAnimationFrame(tick);

    if (!scaled) scaled = applyScale();

    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016;
    lastT = t;
    var now = performance.now();

    recentering = active && ready && (now - lastMoveAt > CFG.recenterAfter);

    if (recentering) {
      var ox = cx - vx, oy = cy - vy;
      if (Math.abs(ox) > 0.5 || Math.abs(oy) > 0.5) {
        var k = 1 - Math.exp(-dt / CFG.recenterTau);
        vx += ox * k;
        vy += oy * k;
        pushV();
        // 推进刀的位置但不判定：回中不应该切开任何东西
        knife.through(vx - left, vy - top);
      }
    }

    paintDebug(now);
  }

  /* ---------------- pointer lock ---------------- */

  function requestLock() {
    var el = document.documentElement;
    try {
      var p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') {
        p.catch(function () {
          try { el.requestPointerLock(); } catch (e1) { /* 退化到普通模式 */ }
        });
      }
    } catch (e) {
      try { el.requestPointerLock(); } catch (e2) { /* 退化到普通模式 */ }
    }
  }

  document.addEventListener('pointerlockchange', function () {
    var locked = document.pointerLockElement != null;
    if (locked) {
      everLocked = true;
      window.__airWasLocked = true;
      hideOverlay();
    } else if (active && everLocked && !window.__mzPicking) {
      // __mzPicking 为真表示是选模式面板主动解的锁，不该弹暂停
      showOverlay('已暂停', '鼠标锁被浏览器解除了。点下面继续。', '继续');
    }
  });

  // 锁定失败不能挡住画面——照样能玩，只是光标撞边时会失去响应。
  // 所以这里用顶部小提示，不弹全屏面板。
  document.addEventListener('pointerlockerror', function () {
    if (!active) return;
    toast('未能锁定鼠标：光标碰到屏幕边缘时刀会失去响应');
  });

  function toast(msg) {
    var el = document.getElementById('air-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'air-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; }, 3200);
  }

  /* ---------------- 调试面板 ---------------- */

  var dbgEl = null, dbgPaintAt = 0;

  function paintDebug(now) {
    if (!CFG.debug || !active) {
      if (dbgEl) dbgEl.style.display = 'none';
      return;
    }

    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.id = 'air-debug';
      document.body.appendChild(dbgEl);
    }
    dbgEl.style.display = 'block';
    if (now - dbgPaintAt < 180) return;
    dbgPaintAt = now;

    if (now - evWindowStart >= 500) {
      evRate = evCount * 1000 / Math.max(1, now - evWindowStart);
      satRate = satCount * 1000 / Math.max(1, now - evWindowStart);
      evCount = 0; satCount = 0; evWindowStart = now;
    }

    dbgEl.textContent =
      '事件  ' + evRate.toFixed(0) + ' /s   饱和  ' + satRate.toFixed(0) + ' /s\n' +
      '灵敏度 ' + CFG.sens.toFixed(2) + '   纵向 ' + CFG.axisFixY.toFixed(2) + '\n' +
      '漂移  ' + (driftX * evRate).toFixed(1) + ',' + (driftY * evRate).toFixed(1) + ' px/s\n' +
      '坐标  ' + (vx - left).toFixed(0) + ',' + (vy - top).toFixed(0) +
      (recentering ? '   回中' : '');
  }

  /* ---------------- 界面 ---------------- */

  var CSS = [
    '#air-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;',
    'justify-content:center;background:radial-gradient(circle at 50% 45%,rgba(14,20,30,.86),rgba(2,4,7,.97));',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8eef7}',
    '#air-overlay .card{width:min(540px,90vw);padding:32px 34px 28px;text-align:center;',
    'background:linear-gradient(180deg,rgba(28,36,50,.96),rgba(16,21,30,.96));',
    'border:1px solid rgba(120,190,255,.18);border-radius:18px;',
    'box-shadow:0 24px 60px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05)}',
    '#air-overlay h1{font-size:26px;letter-spacing:2px;margin:0 0 8px;',
    'background:linear-gradient(90deg,#7fe3a8,#6ec8ff);-webkit-background-clip:text;',
    'background-clip:text;color:transparent}',
    '#air-overlay p{font-size:13px;line-height:1.9;color:#a9b6c8;margin:0 0 10px}',
    '#air-overlay p b{color:#d9e6f5}',
    '#air-overlay .keys{font-size:11.5px;color:#74839a;margin:14px 0 20px;letter-spacing:.5px}',
    '#air-overlay .tip{font-size:11.5px;color:#7f8fa6;line-height:1.8;margin:0 0 18px;',
    'padding:10px 12px;border-radius:9px;background:rgba(110,200,255,.06);',
    'border:1px solid rgba(110,200,255,.12);text-align:left}',
    '#air-overlay button{padding:13px 44px;font-size:15px;font-weight:700;letter-spacing:1px;',
    'color:#06121a;cursor:pointer;border:none;border-radius:11px;',
    'background:linear-gradient(135deg,#8ff0b6,#62c8f0);',
    'box-shadow:0 8px 26px rgba(98,200,240,.28)}',
    '#air-overlay button:active{transform:translateY(1px)}',
    '#air-toast{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:10000;',
    'font:12.5px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#cfe3f7;',
    'background:rgba(12,18,26,.92);border:1px solid rgba(120,190,255,.24);',
    'padding:8px 16px;border-radius:8px;pointer-events:none;opacity:0;transition:opacity .25s}',
    '#air-debug{position:fixed;right:12px;bottom:12px;z-index:10001;display:none;white-space:pre;',
    'font:11.5px/1.75 Consolas,Menlo,monospace;color:#8ff0b6;background:rgba(6,10,16,.84);',
    'border:1px solid rgba(120,190,255,.2);padding:8px 12px;border-radius:8px;pointer-events:none}'
  ].join('');

  function injectCss() {
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function showOverlay(title, body, btn) {
    if (!overlay) return;
    overlay.querySelector('h1').textContent = title;
    overlay.querySelector('.body').innerHTML = body;
    overlay.querySelector('#air-start').textContent = btn;
    overlay.style.display = 'flex';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function buildUI() {
    injectCss();
    overlay = document.createElement('div');
    overlay.id = 'air-overlay';
    overlay.innerHTML =
      '<div class="card">' +
        '<h1>体感切西瓜</h1>' +
        '<p class="body">拿好 StickS3，屏幕朝上，像端托盘一样。<br>' +
          '点下面的按钮锁定鼠标，之后<b>转动设备</b>，刀就跟着走，挥过水果即可切开。<br>' +
          '<b>不用按键</b>，也没有光标。</p>' +
        '<div class="tip">刀会自己往一边漂的话，按住<b>机身侧边 B 键</b>约 1 秒并保持不动再松开，' +
          '固件会重新标定陀螺仪零偏，漂移能降一个量级。</div>' +
        '<p class="keys">空格 回中 · [ ] 灵敏度 · , . 纵向 · F1 调试</p>' +
        '<button id="air-start">开始体感</button>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#air-start').addEventListener('click', function () {
      activate();
      requestLock();
      hideOverlay();
    });
  }

  /* ---------------- 启动 ---------------- */

  function activate() {
    if (!window.__airV) {
      window.__airV = [vx, vy];
    } else {
      pushV();
    }
    active = true;
    lastMoveAt = performance.now();
    evWindowStart = lastMoveAt;
    lastFeedAt = 0;
    driftX = driftY = 0;
    driftAccX = driftAccY = 0;
    driftN = 0;
    evCount = 0; satCount = 0;
  }

  function boot() {
    try {
      knife = require('scripts/object/knife.js');
      message = require('scripts/message.js');
      measure();
      vx = cx;
      vy = cy;
      ready = true;
      buildUI();
      requestAnimationFrame(tick);
    } catch (e) {
      setTimeout(boot, 200);
    }
  }

  /* ---------------- 键盘 ---------------- */

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      e.preventDefault();
      if (active) {
        vx = cx; vy = cy; pushV();
        // 位置跳变后重置刀的内部起点，避免生成一条横穿全屏的假刀痕
        if (knife && knife.newKnife) knife.newKnife();
      }
    } else if (e.key === ']' || e.key === '[') {
      var step = e.key === ']' ? 0.1 : -0.1;
      CFG.sens = Math.max(0.4, Math.min(3.0, CFG.sens + step));
      toast('灵敏度 ' + CFG.sens.toFixed(2));
    } else if (e.key === '.' || e.key === ',') {
      var step2 = e.key === '.' ? 0.06 : -0.06;
      CFG.axisFixY = Math.max(0.8, Math.min(2.4, CFG.axisFixY + step2));
      toast('纵向补偿 ' + CFG.axisFixY.toFixed(2));
    } else if (e.code === 'F1') {
      e.preventDefault();
      CFG.debug = !CFG.debug;
      toast(CFG.debug ? '调试面板 开' : '调试面板 关');
    }
  });

  window.addEventListener('resize', function () {
    var wasNear = Math.abs(vx - cx) < 4 && Math.abs(vy - cy) < 4;
    measure();
    if (wasNear) { vx = cx; vy = cy; if (window.__airV) pushV(); }
    applyScale();
  });

  document.addEventListener('mousemove', onMove);

  boot();
})();

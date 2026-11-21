/*!
 * modes.js — 三种玩法 + 连击 HUD + 特殊香蕉提示
 *
 * 原版复刻只有一种玩法：3 条命、切到炸弹就结束、分数每次 +1。
 * 这个文件在它之上补三样东西，全部走 HTML 覆盖层，不碰原版 SVG 布局：
 *
 *   1) 三种模式（写进 window.__mode，由 all.js 的 getType/game.js 读取）
 *   2) 连击 / 暴击 / 一刀多切的实时提示（监听 score.gain 消息）
 *   3) 倒计时与结算（限时模式时间到就调 game.gameOver）
 *
 * 依赖：all.js 里的 require 是全局的，所以能直接拿到 sence / game / state / message。
 */
(function () {
  'use strict';

  /* ======================= 模式表 ======================= */

  var MODES = {
    classic: {
      id: 'classic',
      name: '经典',
      en: 'CLASSIC',
      rule: '3 条命，切到炸弹即结束',
      tag: '无尽',
      duration: 0,
      bombs: true,
      bombRate: 8,
      specials: false,
      specialRate: 0,
      spawnMs: 1000,
      color: '#7fe3a8'
    },
    zen: {
      id: 'zen',
      name: '禅',
      en: 'ZEN',
      rule: '90 秒，没有炸弹，专心切',
      tag: '90 秒',
      duration: 90000,
      bombs: false,
      bombRate: 8,
      specials: true,
      specialRate: 0.06,
      spawnMs: 820,
      color: '#8fd0ff'
    },
    arcade: {
      id: 'arcade',
      name: '街机',
      en: 'ARCADE',
      rule: '60 秒，炸弹扣 10 分但不会结束',
      tag: '60 秒',
      duration: 60000,
      bombs: true,
      bombRate: 5,
      specials: true,
      specialRate: 0.12,
      spawnMs: 700,
      color: '#ffb766'
    }
  };

  var current = null;      // 当前模式
  var picked = false;      // 是否已选过模式（用于拦截首次进入）
  var inGame = false;
  var clockStart = 0;      // 本局开始时的 performance.now()
  var clockLeft = 0;       // 剩余毫秒（限时模式）
  var buffs = {};          // 道具剩余毫秒

  var sence = null, game = null, state = null, message = null;
  var root = null, hud = null, resultEl = null, pickEl = null;
  var pickUnlockTimer = null;   // 面板打开期间持续释放指针锁的定时器

  /* ======================= 样式 ======================= */

  var CSS = [
    '#mz-hud{position:fixed;pointer-events:none;z-index:9000;display:none;',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#eaf2fb}',
    '#mz-hud.on{display:block}',

    /* 顶部时间条 */
    '#mz-bar{position:absolute;left:0;right:0;top:0;height:4px;background:rgba(0,0,0,.35)}',
    '#mz-bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#7fe3a8,#6ec8ff);',
    'transition:width .18s linear,background .3s}',
    '#mz-bar i.warn{background:linear-gradient(90deg,#ffc95e,#ff9d3d)}',
    '#mz-bar i.danger{background:linear-gradient(90deg,#ff7a5c,#ff3b30)}',

    /* 顶部标题行 */
    '#mz-head{position:absolute;left:0;right:0;top:10px;display:flex;justify-content:center;',
    'align-items:center;gap:12px}',
    '#mz-mode{font-size:13px;font-weight:800;letter-spacing:3px;padding:3px 12px;border-radius:20px;',
    'background:rgba(8,12,18,.6);border:1px solid rgba(255,255,255,.14)}',
    '#mz-clock{font-size:26px;font-weight:800;letter-spacing:1px;',
    'text-shadow:0 3px 14px rgba(0,0,0,.75);font-variant-numeric:tabular-nums}',
    '#mz-clock.hide{display:none}',

    /* 连击 */
    '#mz-combo{position:absolute;left:50%;top:52%;transform:translate(-50%,-50%) scale(.6);',
    'font-size:34px;font-weight:900;letter-spacing:2px;opacity:0;',
    'text-shadow:0 4px 22px rgba(0,0,0,.8);transition:opacity .18s}',
    '#mz-combo.show{opacity:1}',
    '#mz-combo small{display:block;font-size:12px;font-weight:600;letter-spacing:3px;',
    'opacity:.75;margin-top:2px;text-align:center}',

    /* 飘分 */
    '.mz-float{position:fixed;pointer-events:none;z-index:9100;font-weight:900;',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'text-shadow:0 3px 12px rgba(0,0,0,.85);animation:mzRise .95s ease-out forwards}',
    '@keyframes mzRise{0%{opacity:0;transform:translate(-50%,0) scale(.7)}',
    '18%{opacity:1;transform:translate(-50%,-16px) scale(1.12)}',
    '100%{opacity:0;transform:translate(-50%,-64px) scale(1)}}',

    /* 道具条 */
    '#mz-buffs{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);',
    'display:flex;gap:10px}',
    '.mz-buff{display:flex;align-items:center;gap:6px;padding:5px 12px 5px 9px;border-radius:22px;',
    'background:rgba(6,10,16,.72);border:1px solid rgba(255,255,255,.16);',
    'font-size:12px;font-weight:700;letter-spacing:.5px}',
    '.mz-buff em{font-style:normal;opacity:.7;font-weight:600;font-variant-numeric:tabular-nums}',
    '.mz-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 10px currentColor;background:currentColor}',

    /* 模式选择 */
    '#mz-pick{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;',
    'background:radial-gradient(circle at 50% 42%,rgba(12,18,28,.9),rgba(2,4,7,.98));',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#eaf2fb}',
    '#mz-pick.on{display:flex}',
    '#mz-pick .box{width:min(720px,92vw)}',
    '#mz-pick h1{font-size:23px;letter-spacing:3px;margin:0 0 6px;text-align:center;',
    'background:linear-gradient(90deg,#7fe3a8,#6ec8ff);-webkit-background-clip:text;',
    'background-clip:text;color:transparent}',
    '#mz-pick .sub{text-align:center;font-size:12px;color:#7d8ca1;margin:0 0 22px;letter-spacing:1px}',
    '#mz-pick .sub b{color:#8ff0b6;font-size:14px;font-weight:800}',
    '#mz-pick .row{display:flex;gap:14px}',
    '#mz-pick .card{flex:1;padding:20px 18px;border-radius:16px;cursor:pointer;text-align:left;',
    'background:linear-gradient(180deg,rgba(26,34,48,.95),rgba(14,19,28,.95));',
    'border:1px solid rgba(255,255,255,.09);transition:transform .14s,border-color .14s,box-shadow .14s}',
    '#mz-pick .card:hover{transform:translateY(-3px)}',
    '#mz-pick .card .no{font-size:11px;letter-spacing:2px;opacity:.45;margin-bottom:6px}',
    '#mz-pick .card .nm{font-size:20px;font-weight:800;letter-spacing:2px;margin-bottom:3px}',
    '#mz-pick .card .en{font-size:10px;letter-spacing:3px;opacity:.4;margin-bottom:12px}',
    '#mz-pick .card .ru{font-size:12.5px;line-height:1.65;color:#a3b1c4;min-height:42px}',
    '#mz-pick .card .tg{margin-top:12px;display:inline-block;font-size:11px;padding:3px 10px;',
    'border-radius:12px;background:rgba(255,255,255,.07)}',
    '#mz-pick .keys{text-align:center;font-size:11.5px;color:#66748a;margin-top:18px;letter-spacing:1px}',

    /* 结算 */
    '#mz-result{position:fixed;inset:0;z-index:9850;display:none;align-items:center;justify-content:center;',
    'background:radial-gradient(circle at 50% 45%,rgba(10,16,24,.82),rgba(2,4,7,.96));',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#eaf2fb}',
    '#mz-result.on{display:flex}',
    '#mz-result .box{width:min(460px,90vw);padding:30px 34px 26px;border-radius:20px;text-align:center;',
    'background:linear-gradient(180deg,rgba(28,36,50,.97),rgba(14,19,28,.97));',
    'border:1px solid rgba(120,190,255,.16);box-shadow:0 26px 70px rgba(0,0,0,.66)}',
    '#mz-result .why{font-size:12px;letter-spacing:4px;color:#7d8ca1;margin-bottom:4px}',
    '#mz-result .big{font-size:64px;font-weight:900;line-height:1.05;',
    'background:linear-gradient(180deg,#fff,#8fd0ff);-webkit-background-clip:text;',
    'background-clip:text;color:transparent}',
    '#mz-result .lbl{font-size:11px;letter-spacing:4px;color:#5f6d80;margin-bottom:20px}',
    '#mz-result .stats{display:flex;justify-content:center;gap:30px;margin-bottom:22px}',
    '#mz-result .stats div{text-align:center}',
    '#mz-result .stats b{display:block;font-size:22px;font-weight:800}',
    '#mz-result .stats span{font-size:10.5px;letter-spacing:2px;color:#6d7b8f}',
    '#mz-result .row{display:flex;gap:12px;justify-content:center}',
    '#mz-result button{padding:12px 28px;font-size:14px;font-weight:800;letter-spacing:1px;',
    'cursor:pointer;border:none;border-radius:11px;font-family:inherit}',
    '#mz-result .primary{color:#06121a;background:linear-gradient(135deg,#8ff0b6,#62c8f0)}',
    '#mz-result .ghost{color:#b9c7d8;background:rgba(255,255,255,.08)}',
    '#mz-result button:active{transform:translateY(1px)}'
  ].join('');

  function injectCss() {
    var s = document.createElement('style');
    s.id = 'mz-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ======================= 画面矩形 ======================= */

  // 游戏画面是 640×480 的画布被 airstick.js 用 transform 等比放大，
  // 所以直接读 #extra 的视觉矩形最准，不用自己算偏移。
  function frameRect() {
    var el = document.getElementById('extra');
    var r = el ? el.getBoundingClientRect() : null;
    if (!r || !r.width) {
      return {
        x: 0,
        y: 0,
        w: window.innerWidth,
        h: window.innerHeight,
        k: 1
      };
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height, k: r.width / 640 };
  }

  function syncHudFrame() {
    if (!hud) return;
    var f = frameRect();

    // 画面是按中心缩放再上移 40px 的，放大后上下会溢出视口，
    // 直接拿 rect 当容器会把自己的头部裁到屏幕外。这里夹到可见区域。
    var left = Math.max(0, f.x);
    var top = Math.max(0, f.y);
    var right = Math.min(window.innerWidth, f.x + f.w);
    var bottom = Math.min(window.innerHeight, f.y + f.h);

    hud.style.left = left + 'px';
    hud.style.top = top + 'px';
    hud.style.width = Math.max(0, right - left) + 'px';
    hud.style.height = Math.max(0, bottom - top) + 'px';
  }

  /* ======================= 构建界面 ======================= */

  function buildHud() {
    hud = document.createElement('div');
    hud.id = 'mz-hud';
    hud.innerHTML =
      '<div id="mz-bar"><i></i></div>' +
      '<div id="mz-head">' +
      '<span id="mz-mode">经典</span>' +
      '<span id="mz-clock" class="hide">--:--</span>' +
      '</div>' +
      '<div id="mz-combo"></div>' +
      '<div id="mz-buffs"></div>';
    document.body.appendChild(hud);
    syncHudFrame();
  }

  function buildPick() {
    var order = ['classic', 'zen', 'arcade'];
    var cards = order
      .map(function (id, i) {
        var m = MODES[id];
        return (
          '<div class="card" data-mode="' + id + '" style="border-color:' + m.color + '33">' +
          '<div class="no">0' + (i + 1) + '</div>' +
          '<div class="nm" style="color:' + m.color + '">' + m.name + '</div>' +
          '<div class="en">' + m.en + '</div>' +
          '<div class="ru">' + m.rule + '</div>' +
          '<div class="tg">' + m.tag + '</div>' +
          '</div>'
        );
      })
      .join('');

    pickEl = document.createElement('div');
    pickEl.id = 'mz-pick';
    pickEl.innerHTML =
      '<div class="box">' +
      '<h1>选个玩法</h1>' +
      '<p class="sub">点卡片，或者按 <b>1</b> / <b>2</b> / <b>3</b> 直接开始</p>' +
      '<div class="row">' + cards + '</div>' +
      '<div class="keys">切到西瓜就会进游戏 · Esc 返回菜单</div>' +
      '</div>';
    document.body.appendChild(pickEl);

    pickEl.addEventListener('click', function (e) {
      // 必须拦住冒泡：原版在 document 上监听 click 做「回主菜单」，
      // 让它收到就会把刚切过去的场景状态搅乱（上一次接体感时踩过同一个坑）
      e.stopPropagation();
      e.preventDefault();

      var card = e.target.closest ? e.target.closest('.card') : null;
      if (card) chooseMode(card.getAttribute('data-mode'));
    });

    // 顺带把指针事件挡在这层里：体感层在 document 上监听 mousemove 喂刀，
    // 选模式时鼠标一动，游戏里的刀就会乱挥
    ['mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove']
      .forEach(function (t) {
        pickEl.addEventListener(t, function (e) { e.stopPropagation(); });
      });
  }

  // 选模式必须能看见光标，所以弹层时主动解除指针锁；
  // 用 __mzPicking 告诉体感层「这是我主动解的，别弹暂停面板」
  function setPicking(v) {
    window.__mzPicking = !!v;
    if (v) forceUnlock();
  }

  // 指针锁没解开时，浏览器会把所有鼠标事件投递到被锁定的元素（documentElement），
  // 模式卡片永远收不到 click —— 表现就是「面板还在，点了没反应」。
  // 所以只要面板开着，就持续尝试释放，直到真的解开为止。
  function forceUnlock() {
    if (document.pointerLockElement) {
      try { document.exitPointerLock(); } catch (e) { /* 忽略 */ }
    }
  }

  function showPick() {
    if (!pickEl) buildPick();
    setPicking(true);
    forceUnlock();
    if (!pickUnlockTimer) pickUnlockTimer = setInterval(forceUnlock, 120);
    pickEl.classList.add('on');
  }

  function hidePick() {
    if (pickUnlockTimer) {
      clearInterval(pickUnlockTimer);
      pickUnlockTimer = null;
    }
    if (pickEl) pickEl.classList.remove('on');
    setPicking(false);
  }

  function chooseMode(id) {
    if (!MODES[id]) {
      // 点到的不是有效卡片（比如点在面板空白处），不要静默什么都不做
      return;
    }
    current = MODES[id];
    window.__mode = current;
    picked = true;
    hidePick();

    // 掐掉启动时那个「3 秒后无条件回主菜单」的定时器：
    // 玩家手快在 3 秒内进对局时，它会在对局中途把画面踢回标题页
    try {
      var main = require('scripts/main.js');
      if (main.__homeTimer) {
        if (main.__homeTimer.stop) main.__homeTimer.stop();
        main.__homeTimer = null;
      }
    } catch (e) { /* 拿不到就算了，不影响开局 */ }

    // 选完立刻把锁要回来，否则玩家得再点一次「开始体感」
    if (window.__airWasLocked) {
      try {
        document.documentElement.requestPointerLock();
      } catch (e) { /* 浏览器拒绝就退化成顶部提示，不影响玩 */ }
    }

    sence.switchSence('game-body');
  }

  function buildResult() {
    resultEl = document.createElement('div');
    resultEl.id = 'mz-result';
    resultEl.innerHTML =
      '<div class="box">' +
      '<div class="why" id="mz-why">时间到</div>' +
      '<div class="big" id="mz-score">0</div>' +
      '<div class="lbl">得分</div>' +
      '<div class="stats">' +
      '<div><b id="mz-peak">0</b><span>最高连击</span></div>' +
      '<div><b id="mz-mode2">—</b><span>模式</span></div>' +
      '</div>' +
      '<div class="row">' +
      '<button class="primary" id="mz-again">再来一局</button>' +
      '<button class="ghost" id="mz-menu">回菜单</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(resultEl);

    document.getElementById('mz-again').addEventListener('click', function (e) {
      e.stopPropagation();
      restart();
    });
    document.getElementById('mz-menu').addEventListener('click', function (e) {
      e.stopPropagation();
      backToMenu();
    });

    ['mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove']
      .forEach(function (t) {
        resultEl.addEventListener(t, function (e) { e.stopPropagation(); });
      });
  }

  function showResult(reason) {
    if (!resultEl) buildResult();

    // 原版那张巨大的 GAME OVER 会透在我们的面板后面，收掉
    try {
      require('scripts/object/game-over.js').hide();
    } catch (e3) { /* 忽略 */ }

    var run = window.__lastRun || { score: 0, peakCombo: 0, mode: 'classic' };
    var m = MODES[run.mode] || MODES.classic;

    document.getElementById('mz-why').textContent = reason;
    document.getElementById('mz-score').textContent = run.score;
    document.getElementById('mz-peak').textContent = run.peakCombo || 0;
    document.getElementById('mz-mode2').textContent = m.name;
    document.getElementById('mz-mode2').style.color = m.color;

    resultEl.classList.add('on');
  }

  function hideResult() {
    if (resultEl) resultEl.classList.remove('on');
  }

  /* ======================= 流程控制 ======================= */

  function backToMenu() {
    hideResult();
    hidePick();
    inGame = false;
    hud.classList.remove('on');
    picked = false;                   // 下次进游戏重新选模式
    sence.switchSence('home-menu');
  }

  function restart() {
    hideResult();
    hidePick();

    // game.gameOver() 已经把分数、出水果的定时器、连击全部清干净了，
    // 场景状态也还是 ready，所以可以原地重开，不必绕回菜单等三段动画
    try {
      require('scripts/object/score.js').number(0);
    } catch (e) { /* 忽略 */ }

    inGame = false;
    enterGame();
    game.start();

    // 刀在结束时会停住，重开必须重新打开，否则转设备不会切
    try {
      require('scripts/object/knife.js').switchOn();
    } catch (e2) { /* 忽略 */ }
  }

  /* ======================= HUD 刷新 ======================= */

  var clockEl, barEl, comboEl, buffsEl, modeEl;
  var comboHideAt = 0;

  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function paintClock() {
    if (!current || !current.duration) {
      clockEl.classList.add('hide');
      barEl.parentNode.style.display = 'none';
      return;
    }
    clockEl.classList.remove('hide');
    barEl.parentNode.style.display = 'block';

    var total = current.duration;
    // 还没到 ready 就按满时间显示，不往前跑
    var left = clockStart ? Math.max(0, total - (performance.now() - clockStart)) : total;
    clockLeft = left;

    clockEl.textContent = mmss(left);
    barEl.style.width = (left / total) * 100 + '%';

    barEl.className = left < 10000 ? 'danger' : left < 30000 ? 'warn' : '';
    clockEl.style.color = left < 10000 ? '#ff6b5c' : '#fff';
  }

  function paintBuffs() {
    if (!buffsEl) return;
    var now = performance.now();
    var html = '';
    var defs = [
      ['freeze', '冰冻', '#7cc6ff'],
      ['double', '双倍', '#ffd54a'],
      ['frenzy', '狂热', '#ff7a4a']
    ];
    for (var i = 0; i < defs.length; i++) {
      var key = defs[i][0];
      var left = buffs[key] - now;
      if (left > 0) {
        html +=
          '<div class="mz-buff" style="color:' + defs[i][2] + '">' +
          '<span class="mz-dot"></span>' + defs[i][1] +
          '<em>' + (left / 1000).toFixed(1) + 's</em></div>';
      }
    }
    if (html !== buffsEl._html) {
      buffsEl.innerHTML = html;
      buffsEl._html = html;
    }
  }

  function paintCombo() {
    if (!comboEl) return;
    if (performance.now() > comboHideAt) {
      comboEl.classList.remove('show');
    }
  }

  function flashCombo(n) {
    if (!comboEl) return;
    if (n < 2) {
      comboEl.classList.remove('show');
      return;
    }
    var text =
      n >= 5 ? 'COMBO ×' + n + '<small>势如破竹</small>' :
      n >= 3 ? 'COMBO ×' + n + '<small>连击</small>' :
      'COMBO ×' + n;
    comboEl.innerHTML = text;
    comboEl.style.color = n >= 5 ? '#ffd76a' : n >= 3 ? '#8ff0b6' : '#cfe3f7';
    comboEl.classList.add('show');
    comboEl.style.transform = 'translate(-50%,-50%) scale(1)';

    clearTimeout(comboEl._t);
    comboEl._t = setTimeout(function () {
      comboEl.style.transform = 'translate(-50%,-50%) scale(.72)';
    }, 90);
    comboHideAt = performance.now() + 750;
  }

  /* ======================= 飘分 ======================= */

  function spawnFloat(text, color, x, y, size) {
    var el = document.createElement('div');
    el.className = 'mz-float';
    el.textContent = text;
    el.style.color = color;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.fontSize = size + 'px';
    document.body.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 1000);
  }

  function onGain(data) {
    if (!inGame || !data) return;

    var f = frameRect();
    var x = f.x + f.w / 2 + (Math.random() - 0.5) * f.w * 0.18;
    var y = f.y + f.h * 0.34;

    var color = '#ffffff';
    var size = Math.min(34, Math.max(18, f.w / 30));

    if (data.crit) {
      spawnFloat('CRITICAL +' + data.gain, '#ffd76a', x, y - 20, size * 1.25);
    } else if (data.batch >= 3) {
      spawnFloat('一刀 ' + data.batch + ' 连 +' + data.gain, '#8ff0b6', x, y, size);
    } else {
      spawnFloat('+' + data.gain, color, x, y, size);
    }

    flashCombo(data.combo);
  }

  /* ======================= 主循环 ======================= */

  function loop() {
    requestAnimationFrame(loop);

    if (!inGame) return;

    // 场景 ready 之后才开始计时（进场动画期间原版会丢弃切割）
    if (!clockStart && state('sence-state').is('ready')) {
      clockStart = performance.now();
    }

    syncHudFrame();
    paintClock();
    paintBuffs();
    paintCombo();

    // 限时模式到点收摊
    if (current && current.duration && clockStart && clockLeft <= 0 &&
        state('game-state').is('playing')) {
      endRun('时间到');
    }
  }

  var ending = false;

  function endRun(reason) {
    if (ending) return;
    ending = true;
    hidePick();
    try {
      game.gameOver();
    } catch (e) { /* 忽略 */ }
    setTimeout(function () {
      showResult(reason);
      ending = false;
    }, 600);
  }

  /* ======================= 拦截进入游戏 ======================= */

  function hookSence() {
    var orig = sence.switchSence;

    sence.switchSence = function (name) {
      // 第一次切到游戏场景先弹模式选择，其余场景照常走
      if (name === 'game-body' && !picked) {
        showPick();
        return;
      }
      return orig.apply(sence, arguments);
    };
  }

  /* ======================= 进入 / 离开游戏 ======================= */

  function enterGame() {
    inGame = true;
    hideResult();
    hud.classList.add('on');

    // 计时起点留到场景真正 ready 再定：进场动画约 1 秒，
    // 这期间原版会丢弃所有切割，提前计时等于白扣玩家一秒
    clockStart = 0;
    clockLeft = current && current.duration ? current.duration : 0;
    buffs = {};
    if (buffsEl) buffsEl.innerHTML = '';

    var m = current || MODES.classic;
    modeEl.textContent = m.name;
    modeEl.style.color = m.color;
    modeEl.style.borderColor = m.color + '55';

    // 只有经典模式有命，另外两个模式把右上角的命图标收起来
    // （fps 的导出整段被注释掉了，没有 hide 方法，不用管它）
    try {
      require('scripts/object/lose.js').setVisible(m.id === 'classic');
    } catch (e2) { /* 模块可能还没初始化完，忽略 */ }
  }

  function leaveGame() {
    inGame = false;
    hud.classList.remove('on');
  }

  /* ======================= 消息 ======================= */

  function bindMessages() {
    message.addEventListener('score.gain', onGain);

    message.addEventListener('bomb.hit', function () {
      if (!inGame) return;
      var f = frameRect();
      spawnFloat('-10', '#ff7a5c', f.x + f.w / 2, f.y + f.h * 0.34, 30);
      if (comboEl) comboEl.classList.remove('show');
    });

    var buffMap = { freeze: 5000, double: 10000, frenzy: 8000 };

    Object.keys(buffMap).forEach(function (key) {
      message.addEventListener(key + '.start', function () {
        if (!inGame) return;
        buffs[key] = performance.now() + buffMap[key];
        var f = frameRect();
        var label = { freeze: '冰冻！', double: '双倍！', frenzy: '狂热！' }[key];
        var color = { freeze: '#7cc6ff', double: '#ffd54a', frenzy: '#ff7a4a' }[key];
        spawnFloat(label, color, f.x + f.w / 2, f.y + f.h * 0.22, 36);
      });
      message.addEventListener(key + '.end', function () {
        delete buffs[key];
      });
    });

    // 原版炸弹致命后走的是 game.over，这里接住，换成我们自己的结算
    message.addEventListener('game.over', function () {
      if (!inGame) return;
      ending = true;
      setTimeout(function () {
        showResult('踩到炸弹');
        ending = false;
      }, 1400);
    });
  }

  /* ======================= 键盘 ======================= */

  window.addEventListener('keydown', function (e) {
    if (pickEl && pickEl.classList.contains('on')) {
      if (e.key === '1') chooseMode('classic');
      else if (e.key === '2') chooseMode('zen');
      else if (e.key === '3') chooseMode('arcade');
      else if (e.code === 'Escape') backToMenu();
      return;
    }

    if (e.key === 'Escape' && inGame) {
      if (resultEl && resultEl.classList.contains('on')) backToMenu();
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) return;
    if (e.code === 'KeyR' && resultEl && resultEl.classList.contains('on')) {
      restart();
    }
  });

  window.addEventListener('resize', syncHudFrame);

  /* ======================= 启动 ======================= */

  function boot() {
    if (!window.require) return setTimeout(boot, 100);

    try {
      sence = require('scripts/sence.js');
      game = require('scripts/game.js');
      state = require('scripts/state.js');
      message = require('scripts/message.js');
    } catch (err) {
      return setTimeout(boot, 150);
    }
    if (!sence || !game || !state || !message) return setTimeout(boot, 150);

    injectCss();
    buildHud();
    clockEl = document.getElementById('mz-clock');
    barEl = document.querySelector('#mz-bar i');
    modeEl = document.getElementById('mz-mode');
    comboEl = document.getElementById('mz-combo');
    buffsEl = document.getElementById('mz-buffs');

    hookSence();
    bindMessages();

    // 点击兜底：指针锁还在生效时，click 会被投给 documentElement，卡片收不到。
    // 这里在捕获阶段补一层，用坐标做命中测试，能点到就照常开局。
    document.addEventListener(
      'click',
      function (e) {
        if (!pickEl || !pickEl.classList.contains('on')) return;
        if (e.target && pickEl.contains(e.target)) return;   // 正常路径已在面板上处理
        var hit = null;
        try { hit = document.elementFromPoint(e.clientX, e.clientY); } catch (err) { /* 忽略 */ }
        var card = hit && hit.closest ? hit.closest('.card') : null;
        if (card && pickEl.contains(card)) {
          e.stopPropagation();
          e.preventDefault();
          chooseMode(card.getAttribute('data-mode'));
        }
      },
      true
    );

    // 场景轮询：进入 game-body 就初始化本局，回菜单就收 HUD
    var lastSence = '';
    setInterval(function () {
      var name = state('sence-name').get();
      if (name === lastSence) return;
      lastSence = name;

      if (name === 'game-body') {
        if (!current) {
          current = MODES.classic;
          window.__mode = current;
        }
        enterGame();
      } else {
        leaveGame();
      }
    }, 150);

    requestAnimationFrame(loop);
  }

  boot();
})();

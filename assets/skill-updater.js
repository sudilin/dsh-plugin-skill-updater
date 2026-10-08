/*!
 * dsh-plugin-skill-updater / assets/skill-updater.js
 * Popup UI for the DSH Update Center plugin.
 *
 * Classic browser script: plain IIFE, no imports/exports, no JSX, no bundler,
 * no external libraries, no TypeScript. ES2017-compatible (Chromium ~130).
 * Injected by the host as a classic <script> on both the Electron client and
 * a normal browser page. UTF-8, no BOM.
 */
(function () {
  'use strict';

  var INJECT_FLAG = '__dshSkillUpdaterInjected__';
  if (window[INJECT_FLAG]) { return; }
  window[INJECT_FLAG] = true;

  /* ------------------------------------------------------------------ *
   * Constants & state
   * ------------------------------------------------------------------ */

  var BASE = '/dsh-plugin-skill-updater';
  var STYLE_ID = 'dsh-skill-updater-style';
  var ROOT_ID = 'dsh-skill-updater-root';
  var CLOSED_KEY = 'dshSkillUpdater.closed';
  var SHOWN_KEY = 'dshSkillUpdater.shown';

  var POLL_MS = 700;
  var REQUEST_TIMEOUT_MS = 10000;              /* 单个控制请求的上限:宿主不回应时不能一直等 */
  var MAX_STATUS_FAILURES = 5;                 /* 连续失败次数上限 */
  var STATUS_WATCHDOG_MS = 10 * 60 * 1000;     /* 宿主长期停在 checking 的兜底上限 */
  var MAX_JOB_POLLS = 800;
  var MAX_LOG_LINES = 200;

  var state = {
    root: null,
    status: null,
    view: 'list',          // 'list' | 'progress' | 'done'
    selected: Object.create(null),   // id -> boolean (true = checked);无原型,避免 "__proto__" 之类的 id
    closed: false,         // 用户本次会话是否主动关闭过面板
    modalOpen: false,
    skippedOpen: false,
    logOpen: false,
    inlineError: null,
    summary: null,
    job: null,
    applying: false,
    statusTimer: null,
    statusFailures: 0,     // 连续失败次数
    statusSince: 0,        // 本轮轮询开始时间(看门狗基准)
    jobTimer: null,
    jobPolls: 0,
    prevFocus: null
  };

  var ui = {
    backdrop: null,
    modal: null,
    title: null,
    sub: null,
    body: null,
    foot: null,
    live: null,
    primary: null
  };

  var loggedOnce = {};

  /* ------------------------------------------------------------------ *
   * Styles (scoped to #dsh-skill-updater-root only)
   * ------------------------------------------------------------------ */

  var DARK_VARS = [
    '--dsuc-text: var(--text-1, #e6e6e6);',
    '--dsuc-dim: var(--text-2, #a1a7b3);',
    '--dsuc-dim2: var(--text-3, #7d848f);',
    '--dsuc-bg: var(--bg-2, #1e1e1e);',
    '--dsuc-bg-soft: var(--bg-3, #262a2e);',
    '--dsuc-border: var(--border-1, rgba(255,255,255,.14));',
    '--dsuc-brand: var(--brand-1, #4d6bfe);',
    '--dsuc-brand-bg: rgba(77,107,254,.16);',
    '--dsuc-brand-border: rgba(77,107,254,.40);',
    '--dsuc-ok: #35c46b;',
    '--dsuc-ok-bg: rgba(53,196,107,.16);',
    '--dsuc-ok-border: rgba(53,196,107,.40);',
    '--dsuc-err: #f2555a;',
    '--dsuc-warn: #e8b339;',
    '--dsuc-warn-bg: rgba(232,179,57,.14);',
    '--dsuc-warn-border: rgba(232,179,57,.45);',
    '--dsuc-shadow: 0 24px 64px rgba(0,0,0,.45);'
  ].join(' ');

  var LIGHT_VARS = [
    '--dsuc-text: var(--text-1, #1f2328);',
    '--dsuc-dim: var(--text-2, #57606a);',
    '--dsuc-dim2: var(--text-3, #6e7781);',
    '--dsuc-bg: var(--bg-2, #ffffff);',
    '--dsuc-bg-soft: var(--bg-3, #f2f3f5);',
    '--dsuc-border: var(--border-1, rgba(0,0,0,.14));',
    '--dsuc-brand: var(--brand-1, #3b5bfd);',
    '--dsuc-brand-bg: rgba(59,91,253,.10);',
    '--dsuc-brand-border: rgba(59,91,253,.35);',
    '--dsuc-ok: #1a7f37;',
    '--dsuc-ok-bg: rgba(26,127,55,.10);',
    '--dsuc-ok-border: rgba(26,127,55,.32);',
    '--dsuc-err: #cf222e;',
    '--dsuc-warn: #9a6700;',
    '--dsuc-warn-bg: rgba(212,167,44,.16);',
    '--dsuc-warn-border: rgba(154,103,0,.35);',
    '--dsuc-shadow: 0 18px 48px rgba(15,20,30,.18);'
  ].join(' ');

  var CSS = `
#dsh-skill-updater-root{
  ${DARK_VARS}
  position:fixed;
  inset:0;
  z-index:2147483000;
  pointer-events:none;
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  font-size:13px;
  line-height:1.5;
  color:var(--dsuc-text);
  text-align:left;
}
#dsh-skill-updater-root *,
#dsh-skill-updater-root *::before,
#dsh-skill-updater-root *::after{box-sizing:border-box;}

/* ---------- pill ----------
   左下角的胶囊按钮已移除:它会与 DSH 桌面端自带的「更多」控件重叠。
   面板本身每次启动都会自动弹出;关闭后可在控制台执行 dshSkillUpdater.open() 重新打开。 */

/* ---------- animated ellipsis ---------- */
#dsh-skill-updater-root .dsuc-dots{display:inline-flex;align-items:center;gap:3px;transform:translateY(1px);}
#dsh-skill-updater-root .dsuc-dots i{
  width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.25;
  animation:dsucDotPulse 1.3s infinite ease-in-out;
}
#dsh-skill-updater-root .dsuc-dots i:nth-child(2){animation-delay:.18s;}
#dsh-skill-updater-root .dsuc-dots i:nth-child(3){animation-delay:.36s;}
@keyframes dsucDotPulse{0%,70%,100%{opacity:.22;}30%{opacity:1;}}
@keyframes dsucFadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes dsucPopIn{from{opacity:0;transform:translateY(6px) scale(.985);}to{opacity:1;transform:none;}}

/* ---------- backdrop / modal ---------- */
#dsh-skill-updater-root .dsuc-backdrop{
  position:fixed;inset:0;z-index:2147483000;
  pointer-events:auto;
  display:flex;align-items:center;justify-content:center;
  padding:24px;
  background:rgba(0,0,0,.45);
  animation:dsucFadeIn .14s ease-out;
}
#dsh-skill-updater-root .dsuc-backdrop[hidden]{display:none;}
#dsh-skill-updater-root .dsuc-modal{
  display:flex;flex-direction:column;
  width:100%;max-width:620px;max-height:78vh;
  overflow:hidden;
  border:1px solid var(--dsuc-border);
  border-radius:12px;
  background:var(--dsuc-bg);
  color:var(--dsuc-text);
  box-shadow:var(--dsuc-shadow);
  animation:dsucPopIn .16s ease-out;
  outline:none;
}
#dsh-skill-updater-root .dsuc-head{
  display:flex;align-items:flex-start;gap:12px;
  padding:16px 18px 12px;
  border-bottom:1px solid var(--dsuc-border);
  flex:0 0 auto;
}
#dsh-skill-updater-root .dsuc-head-main{flex:1 1 auto;min-width:0;}
#dsh-skill-updater-root .dsuc-title{margin:0;font-size:15px;font-weight:600;color:var(--dsuc-text);}
#dsh-skill-updater-root .dsuc-sub{margin-top:4px;font-size:12px;color:var(--dsuc-dim);word-break:break-word;}
#dsh-skill-updater-root .dsuc-sub[hidden]{display:none;}
#dsh-skill-updater-root .dsuc-x{
  flex:0 0 auto;margin:0;padding:0 4px;
  border:0;background:transparent;color:var(--dsuc-dim);
  font:inherit;font-size:18px;line-height:1;cursor:pointer;border-radius:6px;
}
#dsh-skill-updater-root .dsuc-x:hover{color:var(--dsuc-text);}

/* ---------- body ---------- */
#dsh-skill-updater-root .dsuc-body{
  flex:1 1 auto;min-height:0;
  overflow-y:auto;overflow-x:hidden;
  padding:8px 0 10px;
  -webkit-overflow-scrolling:touch;
}
#dsh-skill-updater-root .dsuc-empty{padding:22px 18px;font-size:12.5px;color:var(--dsuc-dim);}
#dsh-skill-updater-root .dsuc-empty-err{color:var(--dsuc-err);word-break:break-word;}
/* 供读屏软件播报的状态区(视觉上隐藏) */
#dsh-skill-updater-root .dsuc-sr{
  position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;
}

/* ---------- rows ---------- */
#dsh-skill-updater-root .dsuc-row{
  display:flex;align-items:flex-start;gap:10px;
  padding:10px 18px;
  cursor:pointer;
}
#dsh-skill-updater-root .dsuc-row:hover{background:var(--dsuc-bg-soft);}
#dsh-skill-updater-root .dsuc-check{
  flex:0 0 auto;width:14px;height:14px;margin:3px 0 0;
  accent-color:var(--dsuc-brand);cursor:pointer;
}
#dsh-skill-updater-root .dsuc-badge{
  flex:0 0 auto;margin-top:1px;padding:1px 6px;
  border:1px solid transparent;border-radius:4px;
  font-size:11px;line-height:1.45;white-space:nowrap;
}
#dsh-skill-updater-root .dsuc-badge-plugin{
  background:var(--dsuc-brand-bg);border-color:var(--dsuc-brand-border);color:var(--dsuc-brand);
}
#dsh-skill-updater-root .dsuc-badge-skill{
  background:var(--dsuc-ok-bg);border-color:var(--dsuc-ok-border);color:var(--dsuc-ok);
}
#dsh-skill-updater-root .dsuc-main{flex:1 1 auto;min-width:0;}
#dsh-skill-updater-root .dsuc-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;}
#dsh-skill-updater-root .dsuc-name{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  font-size:12.5px;word-break:break-all;
}
#dsh-skill-updater-root .dsuc-ver{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;color:var(--dsuc-dim);white-space:nowrap;
}
#dsh-skill-updater-root .dsuc-new{color:var(--dsuc-brand);font-weight:700;}
#dsh-skill-updater-root .dsuc-note{margin-top:3px;font-size:11.5px;color:var(--dsuc-dim2);word-break:break-word;}
#dsh-skill-updater-root .dsuc-note-err{color:var(--dsuc-err);}

/* ---------- skipped ---------- */
#dsh-skill-updater-root .dsuc-skipped{
  margin:8px 18px 4px;padding-top:8px;
  border-top:1px dashed var(--dsuc-border);
  font-size:12px;color:var(--dsuc-dim);
}
#dsh-skill-updater-root .dsuc-skipped>summary{cursor:pointer;color:var(--dsuc-dim);outline:none;}
#dsh-skill-updater-root .dsuc-skip-row{
  padding:5px 0 0 14px;font-size:11.5px;color:var(--dsuc-dim2);word-break:break-word;
}

/* ---------- no-update: success banner + full inventory ---------- */
#dsh-skill-updater-root .dsuc-ok-banner{
  margin:8px 18px 10px;padding:9px 11px;
  border:1px solid var(--dsuc-ok-border);border-radius:8px;
  background:var(--dsuc-ok-bg);color:var(--dsuc-ok);
  font-size:12.5px;font-weight:600;
}
#dsh-skill-updater-root .dsuc-inventory{padding:0 0 4px;}
#dsh-skill-updater-root .dsuc-entry{
  display:flex;align-items:flex-start;gap:10px;
  padding:8px 18px;
}
#dsh-skill-updater-root .dsuc-entry:hover{background:var(--dsuc-bg-soft);}
#dsh-skill-updater-root .dsuc-scope{
  padding:0 5px;
  border:1px solid var(--dsuc-border);border-radius:4px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;color:var(--dsuc-dim2);white-space:nowrap;
}
#dsh-skill-updater-root .dsuc-mark{font-size:11.5px;font-weight:600;white-space:nowrap;}
#dsh-skill-updater-root .dsuc-mark-ok{color:var(--dsuc-ok);}
#dsh-skill-updater-root .dsuc-mark-skip{color:var(--dsuc-dim2);font-weight:400;}

/* ---------- progress steps ---------- */
#dsh-skill-updater-root .dsuc-steps{padding:2px 0;}
#dsh-skill-updater-root .dsuc-step{display:flex;align-items:flex-start;gap:10px;padding:7px 18px;}
#dsh-skill-updater-root .dsuc-glyph{flex:0 0 auto;width:18px;text-align:center;font-size:13px;line-height:1.4;}
#dsh-skill-updater-root .dsuc-step-main{flex:1 1 auto;min-width:0;}
#dsh-skill-updater-root .dsuc-step-label{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12.5px;word-break:break-all;
}
#dsh-skill-updater-root .dsuc-step-msg{margin-top:2px;font-size:11.5px;color:var(--dsuc-dim);word-break:break-word;}
#dsh-skill-updater-root .dsuc-step-ok .dsuc-glyph{color:var(--dsuc-ok);}
#dsh-skill-updater-root .dsuc-step-failed .dsuc-glyph{color:var(--dsuc-err);}
#dsh-skill-updater-root .dsuc-step-running .dsuc-glyph,
#dsh-skill-updater-root .dsuc-step-pending .dsuc-glyph{color:var(--dsuc-brand);}
#dsh-skill-updater-root .dsuc-step-skipped .dsuc-glyph{color:var(--dsuc-dim2);}

/* ---------- log ---------- */
#dsh-skill-updater-root .dsuc-log{
  margin:10px 18px 6px;
  border:1px solid var(--dsuc-border);border-radius:8px;
  background:var(--dsuc-bg-soft);
  overflow:hidden;
}
#dsh-skill-updater-root .dsuc-log>summary{padding:6px 10px;font-size:12px;color:var(--dsuc-dim);cursor:pointer;outline:none;}
#dsh-skill-updater-root .dsuc-log pre{
  margin:0;padding:8px 10px;max-height:220px;overflow:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:1.45;color:var(--dsuc-dim);
  white-space:pre-wrap;word-break:break-word;
}

/* ---------- done view ---------- */
#dsh-skill-updater-root .dsuc-summary{padding:14px 18px 2px;font-size:13.5px;font-weight:600;}
#dsh-skill-updater-root .dsuc-summary-ok{color:var(--dsuc-ok);}
#dsh-skill-updater-root .dsuc-summary-bad{color:var(--dsuc-err);}
#dsh-skill-updater-root .dsuc-warn{
  margin:10px 18px 4px;padding:9px 11px;
  border:1px solid var(--dsuc-warn-border);border-radius:8px;
  background:var(--dsuc-warn-bg);color:var(--dsuc-warn);
  font-size:12.5px;font-weight:600;
}

/* ---------- footer ---------- */
#dsh-skill-updater-root .dsuc-foot{
  flex:0 0 auto;
  display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;
  padding:12px 18px;
  border-top:1px solid var(--dsuc-border);
}
#dsh-skill-updater-root .dsuc-err-line{
  flex:1 1 200px;margin-right:auto;
  color:var(--dsuc-err);font-size:12px;word-break:break-word;
}
#dsh-skill-updater-root .dsuc-hint{flex:1 1 auto;color:var(--dsuc-dim);font-size:12px;}
#dsh-skill-updater-root .dsuc-btn{
  margin:0;padding:7px 14px;
  border:1px solid var(--dsuc-border);border-radius:8px;
  background:transparent;color:var(--dsuc-text);
  font:inherit;font-size:12.5px;line-height:1.4;
  cursor:pointer;
}
#dsh-skill-updater-root .dsuc-btn:hover:not(:disabled){background:var(--dsuc-bg-soft);}
#dsh-skill-updater-root .dsuc-btn:disabled{opacity:.5;cursor:not-allowed;}
#dsh-skill-updater-root .dsuc-btn-primary{
  background:var(--dsuc-brand);border-color:var(--dsuc-brand);color:#fff;font-weight:600;
}
#dsh-skill-updater-root .dsuc-btn-primary:hover:not(:disabled){background:var(--dsuc-brand);filter:brightness(1.1);}
#dsh-skill-updater-root .dsuc-btn-plain{border-color:transparent;color:var(--dsuc-dim);}
#dsh-skill-updater-root .dsuc-btn-plain:hover:not(:disabled){color:var(--dsuc-text);}

@media (max-width:520px){
  #dsh-skill-updater-root .dsuc-backdrop{padding:12px;}
  #dsh-skill-updater-root .dsuc-modal{max-height:88vh;}
}
@media (prefers-reduced-motion:reduce){
  #dsh-skill-updater-root .dsuc-dots i,
  #dsh-skill-updater-root .dsuc-backdrop,
  #dsh-skill-updater-root .dsuc-modal{animation:none;}
}
`;

  CSS += '@media (prefers-color-scheme: light){#dsh-skill-updater-root{' + LIGHT_VARS + '}}';
  CSS += 'html[data-theme="light"] #dsh-skill-updater-root,'
       + 'html.light #dsh-skill-updater-root,'
       + 'body.light #dsh-skill-updater-root{' + LIGHT_VARS + '}';
  CSS += 'html[data-theme="dark"] #dsh-skill-updater-root{' + DARK_VARS + '}';

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function clear(node) {
    if (node) { node.textContent = ''; }
  }

  function safely(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
        return undefined;
      }
    };
  }

  function logOnce(key, message) {
    if (loggedOnce[key]) { return; }
    loggedOnce[key] = true;
    try { console.log(message); } catch (e) { /* ignore */ }
  }

  function dotsNode() {
    var wrap = el('span', 'dsuc-dots');
    wrap.appendChild(el('i'));
    wrap.appendChild(el('i'));
    wrap.appendChild(el('i'));
    return wrap;
  }

  function fmtTime(iso) {
    if (!iso) { return '--:--:--'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return String(iso); }
    try {
      return d.toLocaleTimeString('zh-CN', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (e) {
      return d.toTimeString().slice(0, 8);
    }
  }

  function friendlyError(err, prefix) {
    var msg = (err && err.message) ? String(err.message) : String(err || '未知错误');
    return prefix ? (prefix + '：' + msg) : msg;
  }

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  /* "本会话已经自动弹过面板" / "用户本会话主动关闭过面板"。
   * DSH 重启或重开桌面端会开始新的浏览器会话,所以面板每次启动弹一次;
   * 普通 F5 保留同一个 sessionStorage,所以不会反复打扰。 */
  function readShown() {
    try { return sessionStorage.getItem(SHOWN_KEY) === '1'; } catch (e) { return false; }
  }

  function writeShown() {
    try { sessionStorage.setItem(SHOWN_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function readClosed() {
    try { return sessionStorage.getItem(CLOSED_KEY) === '1'; } catch (e) { return false; }
  }

  function writeClosed() {
    try { sessionStorage.setItem(CLOSED_KEY, '1'); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */

  /* 控制请求必须有上限:宿主不回应(hang)时,超时要和请求失败一样落到 error 状态,
   * 否则面板会一直卡在 checking 且「重新检查」不可点。
   * 用 AbortController + setTimeout(ES2017 兼容,不用 AbortSignal.timeout)。 */
  function httpJson(method, url, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    var timer = null;
    var timedOut = false;
    try {
      if (typeof AbortController === 'function') {
        var controller = new AbortController();
        opts.signal = controller.signal;
        timer = setTimeout(function () {
          timedOut = true;
          try { controller.abort(); } catch (e) { /* ignore */ }
        }, REQUEST_TIMEOUT_MS);
      }
    } catch (e) {
      timer = null;
    }

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    var request;
    try {
      request = fetch(url, opts);
    } catch (err) {
      /* 同步失败(例如没有 fetch):清掉计时器后原样抛出,调用方照旧同步捕获。 */
      clearTimer();
      throw err;
    }

    return request.then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        if (!res.ok) {
          var serverMsg = data && (data.error || data.message);
          throw new Error(serverMsg ? String(serverMsg) : ('HTTP ' + res.status));
        }
        if (data === null) { throw new Error('响应不是有效的 JSON'); }
        return data;
      });
    }, function (err) {
      if (timedOut) { throw new Error('请求超时（超过 ' + (REQUEST_TIMEOUT_MS / 1000) + ' 秒）'); }
      var reason = (err && err.message) ? err.message : '未知原因';
      throw new Error('网络请求失败（' + reason + '）');
    }).then(function (data) {
      clearTimer();
      return data;
    }, function (err) {
      clearTimer();
      throw err;
    });
  }

  /* ------------------------------------------------------------------ *
   * Status model
   * ------------------------------------------------------------------ */

  function normalizeEntry(raw) {
    var e = (raw && typeof raw === 'object') ? raw : {};
    var status = (e.status === 'update' || e.status === 'skipped') ? e.status : 'current';
    var name = e.name ? String(e.name) : (e.id ? String(e.id) : '');
    return {
      id: e.id ? String(e.id) : name,
      kind: e.kind === 'skill' ? 'skill' : 'plugin',
      scope: e.scope ? String(e.scope) : '',
      name: name,
      installed: (e.installed === undefined || e.installed === null || e.installed === '')
        ? null : String(e.installed),
      available: (e.available === undefined || e.available === null || e.available === '')
        ? null : String(e.available),
      status: status,
      note: e.note ? String(e.note) : null
    };
  }

  function normalizeStatus(raw) {
    var st = (raw && typeof raw === 'object') ? raw : {};
    /* items 和 entries 用同一套归一化,坏数据不会变成「有 N 项可更新」却渲染不出行。 */
    var items = Array.isArray(st.items) ? st.items.filter(function (i) {
      return i && typeof i === 'object' && i.id && i.hasUpdate !== false;
    }).map(normalizeEntry) : [];
    /* Older hosts do not send `entries`; fall back to an empty inventory. */
    var entries = Array.isArray(st.entries) ? st.entries.filter(function (e) {
      return e && typeof e === 'object' && (e.id || e.name);
    }).map(normalizeEntry) : [];
    var out = {
      ok: st.ok !== false,
      phase: typeof st.phase === 'string' ? st.phase : 'idle',
      error: st.error ? String(st.error) : null,
      checkedAt: st.checkedAt || null,
      minReleaseAgeHours: st.minReleaseAgeHours,
      host: st.host || {},
      items: items,
      skipped: Array.isArray(st.skipped) ? st.skipped : [],
      entries: entries
    };
    /* 计数只认真正会渲染出来的行,宿主自报的 updateCount 不再参与判断。 */
    out.updateCount = out.items.length;
    if (st.ok === false) { out.phase = 'error'; }
    if (out.phase === 'error' && !out.error) { out.error = '检查更新时发生未知错误。'; }
    return out;
  }

  function getItems(st) {
    return (st && Array.isArray(st.items)) ? st.items : [];
  }

  function getEntries(st) {
    return (st && Array.isArray(st.entries)) ? st.entries : [];
  }

  /* update rows first, then current, then skipped; stable within a group. */
  var ENTRY_ORDER = { update: 0, current: 1, skipped: 2 };

  function sortEntries(list) {
    return (Array.isArray(list) ? list.slice() : []).sort(function (a, b) {
      var ra = ENTRY_ORDER[a.status];
      var rb = ENTRY_ORDER[b.status];
      if (ra === undefined) { ra = 1; }
      if (rb === undefined) { rb = 1; }
      if (ra !== rb) { return ra - rb; }

      var ka = (a.kind === 'skill') ? 1 : 0;
      var kb = (b.kind === 'skill') ? 1 : 0;
      if (ka !== kb) { return ka - kb; }

      var sa = a.scope || '';
      var sb = b.scope || '';
      if (sa !== sb) { return sa < sb ? -1 : 1; }

      var na = a.name || '';
      var nb = b.name || '';
      if (na !== nb) { return na < nb ? -1 : 1; }
      return 0;
    });
  }

  /* 只数真正会渲染成勾选行的项,保证标题/底栏/正文永远一致。 */
  function countItems(st) {
    return getItems(st).length;
  }

  function seedSelection(st) {
    getItems(st).forEach(function (item) {
      if (state.selected[item.id] === undefined) { state.selected[item.id] = true; }
    });
    /* An inventory row reported as `update` is selectable too. */
    getEntries(st).forEach(function (entry) {
      if (entry.status === 'update' && state.selected[entry.id] === undefined) {
        state.selected[entry.id] = true;
      }
    });
  }

  function selectedIds() {
    return getItems(state.status).filter(function (item) {
      return state.selected[item.id] !== false;
    }).map(function (item) {
      return item.id;
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM scaffolding
   * ------------------------------------------------------------------ */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRoot() {
    var root = document.getElementById(ROOT_ID);
    if (root) {
      if (root.__dshSkillUpdater) { return root; }
      if (root.parentNode) { root.parentNode.removeChild(root); }
    }
    /* document.body 还没出现:交给 boot() 重试,这里不抛错。 */
    if (!document.body) { return null; }
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.__dshSkillUpdater = true;
    document.body.appendChild(root);
    return root;
  }

  function ensureModal() {
    if (ui.backdrop) { return; }
    if (!state.root) { state.root = ensureRoot(); }
    var root = state.root;
    /* 仍然没有 body:静默返回,open() 不会因此抛错。 */
    if (!root) { return; }

    /* 上一次注入脚本如果中途失败,root 里可能留着一个孤儿 backdrop:先清掉。 */
    for (var i = root.children.length - 1; i >= 0; i--) {
      var orphan = root.children[i];
      if (orphan && String(orphan.className).indexOf('dsuc-backdrop') !== -1) {
        root.removeChild(orphan);
      }
    }

    var backdrop = el('div', 'dsuc-backdrop');
    backdrop.hidden = true;

    var modal = el('div', 'dsuc-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'DSH 更新中心');
    modal.tabIndex = -1;

    var head = el('div', 'dsuc-head');
    var headMain = el('div', 'dsuc-head-main');
    var title = el('h2', 'dsuc-title', 'DSH 更新中心');
    var sub = el('div', 'dsuc-sub');
    sub.hidden = true;
    headMain.appendChild(title);
    headMain.appendChild(sub);

    var closeX = el('button', 'dsuc-x', '×');
    closeX.type = 'button';
    closeX.setAttribute('aria-label', '关闭');
    closeX.addEventListener('click', safely(function () { closeModal(true); }));

    head.appendChild(headMain);
    head.appendChild(closeX);
    modal.appendChild(head);

    var body = el('div', 'dsuc-body');
    modal.appendChild(body);

    var foot = el('div', 'dsuc-foot');
    modal.appendChild(foot);

    /* 读屏播报区:进度 / 结果 / 错误只在这里更新,避免整块正文反复被念。 */
    var live = el('div', 'dsuc-sr');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    modal.appendChild(live);

    backdrop.appendChild(modal);
    backdrop.addEventListener('click', safely(function (ev) {
      if (ev.target === backdrop) { closeModal(true); }
    }));
    root.appendChild(backdrop);

    ui.backdrop = backdrop;
    ui.modal = modal;
    ui.title = title;
    ui.sub = sub;
    ui.body = body;
    ui.foot = foot;
    ui.live = live;
    ui.primary = null;
  }

  /* ------------------------------------------------------------------ *
   * Pill —— 已按需求移除
   * 左下角那个「更新中心 / N 项可更新」胶囊会和 DSH 桌面端自带的「更多」控件重叠,
   * 所以这里不再创建任何 DOM,也不再保留任何胶囊状态。
   * 面板本身每次启动会自动弹出一次;关闭后本次会话不再自动弹出,
   * 需要时可用 dshSkillUpdater.open() 重新打开。
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Modal open / close
   * ------------------------------------------------------------------ */

  function onKeyDown(ev) {
    if (ev.key !== 'Escape' && ev.key !== 'Esc') { return; }
    if (!state.modalOpen) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    if (state.view === 'progress') { return; }  /* do not abandon a running job */
    closeModal(true);
  }

  function focusPrimary() {
    var target = (ui.primary && !ui.primary.disabled) ? ui.primary : ui.modal;
    try { if (target && target.focus) { target.focus(); } } catch (e) { /* ignore */ }
  }

  function openModal() {
    try {
      ensureModal();
      /* 还没有 document.body(或初始化未完成):什么都不做,绝不抛错。 */
      if (!ui.backdrop) { return; }
      state.modalOpen = true;
      if (state.view !== 'progress' && state.view !== 'done') { state.view = 'list'; }
      ui.backdrop.hidden = false;
      renderModal();
      try { state.prevFocus = document.activeElement; } catch (e) { /* ignore */ }
      document.addEventListener('keydown', onKeyDown, true);
      setTimeout(function () { try { focusPrimary(); } catch (e) { /* ignore */ } }, 0);
    } catch (err) {
      try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
    }
  }

  function closeModal(recordDismiss) {
    try {
      if (!ui.backdrop || ui.backdrop.hidden) { return; }
      if (state.view === 'progress') { return; }
      ui.backdrop.hidden = true;
      state.modalOpen = false;
      document.removeEventListener('keydown', onKeyDown, true);

      /* 用户主动关闭(稍后 / × / Esc / 点背景):本次会话不再自动弹出,
       * 无论当时处于哪个阶段 —— 正处于 checking 时更要记下来。 */
      if (recordDismiss !== false) {
        state.closed = true;
        writeClosed();
      }

      state.view = 'list';
      state.job = null;
      state.inlineError = null;

      try {
        if (state.prevFocus && state.prevFocus.focus) { state.prevFocus.focus(); }
      } catch (e) { /* ignore */ }
      state.prevFocus = null;
    } catch (err) {
      try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function renderModal() {
    try {
      if (!ui.backdrop || ui.backdrop.hidden) { return; }
      renderHead();
      renderBody();
      renderFoot();
      renderLive();
    } catch (err) {
      try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
    }
  }

  /* 把当前状态压缩成一句话给读屏软件(视觉上隐藏,不重复正文)。 */
  function renderLive() {
    if (!ui.live) { return; }
    var text = '';
    if (state.view === 'progress') {
      var steps = (state.job && Array.isArray(state.job.steps)) ? state.job.steps : [];
      if (!steps.length) {
        text = '正在应用更新';
      } else {
        var settled = 0;
        steps.forEach(function (s) {
          if (s && (s.status === 'ok' || s.status === 'failed' || s.status === 'skipped')) { settled++; }
        });
        text = '正在应用更新：已完成 ' + settled + '/' + steps.length + ' 项';
      }
    } else if (state.view === 'done') {
      var sum = state.summary || { ok: 0, failed: 0 };
      text = '已更新 ' + sum.ok + ' 项，' + sum.failed + ' 项失败';
    } else {
      var st = state.status || {};
      if (st.phase === 'checking') {
        text = '正在检查更新';
      } else if (st.phase === 'error') {
        text = st.error ? String(st.error) : '检查更新失败';
      }
    }
    ui.live.textContent = text;
  }

  function renderHead() {
    var st = state.status || {};
    var n = countItems(st);

    if (state.view === 'progress') {
      ui.title.textContent = '正在应用更新';
    } else if (state.view === 'done') {
      ui.title.textContent = '更新完成';
    } else if (st.phase === 'checking') {
      ui.title.textContent = '正在检查更新…';
    } else if (st.phase === 'error') {
      ui.title.textContent = '检查更新失败';
    } else if (st.phase === 'ready' && n === 0) {
      ui.title.textContent = '插件与 Skill 版本';
    } else {
      ui.title.textContent = '发现 ' + n + ' 项可更新';
    }

    var host = st.host || {};
    var parts = [];
    if (host.profileName) { parts.push('profile: ' + host.profileName); }
    if (st.checkedAt) { parts.push('检查时间 ' + fmtTime(st.checkedAt)); }
    if (parts.length) {
      ui.sub.textContent = parts.join(' · ');
      ui.sub.hidden = false;
    } else {
      ui.sub.textContent = '';
      ui.sub.hidden = true;
    }
  }

  function renderBody() {
    clear(ui.body);
    if (state.view === 'progress') { renderProgressView(); return; }
    if (state.view === 'done') { renderDoneView(); return; }

    var st = state.status || {};

    if (st.phase === 'checking') {
      var box = el('div', 'dsuc-empty');
      box.appendChild(document.createTextNode('正在检查更新'));
      box.appendChild(dotsNode());
      ui.body.appendChild(box);
      return;
    }

    if (st.phase === 'error') {
      ui.body.appendChild(el('div', 'dsuc-empty dsuc-empty-err',
        st.error ? String(st.error) : '检查更新失败，请稍后重试。'));
      return;
    }

    var items = getItems(st);
    /* Same notion of "nothing to update" as the header and the footer. */
    if (st.phase === 'ready' && countItems(st) === 0) {
      ui.body.appendChild(buildInventory(st));
      return;
    }

    if (!items.length) {
      ui.body.appendChild(el('div', 'dsuc-empty', '当前没有可用更新。'));
    } else {
      items.forEach(function (item) {
        ui.body.appendChild(buildRow(item));
      });
    }

    var skipped = buildSkipped(st);
    if (skipped) { ui.body.appendChild(skipped); }
  }

  /* Nothing to update: green banner + the full plugin/Skill inventory,
   * so the current version of everything stays visible. */
  function buildInventory(st) {
    var wrap = el('div', 'dsuc-inventory');
    wrap.appendChild(el('div', 'dsuc-ok-banner', '全部已是最新 · 无需更新'));

    var entries = getEntries(st);
    if (!entries.length) {
      /* older host without `entries`: keep the previous empty state */
      wrap.appendChild(el('div', 'dsuc-empty', '当前没有可用更新。'));
      var skipped = buildSkipped(st);
      if (skipped) { wrap.appendChild(skipped); }
      return wrap;
    }

    /* 这里是「没有可更新项」的视图:一律渲染成清单行,不放勾选框,
     * 免得坏数据在绿色横幅里画出无法提交的复选框。 */
    sortEntries(entries).forEach(function (entry) {
      wrap.appendChild(buildEntryRow(entry));
    });
    return wrap;
  }

  function versionSpan(installed, available) {
    var ver = el('span', 'dsuc-ver');
    var cur = installed ? String(installed) : '?';
    if (available && String(available) !== cur) {
      ver.appendChild(document.createTextNode(cur));
      ver.appendChild(document.createTextNode(' → '));
      ver.appendChild(el('strong', 'dsuc-new', String(available)));
    } else {
      ver.appendChild(document.createTextNode(cur));
    }
    return ver;
  }

  function buildEntryRow(entry) {
    var row = el('div', 'dsuc-entry');

    var isSkill = entry.kind === 'skill';
    var badge = el('span', 'dsuc-badge ' + (isSkill ? 'dsuc-badge-skill' : 'dsuc-badge-plugin'));
    badge.textContent = isSkill ? 'Skill' : '插件';
    row.appendChild(badge);

    var main = el('div', 'dsuc-main');
    var line = el('div', 'dsuc-line');
    if (entry.scope) {
      line.appendChild(el('span', 'dsuc-scope', entry.scope));
    }
    line.appendChild(el('span', 'dsuc-name', entry.name || entry.id || '未知'));

    if (entry.status === 'skipped') {
      line.appendChild(el('span', 'dsuc-mark dsuc-mark-skip', '— 已跳过'));
      line.appendChild(versionSpan(entry.installed, null));
    } else if (entry.status === 'update') {
      /* 理论上进不了清单视图(有 update 项就会走更新列表),坏数据下如实标注。 */
      line.appendChild(el('span', 'dsuc-mark dsuc-mark-ok', '↑ 有可用更新'));
      line.appendChild(versionSpan(entry.installed, entry.available));
    } else {
      line.appendChild(el('span', 'dsuc-mark dsuc-mark-ok', '✓ 已是最新'));
      line.appendChild(versionSpan(entry.installed, entry.available));
    }

    main.appendChild(line);
    if (entry.note) {
      main.appendChild(el('div', 'dsuc-note', entry.note));
    }
    row.appendChild(main);
    return row;
  }

  function buildRow(item) {
    var row = el('label', 'dsuc-row');

    var cb = el('input', 'dsuc-check');
    cb.type = 'checkbox';
    cb.checked = state.selected[item.id] !== false;
    cb.setAttribute('aria-label', (item.name || item.id));
    cb.addEventListener('change', safely(function () {
      state.selected[item.id] = cb.checked;
      renderFoot();
    }));
    row.appendChild(cb);

    var isSkill = item.kind === 'skill';
    var badge = el('span', 'dsuc-badge ' + (isSkill ? 'dsuc-badge-skill' : 'dsuc-badge-plugin'));
    badge.textContent = isSkill ? 'Skill' : '插件';
    row.appendChild(badge);

    var main = el('div', 'dsuc-main');

    var line = el('div', 'dsuc-line');
    line.appendChild(el('span', 'dsuc-name', item.name || item.id));
    line.appendChild(versionSpan(item.installed, item.available));

    main.appendChild(line);
    if (item.note) {
      main.appendChild(el('div', 'dsuc-note', item.note));
    }
    row.appendChild(main);
    return row;
  }

  function buildSkipped(st) {
    var list = st && Array.isArray(st.skipped) ? st.skipped : [];
    if (!list.length) { return null; }

    var det = el('details', 'dsuc-skipped');
    det.open = !!state.skippedOpen;
    det.addEventListener('toggle', safely(function () { state.skippedOpen = det.open; }));
    det.appendChild(el('summary', null, '已跳过 ' + list.length + ' 项（未发布 / 本地来源）'));

    list.forEach(function (sk) {
      var name = (sk && (sk.name || sk.id)) ? String(sk.name || sk.id) : '未知';
      var reason = (sk && sk.reason) ? String(sk.reason) : '';
      det.appendChild(el('div', 'dsuc-skip-row', reason ? (name + ' — ' + reason) : name));
    });
    return det;
  }

  function renderSteps(job) {
    var steps = (job && Array.isArray(job.steps)) ? job.steps : [];
    if (!steps.length) {
      return el('div', 'dsuc-empty', '正在开始更新…');
    }
    var wrap = el('div', 'dsuc-steps');
    steps.forEach(function (step) {
      var status = step && step.status ? String(step.status) : 'pending';
      var glyph = status === 'ok' ? '✓'
        : status === 'failed' ? '✗'
          : status === 'skipped' ? '—'
            : '⏳';

      var row = el('div', 'dsuc-step dsuc-step-' + status);
      row.appendChild(el('span', 'dsuc-glyph', glyph));

      var main = el('div', 'dsuc-step-main');
      main.appendChild(el('div', 'dsuc-step-label', (step && (step.label || step.id)) || ''));
      if (step && step.message) {
        main.appendChild(el('div', 'dsuc-step-msg', step.message));
      }
      row.appendChild(main);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function appendLog(parent, job) {
    var log = (job && Array.isArray(job.log)) ? job.log : [];
    if (!log.length) { return; }

    var det = el('details', 'dsuc-log');
    det.open = !!state.logOpen;
    det.addEventListener('toggle', safely(function () { state.logOpen = det.open; }));
    det.appendChild(el('summary', null, '日志（' + log.length + ' 行）'));

    var lines = log.slice(-MAX_LOG_LINES);
    var pre = el('pre', null, lines.join('\n'));
    det.appendChild(pre);
    parent.appendChild(det);

    setTimeout(function () {
      try { pre.scrollTop = pre.scrollHeight; } catch (e) { /* ignore */ }
    }, 0);
  }

  function renderProgressView() {
    var job = state.job;
    ui.body.appendChild(renderSteps(job));
    appendLog(ui.body, job);
  }

  function renderDoneView() {
    var s = state.summary || { ok: 0, failed: 0, restart: false, error: null };

    var summary = el('div', 'dsuc-summary ' + (s.failed > 0 ? 'dsuc-summary-bad' : 'dsuc-summary-ok'));
    summary.textContent = '已更新 ' + s.ok + ' 项，' + s.failed + ' 项失败';
    ui.body.appendChild(summary);

    if (s.error) {
      ui.body.appendChild(el('div', 'dsuc-note dsuc-note-err', s.error));
    }
    if (s.restart) {
      ui.body.appendChild(el('div', 'dsuc-warn', '插件升级需要重启 DSH 才会生效。'));
    }

    ui.body.appendChild(renderSteps(state.job));
    appendLog(ui.body, state.job);
  }

  /* 页脚每次重建都会丢焦点:渲染前记住焦点在哪个按钮上(按 data-dsuc 标记),
   * 渲染后把焦点还回去;按钮文字会变(例如「更新选中 (2)」),所以不能用文字匹配。 */
  function focusedFootKey() {
    try {
      var active = document.activeElement;
      if (!active || !ui.foot || !active.getAttribute) { return null; }
      if (String(active.tagName || '').toUpperCase() !== 'BUTTON') { return null; }
      var key = active.getAttribute('data-dsuc');
      if (!key) { return null; }
      for (var p = active.parentNode; p; p = p.parentNode) {
        if (p === ui.foot) { return key; }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function findFootButton(node, key) {
    if (!node) { return null; }
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (String(child.tagName || '').toUpperCase() === 'BUTTON' && child.getAttribute &&
          child.getAttribute('data-dsuc') === key) {
        return child;
      }
      var hit = findFootButton(child, key);
      if (hit) { return hit; }
    }
    return null;
  }

  function renderFoot() {
    var focusKey = focusedFootKey();
    buildFoot();
    if (!focusKey) { return; }
    var again = findFootButton(ui.foot, focusKey);
    if (again && !again.disabled) {
      try { again.focus(); } catch (e) { /* ignore */ }
    }
  }

  function buildFoot() {
    clear(ui.foot);
    ui.primary = null;

    if (state.inlineError) {
      ui.foot.appendChild(el('div', 'dsuc-err-line', state.inlineError));
    }

    if (state.view === 'progress') {
      ui.foot.appendChild(el('div', 'dsuc-hint', '更新进行中，请保持页面打开…'));
      return;
    }

    if (state.view === 'done') {
      var closeBtn = el('button', 'dsuc-btn dsuc-btn-primary', '关闭');
      closeBtn.type = 'button';
      closeBtn.setAttribute('data-dsuc', 'close');
      closeBtn.addEventListener('click', safely(function () { closeModal(true); }));
      ui.foot.appendChild(closeBtn);
      ui.primary = closeBtn;
      return;
    }

    var st = state.status || {};
    var ready = st.phase === 'ready';
    var pending = countItems(st);
    var picked = selectedIds().length;

    var recheck = el('button', 'dsuc-btn', '重新检查');
    recheck.type = 'button';
    recheck.setAttribute('data-dsuc', 'recheck');
    recheck.disabled = st.phase === 'checking';
    recheck.addEventListener('click', safely(function () { onRecheck(); }));

    /* Nothing to update: no primary action, just re-check and close. */
    if (ready && pending === 0) {
      var done = el('button', 'dsuc-btn dsuc-btn-plain', '关闭');
      done.type = 'button';
      done.setAttribute('data-dsuc', 'close');
      done.addEventListener('click', safely(function () { closeModal(true); }));
      ui.foot.appendChild(recheck);
      ui.foot.appendChild(done);
      return;
    }

    var primary = el('button', 'dsuc-btn dsuc-btn-primary', '更新选中 (' + picked + ')');
    primary.type = 'button';
    primary.setAttribute('data-dsuc', 'primary');
    primary.disabled = !ready || picked === 0;
    primary.addEventListener('click', safely(function () { onApply(); }));

    var later = el('button', 'dsuc-btn dsuc-btn-plain', '稍后');
    later.type = 'button';
    later.setAttribute('data-dsuc', 'later');
    later.addEventListener('click', safely(function () { closeModal(true); }));

    ui.foot.appendChild(primary);
    ui.foot.appendChild(recheck);
    ui.foot.appendChild(later);
    ui.primary = primary;
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  function onRecheck() {
    state.inlineError = null;
    state.status = Object.assign({}, state.status || {}, { phase: 'checking', error: null });
    renderModal();

    httpJson('POST', BASE + '/recheck').then(function () {
      return httpJson('GET', BASE + '/status.json');
    }).then(function (data) {
      state.statusFailures = 0;
      applyStatus(data);
    }).catch(function (err) {
      /* 失败也要回到可用状态:直接进入 error 阶段,「重新检查」立刻可以再点。 */
      applyStatus({ ok: false, phase: 'error', error: friendlyError(err, '重新检查失败') });
    });
  }

  function onApply() {
    if (state.applying) { return; }
    var ids = selectedIds();
    if (!ids.length) { return; }

    /* httpJson 会在同步阶段调用 fetch,所以先建 promise:它抛错时不能先切到进度视图,
     * 否则面板会卡在一个关不掉、也没有轮询的 progress 视图里。 */
    var request;
    try {
      request = httpJson('POST', BASE + '/apply', { ids: ids });
    } catch (err) {
      state.inlineError = friendlyError(err, '应用更新失败');
      renderModal();
      return;
    }

    state.applying = true;
    state.inlineError = null;
    state.view = 'progress';
    state.job = null;
    renderModal();

    request.then(function (res) {
      if (!res || res.ok === false) {
        throw new Error((res && res.error) ? String(res.error) : '应用更新失败');
      }
      startJobPolling();
    }).catch(function (err) {
      state.applying = false;
      state.view = 'list';
      state.inlineError = friendlyError(err, '应用更新失败');
      renderModal();
    });
  }

  function startJobPolling() {
    stopJobPolling();
    state.jobPolls = 0;
    pollJob();
    state.jobTimer = setInterval(function () {
      try {
        pollJob();
      } catch (err) {
        /* 同步抛错(例如 fetch 不可用)也必须把面板放回可用状态。 */
        stopJobPolling();
        state.applying = false;
        state.view = 'list';
        state.inlineError = friendlyError(err, '读取更新进度失败');
        renderModal();
      }
    }, POLL_MS);
  }

  function stopJobPolling() {
    if (state.jobTimer) {
      clearInterval(state.jobTimer);
      state.jobTimer = null;
    }
  }

  function pollJob() {
    state.jobPolls++;
    if (state.jobPolls > MAX_JOB_POLLS) {
      stopJobPolling();
      state.applying = false;
      state.view = 'done';
      state.summary = state.summary || { ok: 0, failed: 0, restart: false, error: null };
      state.inlineError = '更新任务长时间未返回结果，已停止跟踪。';
      renderModal();
      return;
    }

    httpJson('GET', BASE + '/job.json').then(function (data) {
      var job = (data && data.job) ? data.job : null;
      if (!job) { return; }  /* no job yet — keep polling */
      state.job = job;
      renderModal();
      if (job.finished) { onJobFinished(job); }
    }).catch(function (err) {
      stopJobPolling();
      state.applying = false;
      state.view = 'list';
      state.inlineError = friendlyError(err, '读取更新进度失败');
      renderModal();
    });
  }

  function onJobFinished(job) {
    try {
      stopJobPolling();
      state.applying = false;
      state.view = 'done';
      state.job = job;

      var steps = (job && Array.isArray(job.steps)) ? job.steps : [];
      var okCount = 0;
      var failCount = 0;
      steps.forEach(function (s) {
        if (s && s.status === 'ok') { okCount++; }
        if (s && s.status === 'failed') { failCount++; }
      });

      state.summary = {
        ok: okCount,
        failed: failCount,
        restart: !!(job && job.restartRequired),
        error: (job && job.error) ? String(job.error) : null
      };
      renderModal();

      /* Refresh status so the list reflects reality after the run. */
      return httpJson('GET', BASE + '/status.json').then(function (data) {
        state.status = normalizeStatus(data);
        state.selected = Object.create(null);
        seedSelection(state.status);
      }).catch(function () { /* keep the previous status */ });
    } catch (err) {
      try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ *
   * Status loading & polling
   * ------------------------------------------------------------------ */

  /* 宿主检查更新要走网络,可能长时间停在 checking(10s+ 甚至更久),
   * 所以「成功返回 checking」不计入上限;只有连续请求失败才计数。
   * 另外用 10 分钟看门狗兜底「宿主永远停在 checking」。
   * 无论哪条路径触发,都会落到可见的 error 状态,绝不静默停止轮询。 */
  function statusTick() {
    if (state.statusSince && (Date.now() - state.statusSince) > STATUS_WATCHDOG_MS) {
      tripStatusError('检查更新耗时过长（超过 10 分钟），已停止自动刷新。可点「重新检查」重试。');
      return;
    }
    httpJson('GET', BASE + '/status.json').then(function (data) {
      state.statusFailures = 0;
      applyStatus(data);
    }).catch(function (err) {
      state.statusFailures++;
      if (state.statusFailures >= MAX_STATUS_FAILURES) {
        tripStatusError(friendlyError(err, '检查更新失败') +
          '（已连续失败 ' + state.statusFailures + ' 次，已停止自动刷新）');
      }
    });
  }

  function startStatusPolling() {
    if (state.statusTimer) { return; }
    state.statusFailures = 0;
    state.statusSince = Date.now();
    state.statusTimer = setInterval(function () { safely(statusTick)(); }, POLL_MS);
  }

  function stopStatusPolling() {
    if (state.statusTimer) {
      clearInterval(state.statusTimer);
      state.statusTimer = null;
    }
    state.statusFailures = 0;
    state.statusSince = 0;
  }

  /* 轮询失败或超时后统一落到可见的 error 状态,保留 host / checkedAt 用于副标题。 */
  function tripStatusError(message) {
    applyStatus(Object.assign({}, state.status || {}, { ok: false, phase: 'error', error: message }));
  }

  /* Ready: show the update list, or — once per browser session — the full
   * inventory even when nothing needs updating.
   *
   * Rationale: a DSH restart / reopening the desktop client starts a fresh
   * browser session, so the panel shows once per launch; a plain F5 keeps the
   * same sessionStorage, so it does not nag on every refresh.
   * 用户主动关闭过面板之后,本次会话一律不再自动弹出。 */
  function handleReady(st) {
    if (state.closed || readClosed()) { return; }
    if (state.modalOpen) { return; }

    var n = countItems(st);
    if (n > 0) {
      writeShown();
      openModal();
      return;
    }

    /* Nothing to update: open the panel anyway, but only once per session. */
    if (!readShown()) {
      writeShown();
      openModal();
      return;
    }

    logOnce('no-updates', '[dsh-skill-updater] 当前没有可用更新。');
  }

  /* 检查失败不能是静默的(胶囊按钮已移除,没有别的提示面):
   * 本会话还没弹过面板、用户也没关闭过时,自动打开错误面板。 */
  function maybeOpenError() {
    if (state.modalOpen) { return; }
    if (state.closed || readClosed()) { return; }
    if (readShown()) { return; }
    writeShown();
    openModal();
  }

  function applyStatus(raw) {
    try {
      var st = normalizeStatus(raw);
      state.status = st;
      state.selected = Object.create(null);
      seedSelection(st);

      if (st.phase === 'checking') {
        startStatusPolling();
      } else {
        stopStatusPolling();
      }

      if (state.modalOpen) { renderModal(); }

      if (st.phase === 'ready') {
        handleReady(st);
      } else if (st.phase === 'error') {
        maybeOpenError();
      }
    } catch (err) {
      try { console.error('[dsh-skill-updater]', err); } catch (e) { /* ignore */ }
    }
  }

  function loadStatus() {
    return httpJson('GET', BASE + '/status.json').then(function (data) {
      applyStatus(data);
    }).catch(function (err) {
      applyStatus({
        ok: false,
        phase: 'error',
        error: (err && err.message) ? String(err.message) : '检查更新失败'
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    var tries = 0;
    var started = false;

    /* 初始化最终失败:清掉注入标记,让之后再注入一次脚本还能重试。 */
    function giveUp(message) {
      try { console.warn('[dsh-skill-updater] ' + message); } catch (e) { /* ignore */ }
      try { window[INJECT_FLAG] = false; } catch (e) { /* ignore */ }
    }

    function attempt() {
      if (started) { return; }
      if (!document.body) {
        tries++;
        if (tries < 40) { setTimeout(attempt, 150); return; }
        giveUp('未找到 document.body，已放弃初始化。');
        return;
      }
      started = true;
      try {
        ensureStyle();
        state.root = ensureRoot();
        ensureModal();
        loadStatus();
      } catch (err) {
        giveUp('初始化失败：' + friendlyError(err));
      }
    }

    if (document.body) {
      attempt();
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { attempt(); }, { once: true });
      setTimeout(attempt, 400);
    } else {
      attempt();
    }
  }

  // 手动入口:在浏览器控制台执行 dshSkillUpdater.open() 可随时打开面板(即使当前没有更新)
  try {
    window.dshSkillUpdater = {
      open: function () { try { openModal(); } catch (e) {} },
      close: function () { try { closeModal(false); } catch (e) {} },
      check: function () { return loadStatus(); },
      status: function () { return httpJson('GET', BASE + '/status.json'); },
    };
  } catch (e) {}

  boot();
})();

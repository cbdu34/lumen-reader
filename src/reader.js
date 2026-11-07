/**
 * Lumen — the reader overlay.
 *
 * Injected on demand by the service worker (`chrome.scripting.executeScript`),
 * after `src/extract.js`. Everything lives in a shadow root so the page cannot
 * style it, and a guard makes repeated injection a no-op.
 */
(function () {
  'use strict';

  if (window.__lumenReaderLoaded) return;
  window.__lumenReaderLoaded = true;

  var HOST_ID = 'lumen-reader-root';
  var DEFAULT_SETTINGS = { theme: 'sepia', fontSize: 19, measure: 68 };
  var THEMES = ['sepia', 'light', 'dark'];
  var FONT_MIN = 15;
  var FONT_MAX = 30;
  var MEASURE_MIN = 44;
  var MEASURE_MAX = 92;

  var host = null;
  var shadow = null;
  var panel = null;
  var current = null;
  var saved = null;
  var saveTimer = 0;
  var settings = Object.assign({}, DEFAULT_SETTINGS);

  /* ---------------------------------------------------------------- *
   * Messaging
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener(function (message, _sender, respond) {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === 'LUMEN_PING') {
      respond({ ok: true, open: Boolean(host) });
      return undefined;
    }

    if (message.type === 'LUMEN_TOGGLE') {
      toggle().then(
        function (open) { respond({ ok: true, open: open }); },
        function (error) { respond({ ok: false, error: String((error && error.message) || error) }); }
      );
      return true;
    }

    return undefined;
  });

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  function sanitizeSettings(raw) {
    var source = raw || {};
    var theme = THEMES.indexOf(source.theme) >= 0 ? source.theme : DEFAULT_SETTINGS.theme;
    var fontSize = Number(source.fontSize);
    var measure = Number(source.measure);
    if (!isFinite(fontSize)) fontSize = DEFAULT_SETTINGS.fontSize;
    if (!isFinite(measure)) measure = DEFAULT_SETTINGS.measure;
    return {
      theme: theme,
      fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(fontSize))),
      measure: Math.min(MEASURE_MAX, Math.max(MEASURE_MIN, Math.round(measure)))
    };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        chrome.storage.sync.set(settings);
      } catch (error) {
        /* Sync storage can be unavailable — the reader still works. */
      }
    }, 250);
  }

  function applySettings() {
    if (!panel) return;
    panel.setAttribute('data-theme', settings.theme);
    panel.style.setProperty('--fs', settings.fontSize + 'px');
    panel.style.setProperty('--measure', String(settings.measure));
  }

  /* ---------------------------------------------------------------- *
   * Open / close
   * ---------------------------------------------------------------- */

  function toggle() {
    if (host) {
      close();
      return Promise.resolve(false);
    }
    return open();
  }

  function open() {
    var engine = globalThis.LumenExtract;
    if (!engine) {
      notify('Lumen could not load its extraction engine.');
      return Promise.resolve(false);
    }

    var reading = chrome.storage.sync.get(DEFAULT_SETTINGS);
    if (!reading || typeof reading.then !== 'function') {
      reading = Promise.resolve(DEFAULT_SETTINGS);
    }

    return reading
      .catch(function () { return DEFAULT_SETTINGS; })
      .then(function (stored) {
        settings = sanitizeSettings(stored);

        var data = null;
        try {
          data = engine.extract(document);
        } catch (error) {
          data = null;
        }
        if (!data) {
          notify('Nothing readable here — Lumen could not find an article on this page.');
          return false;
        }

        current = data;
        mount(data);
        return true;
      });
  }

  function close() {
    if (!host) return;
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
    host = null;
    shadow = null;
    panel = null;
    current = null;
    clearTimeout(saveTimer);

    if (saved) {
      document.documentElement.style.overflow = saved.htmlOverflow;
      if (document.body) document.body.style.overflow = saved.bodyOverflow;
      if (saved.scroll > 0) window.scrollTo(0, saved.scroll);
      saved = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Mounting
   * ---------------------------------------------------------------- */

  function mount(data) {
    saved = {
      htmlOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body ? document.body.style.overflow : '',
      scroll: window.scrollY
    };

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-lumen', 'reader');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');

    shadow = host.attachShadow({ mode: 'open' });
    adoptStyles(shadow);

    var template = document.createElement('template');
    template.innerHTML = SHELL_HTML;
    shadow.appendChild(template.content.cloneNode(true));

    panel = shadow.querySelector('.shell');
    panel.style.setProperty('--fs', settings.fontSize + 'px');
    panel.setAttribute('data-theme', settings.theme);

    var titleEl = shadow.querySelector('.doc-title');
    var metaEl = shadow.querySelector('.doc-meta');
    var bodyEl = shadow.querySelector('.doc-body');
    var siteEl = shadow.querySelector('.chip-site');
    var timeEl = shadow.querySelector('.chip-time');

    titleEl.textContent = data.title;

    var meta = [];
    if (data.byline) meta.push(data.byline);
    if (data.siteName) meta.push(data.siteName);
    if (data.readingMinutes) meta.push(data.readingMinutes + ' min read');
    metaEl.textContent = meta.join(' \u00b7 ');

    if (data.siteName) siteEl.textContent = data.siteName;
    else siteEl.remove();
    if (data.readingMinutes) timeEl.textContent = data.readingMinutes + ' min';
    else timeEl.remove();

    bodyEl.innerHTML = data.contentHtml;

    /* Progress bar. */
    var scroller = shadow.querySelector('.scroll');
    var bar = shadow.querySelector('.progress > i');
    var updateProgress = function () {
      var max = scroller.scrollHeight - scroller.clientHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0;
      bar.style.setProperty('width', (ratio * 100).toFixed(2) + '%');
    };
    scroller.addEventListener('scroll', updateProgress, { passive: true });
    setTimeout(updateProgress, 30);

    /* Clicks. */
    shadow.addEventListener('click', function (event) {
      var node = event.target;
      var actionNode = node && node.closest ? node.closest('[data-act]') : null;
      if (!actionNode) return;
      event.preventDefault();
      handleAction(actionNode.getAttribute('data-act'));
    });

    /* Keyboard. */
    document.addEventListener('keydown', onKeyDown, true);

    document.documentElement.appendChild(host);
    document.documentElement.style.overflow = 'hidden';
    if (document.body) document.body.style.overflow = 'hidden';

    try {
      panel.focus({ preventScroll: true });
    } catch (error) {
      panel.focus();
    }
    applySettings();
  }

  function adoptStyles(root) {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      root.adoptedStyleSheets = [sheet];
    } catch (error) {
      var style = document.createElement('style');
      style.textContent = STYLES;
      root.appendChild(style);
    }
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  function handleAction(action) {
    switch (action) {
      case 'close':
        close();
        break;
      case 'font-up':
        bumpFont(1);
        break;
      case 'font-down':
        bumpFont(-1);
        break;
      case 'measure':
        settings.measure = settings.measure >= MEASURE_MAX
          ? MEASURE_MIN
          : Math.min(MEASURE_MAX, settings.measure + 8);
        applySettings();
        persist();
        break;
      case 'theme':
        cycleTheme();
        break;
      case 'markdown':
        exportMarkdown();
        break;
      case 'help':
        toggleHelp();
        break;
      default:
        break;
    }
  }

  function bumpFont(delta) {
    settings.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize + delta));
    applySettings();
    persist();
  }

  function cycleTheme() {
    var index = THEMES.indexOf(settings.theme);
    settings.theme = THEMES[(index + 1) % THEMES.length];
    applySettings();
    persist();
  }

  function toggleHelp() {
    var help = shadow && shadow.querySelector('.help');
    if (help) help.classList.toggle('is-open');
  }

  function onKeyDown(event) {
    if (!host) return;
    var inside = event.target === host || host.contains(event.target);
    if (!inside) return;

    var help = shadow && shadow.querySelector('.help');

    switch (event.key) {
      case 'Escape':
        if (help && help.classList.contains('is-open')) {
          help.classList.remove('is-open');
        } else {
          close();
        }
        break;
      case '+':
      case '=':
        bumpFont(1);
        break;
      case '-':
      case '_':
        bumpFont(-1);
        break;
      case 'w':
      case 'W':
        handleAction('measure');
        break;
      case 't':
      case 'T':
        cycleTheme();
        break;
      case 'e':
      case 'E':
        exportMarkdown();
        break;
      case '?':
        toggleHelp();
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  /* ---------------------------------------------------------------- *
   * Export
   * ---------------------------------------------------------------- */

  function exportMarkdown() {
    if (!current || !current.markdown) return;
    var engine = globalThis.LumenExtract;
    var filename = (engine ? engine.slugify(current.title) : 'lumen-article') + '.md';
    var blob = new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' });
    var objectUrl = URL.createObjectURL(blob);

    var link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.style.display = 'none';
    document.documentElement.appendChild(link);
    link.click();

    setTimeout(function () {
      link.remove();
      URL.revokeObjectURL(objectUrl);
    }, 5000);

    flash('Saved ' + filename);
  }

  /* ---------------------------------------------------------------- *
   * Small UI feedback
   * ---------------------------------------------------------------- */

  function flash(text) {
    if (!shadow) return;
    var previous = shadow.querySelector('.toast');
    if (previous) previous.remove();
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    shadow.appendChild(toast);
    setTimeout(function () {
      toast.remove();
    }, 2200);
  }

  /** Feedback that works even when the overlay is not mounted yet. */
  function notify(text) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:26px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'background:#1c1c1a', 'color:#f6f2e8',
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'padding:10px 16px', 'border-radius:999px', 'max-width:86vw',
      'box-shadow:0 10px 30px rgba(0,0,0,.28)', 'pointer-events:none'
    ].join(';');
    document.documentElement.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 2800);
  }

  /* ---------------------------------------------------------------- *
   * Templates
   * ---------------------------------------------------------------- */

  var SVG = 'viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

  var SHELL_HTML =
    '<div class="shell" data-theme="sepia" tabindex="-1">' +
      '<div class="progress"><i></i></div>' +
      '<header class="topbar">' +
        '<span class="brand">' +
          '<svg ' + SVG + '><path d="M10 4.5H6.2A2.2 2.2 0 004 6.7V16h3.8a2.2 2.2 0 012.2 1.6V4.5z"/>' +
          '<path d="M10 4.5h3.8A2.2 2.2 0 0116 6.7V16h-3.8a2.2 2.2 0 00-2.2 1.6V4.5z"/></svg>' +
          '<b>Lumen</b>' +
        '</span>' +
        '<span class="chip chip-site"></span>' +
        '<span class="chip chip-time"></span>' +
        '<span class="spacer"></span>' +
        '<button class="btn" type="button" data-act="font-down" title="Smaller text (\u2212)" aria-label="Smaller text">' +
          '<svg ' + SVG + '><path d="M4 15l4.2-10 4.2 10"/><path d="M5.6 11.6h5.2"/><path d="M15.4 15h3"/></svg>' +
        '</button>' +
        '<button class="btn" type="button" data-act="font-up" title="Larger text (+)" aria-label="Larger text">' +
          '<svg ' + SVG + '><path d="M3.5 15l4-10 4 10"/><path d="M5 11.6h5"/><path d="M15 10.4v4.6"/><path d="M12.7 12.7h4.6"/></svg>' +
        '</button>' +
        '<button class="btn" type="button" data-act="measure" title="Column width (W)" aria-label="Column width">' +
          '<svg ' + SVG + '><path d="M3 10h14"/><path d="M6 7l-3 3 3 3"/><path d="M14 7l3 3-3 3"/></svg>' +
        '</button>' +
        '<button class="btn" type="button" data-act="theme" title="Theme (T)" aria-label="Theme">' +
          '<svg ' + SVG + '><circle cx="10" cy="10" r="6.4"/><path d="M10 3.6a6.4 6.4 0 000 12.8z" fill="currentColor" stroke="none"/></svg>' +
        '</button>' +
        '<button class="btn" type="button" data-act="markdown" title="Export Markdown (E)" aria-label="Export Markdown">' +
          '<svg ' + SVG + '><path d="M10 3v9"/><path d="M6.6 8.6L10 12l3.4-3.4"/><path d="M4 16h12"/></svg>' +
        '</button>' +
        '<button class="btn" type="button" data-act="help" title="Shortcuts (?)" aria-label="Keyboard shortcuts">' +
          '<svg ' + SVG + '><circle cx="10" cy="10" r="7"/><path d="M8.2 8a1.9 1.9 0 113.4 1.2c-.7.8-1.6 1.1-1.6 2.3"/><path d="M10 14.4v.2"/></svg>' +
        '</button>' +
        '<button class="btn btn-close" type="button" data-act="close" title="Close (Esc)" aria-label="Close reader">' +
          '<svg ' + SVG + '><path d="M5.5 5.5l9 9"/><path d="M14.5 5.5l-9 9"/></svg>' +
        '</button>' +
      '</header>' +
      '<div class="scroll">' +
        '<article class="doc">' +
          '<h1 class="doc-title"></h1>' +
          '<p class="doc-meta"></p>' +
          '<div class="doc-body"></div>' +
          '<div class="doc-foot"></div>' +
        '</article>' +
      '</div>' +
      '<div class="help" role="dialog" aria-label="Keyboard shortcuts">' +
        '<dl>' +
          '<dt>Esc</dt><dd>Close the reader</dd>' +
          '<dt>+ / \u2212</dt><dd>Text size</dd>' +
          '<dt>W</dt><dd>Column width</dd>' +
          '<dt>T</dt><dd>Cycle theme</dd>' +
          '<dt>E</dt><dd>Export Markdown</dd>' +
          '<dt>?</dt><dd>Toggle this panel</dd>' +
        '</dl>' +
      '</div>' +
    '</div>';

  var STYLES = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',
    '.shell {',
    '  --fs: 19px; --measure: 68;',
    '  --bg: #f7f1e3; --fg: #2b2419; --muted: #8a7a60; --line: #e4d9c1; --accent: #b4651f;',
    '  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;',
    '  position: fixed; inset: 0; display: flex; flex-direction: column;',
    '  background: var(--bg); color: var(--fg);',
    '  font-family: var(--serif); text-align: left; direction: ltr;',
    '  outline: none; -webkit-font-smoothing: antialiased;',
    '}',
    '.shell[data-theme="light"] { --bg: #fbfbf9; --fg: #191a18; --muted: #6c6d68; --line: #e6e6e0; --accent: #1f6feb; }',
    '.shell[data-theme="dark"]  { --bg: #12130f; --fg: #e9e5da; --muted: #9a9488; --line: #2a2b26; --accent: #e0a45a; }',

    '.progress { height: 2px; background: var(--line); flex: none; }',
    '.progress > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .08s linear; }',

    '.topbar {',
    '  display: flex; align-items: center; gap: 6px; flex: none;',
    '  padding: 9px 14px; border-bottom: 1px solid var(--line);',
    '  font-family: var(--ui); font-size: 12px;',
    '  background: var(--bg); position: relative; z-index: 2;',
    '}',
    '.brand { display: inline-flex; align-items: center; gap: 7px; margin-right: 8px; color: var(--fg); opacity: .92; }',
    '.brand b { font-size: 12.5px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }',
    '.chip {',
    '  display: inline-block; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '  padding: 3px 9px; border-radius: 999px; background: var(--line); color: var(--muted);',
    '  font-size: 11px; line-height: 1.5;',
    '}',
    '.spacer { flex: 1 1 auto; }',

    '.btn {',
    '  appearance: none; -webkit-appearance: none; margin: 0; padding: 0;',
    '  width: 32px; height: 32px; display: grid; place-items: center;',
    '  border: 1px solid transparent; border-radius: 9px;',
    '  background: transparent; color: var(--muted); cursor: pointer;',
    '  font: inherit; transition: color .12s, border-color .12s, background .12s;',
    '}',
    '.btn:hover { color: var(--accent); border-color: var(--line); background: rgba(120,100,70,.06); }',
    '.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }',
    '.btn-close:hover { color: #c0392b; }',

    '.scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }',

    '.doc {',
    '  max-width: calc(var(--measure) * 1ch);',
    '  margin: 0 auto; padding: 54px 26px 40vh;',
    '  font-size: var(--fs); line-height: 1.7;',
    '  hanging-punctuation: first; text-wrap: pretty;',
    '}',
    '.doc-title { font-size: 1.85em; line-height: 1.18; margin: 0 0 .45em; letter-spacing: -.012em; font-weight: 700; }',
    '.doc-meta { color: var(--muted); font-size: .74em; font-family: var(--ui); letter-spacing: .02em; margin: 0 0 2.1em; text-transform: none; }',
    '.doc p { margin: 0 0 1.15em; }',
    '.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 { line-height: 1.28; margin: 1.7em 0 .6em; letter-spacing: -.008em; }',
    '.doc h2 { font-size: 1.34em; }',
    '.doc h3 { font-size: 1.14em; }',
    '.doc h4, .doc h5, .doc h6 { font-size: 1em; }',
    '.doc a { color: var(--accent); text-decoration: underline; text-decoration-thickness: .06em; text-underline-offset: .16em; }',
    '.doc a:hover { text-decoration-thickness: .12em; }',
    '.doc ul, .doc ol { margin: 0 0 1.15em; padding-left: 1.35em; }',
    '.doc li { margin: .38em 0; }',
    '.doc li > p { margin-bottom: .5em; }',
    '.doc blockquote { margin: 1.7em 0; padding: .1em 0 .1em 1.15em; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }',
    '.doc blockquote p:last-child { margin-bottom: 0; }',
    '.doc img { max-width: 100%; height: auto; display: block; margin: 1.7em auto; border-radius: 6px; }',
    '.doc figure { margin: 1.9em 0; }',
    '.doc figcaption { font-size: .76em; color: var(--muted); text-align: center; margin-top: .65em; font-family: var(--ui); }',
    '.doc pre { background: rgba(120,110,90,.12); padding: 14px 16px; border-radius: 9px; overflow-x: auto; font-size: .82em; line-height: 1.55; }',
    '.doc code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }',
    '.doc pre code { font-size: 1em; }',
    '.doc table { width: 100%; border-collapse: collapse; margin: 1.7em 0; font-size: .84em; font-family: var(--ui); }',
    '.doc th, .doc td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }',
    '.doc th { background: rgba(120,110,90,.08); }',
    '.doc hr { border: 0; border-top: 1px solid var(--line); margin: 2.2em 0; }',
    '.doc sup, .doc sub { line-height: 0; }',
    '.doc-foot { margin-top: 3em; }',

    '.help {',
    '  position: absolute; right: 16px; top: 58px; z-index: 3;',
    '  display: none; gap: 0; padding: 14px 18px;',
    '  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;',
    '  box-shadow: 0 18px 48px rgba(0,0,0,.18);',
    '  font-family: var(--ui); font-size: 12px; color: var(--muted);',
    '}',
    '.help.is-open { display: block; }',
    '.help dl { display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; margin: 0; align-items: baseline; }',
    '.help dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--fg); white-space: nowrap; }',
    '.help dd { margin: 0; }',

    '.toast {',
    '  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);',
    '  z-index: 4; padding: 9px 16px; border-radius: 999px;',
    '  background: #1c1c1a; color: #f6f2e8;',
    '  font-family: var(--ui); font-size: 12.5px; line-height: 1.4;',
    '  box-shadow: 0 10px 30px rgba(0,0,0,.28); pointer-events: none;',
    '}',

    '::-webkit-scrollbar { width: 11px; }',
    '::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid var(--bg); }',
    '::-webkit-scrollbar-thumb:hover { background: var(--muted); }',

    '@media (max-width: 720px) {',
    '  .brand b, .chip { display: none; }',
    '  .doc { padding: 30px 20px 45vh; }',
    '  .topbar { padding: 7px 10px; gap: 2px; }',
    '  .btn { width: 30px; height: 30px; }',
    '}',

    '@media (prefers-reduced-motion: reduce) {',
    '  .progress > i, .btn { transition: none; }',
    '}'
  ].join('\n');
})();

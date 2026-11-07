'use strict';

var DEFAULTS = { theme: 'sepia', fontSize: 19, measure: 68 };
var THEMES = ['sepia', 'light', 'dark'];

var el = {
  theme: document.getElementById('theme'),
  fontSize: document.getElementById('fontSize'),
  fontSizeOut: document.getElementById('fontSizeOut'),
  measure: document.getElementById('measure'),
  measureOut: document.getElementById('measureOut'),
  preview: document.getElementById('preview'),
  version: document.getElementById('version'),
  status: document.getElementById('status'),
  reset: document.getElementById('reset'),
  shortcuts: document.getElementById('shortcuts')
};

var statusTimer = 0;

function clamp(value, min, max, fallback) {
  var number = Number(value);
  if (!isFinite(number)) number = fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalize(raw) {
  var source = raw || {};
  return {
    theme: THEMES.indexOf(source.theme) >= 0 ? source.theme : DEFAULTS.theme,
    fontSize: clamp(source.fontSize, 15, 30, DEFAULTS.fontSize),
    measure: clamp(source.measure, 44, 92, DEFAULTS.measure)
  };
}

function render(settings) {
  el.theme.value = settings.theme;
  el.fontSize.value = String(settings.fontSize);
  el.measure.value = String(settings.measure);
  el.fontSizeOut.textContent = settings.fontSize + ' px';
  el.measureOut.textContent = settings.measure + ' ch';
  el.preview.dataset.theme = settings.theme;
  el.preview.style.setProperty('--fs', settings.fontSize + 'px');
  el.preview.style.fontSize = settings.fontSize + 'px';
  el.preview.style.maxWidth = settings.measure + 'ch';
}

function read() {
  return normalize({
    theme: el.theme.value,
    fontSize: el.fontSize.value,
    measure: el.measure.value
  });
}

function save() {
  var settings = read();
  render(settings);
  chrome.storage.sync.set(settings).then(function () {
    status('Saved');
  }).catch(function () {
    status('Could not save');
  });
}

function status(message) {
  el.status.textContent = message;
  el.status.classList.add('is-visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () {
    el.status.classList.remove('is-visible');
  }, 1600);
}

el.theme.addEventListener('change', save);
el.fontSize.addEventListener('input', function () { render(read()); });
el.fontSize.addEventListener('change', save);
el.measure.addEventListener('input', function () { render(read()); });
el.measure.addEventListener('change', save);

el.reset.addEventListener('click', function () {
  chrome.storage.sync.set(DEFAULTS).then(function () {
    render(DEFAULTS);
    status('Defaults restored');
  }).catch(function () {
    status('Could not save');
  });
});

el.shortcuts.addEventListener('click', function () {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(function () {
    status('Open chrome://extensions/shortcuts');
  });
});

el.version.textContent = 'v' + chrome.runtime.getManifest().version;

chrome.storage.sync.get(DEFAULTS)
  .then(normalize)
  .then(render)
  .catch(function () { render(DEFAULTS); });

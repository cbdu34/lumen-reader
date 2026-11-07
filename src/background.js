/**
 * Lumen — service worker.
 *
 * The extension ships no content script: `src/extract.js` and `src/reader.js`
 * are injected only when the user asks for them, using the `activeTab` grant.
 * That keeps Lumen out of every page you visit until you click.
 */
'use strict';

var CONTENT_FILES = ['src/extract.js', 'src/reader.js'];
var DEFAULT_SETTINGS = { theme: 'sepia', fontSize: 19, measure: 68 };

/*
 * The toolbar mark is rasterised at runtime rather than shipped as a PNG.
 * The repository stays text-only, and the icon is generated from the same
 * geometry as `tools/generate-icons.py`, so the two can never drift apart.
 */
var MARK_INK = [26, 23, 19];
var MARK_PAPER = [244, 236, 220];
var MARK_ACCENT = [226, 154, 74];
var MARK_SIZES = [16, 32, 48, 128];
var MARK_BARS = [
  [0.235, 0.325, 0.520, 0.072, MARK_PAPER],
  [0.235, 0.455, 0.395, 0.072, MARK_PAPER],
  [0.235, 0.585, 0.455, 0.072, MARK_ACCENT]
];

chrome.action.onClicked.addListener(function (tab) {
  toggle(tab).catch(function () { /* never surface an unhandled rejection */ });
});

chrome.runtime.onInstalled.addListener(function () {
  paintMark();
  chrome.action.setBadgeBackgroundColor({ color: '#b4651f' });
  chrome.storage.sync.get(DEFAULT_SETTINGS).then(function (stored) {
    return chrome.storage.sync.set(stored);
  }).catch(function () {
    /* Storage may be unavailable; defaults are applied in code anyway. */
  });
});

/**
 * Ask the tab to toggle the reader, injecting the scripts first if needed.
 * @param {chrome.tabs.Tab} tab
 */
async function toggle(tab) {
  var tabId = tab && tab.id;
  if (typeof tabId !== 'number') return;

  var url = tab.url || '';
  if (!/^(https?|file):/i.test(url)) {
    badge(tabId, '\u2715');
    return;
  }

  if (!(await ping(tabId))) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: false },
        files: CONTENT_FILES
      });
    } catch (error) {
      badge(tabId, '!');
      return;
    }
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'LUMEN_TOGGLE' });
  } catch (error) {
    badge(tabId, '!');
  }
}

/** Is the reader content script already listening in this tab? */
function ping(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'LUMEN_PING' })
    .then(function (reply) { return Boolean(reply && reply.ok); })
    .catch(function () { return false; });
}

function badge(tabId, text) {
  chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(function () {});
}

/* ------------------------------------------------------------------ *
 * Toolbar mark
 * ------------------------------------------------------------------ */

/** Point-in-rounded-rectangle test, in device pixels. */
function inRoundedRect(x, y, x0, y0, width, height, radius) {
  if (x < x0 || y < y0 || x > x0 + width || y > y0 + height) return false;
  var cx = Math.min(Math.max(x, x0 + radius), x0 + width - radius);
  var cy = Math.min(Math.max(y, y0 + radius), y0 + height - radius);
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius;
}

/** Rasterise the mark at one size, with 4x4 supersampled edges. */
function markImageData(size) {
  var ss = 4;
  var n = size * ss;
  var pixels = new Uint8ClampedArray(size * size * 4);

  for (var py = 0; py < size; py++) {
    for (var px = 0; px < size; px++) {
      var red = 0;
      var green = 0;
      var blue = 0;
      var covered = 0;

      for (var sy = 0; sy < ss; sy++) {
        var y = py * ss + sy + 0.5;
        for (var sx = 0; sx < ss; sx++) {
          var x = px * ss + sx + 0.5;
          if (!inRoundedRect(x, y, 0, 0, n, n, 0.222 * n)) continue;

          var color = MARK_INK;
          for (var b = 0; b < MARK_BARS.length; b++) {
            var bar = MARK_BARS[b];
            if (inRoundedRect(x, y, bar[0] * n, bar[1] * n, bar[2] * n, bar[3] * n, 0.036 * n)) {
              color = bar[4];
              break;
            }
          }

          red += color[0];
          green += color[1];
          blue += color[2];
          covered++;
        }
      }

      var index = (py * size + px) * 4;
      if (covered > 0) {
        pixels[index] = red / covered;
        pixels[index + 1] = green / covered;
        pixels[index + 2] = blue / covered;
        pixels[index + 3] = Math.round(255 * covered / (ss * ss));
      }
    }
  }

  return new ImageData(pixels, size, size);
}

/** Paint the toolbar icon. Silent on failure: the extension still works. */
function paintMark() {
  try {
    var set = {};
    for (var i = 0; i < MARK_SIZES.length; i++) {
      var size = MARK_SIZES[i];
      set[size] = markImageData(size);
    }
    chrome.action.setIcon({ imageData: set }).catch(function () {});
  } catch (error) {
    /* No ImageData in this context, or the action is not available yet. */
  }
}

paintMark();

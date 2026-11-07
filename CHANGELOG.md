# Changelog

All notable changes to Lumen are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-07

First public release.

### Added

- **Reader overlay** injected on demand into the current tab, isolated in a
  Shadow DOM root so the page's own CSS cannot reach it.
- **Self-contained extraction engine** (`src/extract.js`): block scoring,
  link-density penalties, class/id hints, `<article>` / `<main>` bonuses,
  boilerplate pruning and a light DOM sanitiser. No third-party reader library.
- **Three themes** — Sepia, Light and Ink (dark) — switchable with `T`.
- **Live typography controls**: text size from 15 to 30 px and a measure from
  44 to 92 characters per line, both persisted in `chrome.storage.sync`.
- **Reading progress bar** pinned to the top of the overlay.
- **Markdown export** of the cleaned article, with a YAML-free header holding
  the title, byline, site name and source URL.
- **Keyboard-first usage**: `Alt+R` to toggle, `Esc`, `+` / `−`, `W`, `T`, `E`
  and `?` once the reader is open; the panel also lists them.
- **Options page** with defaults, a live preview, the shortcut reference and a
  reset button.
- **Toolbar feedback**: a `✕` badge on pages the extension cannot read
  (`chrome://`, the Web Store, PDFs) and `!` if injection is refused.
- **Zero-dependency test suite** (`node --test`) covering scoring, titles,
  slugs, URL resolution and Markdown rendering.
- **Icon renderer** in pure Python (`tools/generate-icons.py`) for producing
  store-ready PNGs, and a matching runtime rasteriser for the toolbar mark.

### Security

- No host permissions, no declared content scripts and no remote code:
  scripts are injected through `chrome.scripting.executeScript` under an
  `activeTab` grant, only after the user acts.
- No network access of any kind. The extension contains no `fetch`, no
  `XMLHttpRequest`, no analytics and no telemetry.
- Extracted markup is rebuilt from an allowlist of tags and attributes before
  it reaches the overlay, so page scripts cannot ride along.

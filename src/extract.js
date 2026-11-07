/**
 * Lumen — content extraction engine.
 *
 * A dependency-free "readability" pass:
 *   1. collect block-level candidates (article / main / section / div / td),
 *   2. score each one from text mass, punctuation, paragraph count and class hints,
 *   3. keep the deepest candidate close to the best score (avoids grabbing the whole page),
 *   4. sanitize the winner into a whitelist of tags and absolutise every URL,
 *   5. serialize the result to Markdown.
 *
 * Works in a content script (exposes `globalThis.LumenExtract`) and in Node
 * (`module.exports`, used by the test suite).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LumenExtract = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WORDS_PER_MINUTE = 220;
  var MIN_ARTICLE_CHARS = 300;
  var MIN_PAGE_CHARS = 120;

  /** Tags that never carry article content. */
  var STRIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT',
    'BUTTON', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO', 'SVG', 'LINK',
    'META', 'TEMPLATE', 'DIALOG'
  ]);

  /** Tags we are willing to render in the reader. */
  var ALLOWED_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
    'CODE', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'A', 'IMG', 'FIGURE', 'FIGCAPTION',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'HR', 'BR', 'DL', 'DT',
    'DD', 'SUB', 'SUP', 'MARK', 'CITE', 'Q', 'SMALL', 'ABBR', 'TIME', 'KBD', 'VAR'
  ]);

  /** Class / id fragments that almost always mean "not the article". */
  var JUNK_HINT = new RegExp(
    '(^|[\\s_\\-])(' +
      'ad|ads|adunit|advert|adsbygoogle|banner|promo|promotion|promoted|sponsor|sponsored|' +
      'share|sharing|social|comment|comments|disqus|newsletter|subscribe|cookie|consent|' +
      'gdpr|popup|modal|overlay|sidebar|related|recommend|recirc|breadcrumb|breadcrumbs|' +
      'pagination|pager|toolbar|navbar|menu|masthead|paywall|signup|login|footer|header|nav|skip' +
    ')([\\s_\\-]|$)',
    'i'
  );

  var POSITIVE_HINT = /(article|body|content|entry|hentry|main|page|post|story|text|blog|prose|read)/i;
  var NEGATIVE_HINT = /(comment|meta|footer|footnote|nav|sidebar|sponsor|advert|share|social|promo|related|widget|breadcrumb|cookie|banner|masthead|menu|tools)/i;

  /* ------------------------------------------------------------------ *
   * Pure helpers — no DOM, unit tested in tests/extract.test.js
   * ------------------------------------------------------------------ */

  /** Collapse every run of whitespace into a single space and trim. */
  function normalizeSpace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function countWords(text) {
    var normalized = normalizeSpace(text);
    return normalized ? normalized.split(' ').length : 0;
  }

  /** Estimated reading time in minutes (never below 1). */
  function readingTime(text) {
    return Math.max(1, Math.ceil(countWords(text) / WORDS_PER_MINUTE));
  }

  /** A filesystem-friendly, accent-free slug. */
  function slugify(text) {
    var slug = String(text == null ? '' : text)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return slug || 'lumen-article';
  }

  /** Share of the visible text that lives inside links (0 = prose, 1 = pure nav). */
  function linkDensityOf(textLength, linkLength) {
    if (!textLength) return 1;
    return Math.min(1, Math.max(0, linkLength) / textLength);
  }

  /** Bonus / malus implied by class and id hints. */
  function classWeight(className, id) {
    var haystack = (String(className || '') + ' ' + String(id || '')).trim();
    if (!haystack) return 0;
    var weight = 0;
    if (POSITIVE_HINT.test(haystack)) weight += 6;
    if (NEGATIVE_HINT.test(haystack)) weight -= 8;
    return weight;
  }

  /**
   * Score one candidate container.
   * @param {{tagName?:string,className?:string,id?:string,textLength?:number,
   *          linkLength?:number,paragraphCount?:number,commaCount?:number,
   *          imageCount?:number}} features
   * @returns {number} 0 for anything that cannot be an article.
   */
  function scoreCandidate(features) {
    var f = features || {};
    var text = Math.max(0, Number(f.textLength) || 0);
    if (text < 140) return 0;

    var density = linkDensityOf(text, Math.max(0, Number(f.linkLength) || 0));
    if (density > 0.45) return 0;

    var score = 0;
    score += Math.min(text / 100, 12);
    score += Math.min((Number(f.commaCount) || 0) * 0.4, 6);
    score += Math.min((Number(f.paragraphCount) || 0) * 0.8, 8);
    if (f.tagName === 'ARTICLE' || f.tagName === 'MAIN') score += 6;
    else if (f.tagName === 'SECTION') score += 1;
    if ((Number(f.imageCount) || 0) > 0) score += 1;
    score += classWeight(f.className, f.id);

    if (score <= 0) return 0;
    return Math.round(score * (1 - density) * 1000) / 1000;
  }

  /** `"Great post | The Verge"` + `"The Verge"` -> `"Great post"`. */
  function cleanTitle(title, siteName) {
    var out = normalizeSpace(title);
    var site = normalizeSpace(siteName);
    if (!out || !site) return out;
    var escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\s*[|\\-\\u2013\\u2014\\u00b7\\u2022\\u00bb:\\u2013]+\\s*' + escaped + '\\s*$', 'i'), '');
    out = out.replace(new RegExp('^\\s*' + escaped + '\\s*[|\\-\\u2013\\u2014\\u00b7\\u2022\\u00bb:]+\\s*', 'i'), '');
    return normalizeSpace(out);
  }

  /** Resolve a possibly relative URL against the page URL. */
  function absolutize(url, base) {
    var raw = String(url == null ? '' : url).trim();
    if (!raw) return '';
    if (/^(javascript|data|vbscript):/i.test(raw)) return '';
    try {
      return new URL(raw, base || 'https://invalid.lumen/').href;
    } catch (error) {
      return '';
    }
  }

  /**
   * Render an ordered list of blocks as a Markdown document.
   * @param {Array<Object>} blocks
   * @returns {string}
   */
  function blocksToMarkdown(blocks) {
    var parts = [];
    (blocks || []).forEach(function (block) {
      if (!block) return;
      switch (block.type) {
        case 'h':
          var level = Math.min(6, Math.max(1, Number(block.level) || 1));
          if (block.text) parts.push(new Array(level + 1).join('#') + ' ' + block.text);
          break;
        case 'p':
          if (block.text) parts.push(block.text);
          break;
        case 'pre':
          if (block.text) parts.push('```\n' + block.text + '\n```');
          break;
        case 'quote':
          if (block.text) {
            parts.push(String(block.text).split('\n').map(function (line) {
              return '> ' + line;
            }).join('\n'));
          }
          break;
        case 'list':
          if (block.items && block.items.length) {
            parts.push(block.items.map(function (item, index) {
              return (block.ordered ? (index + 1) + '.' : '-') + ' ' + item;
            }).join('\n'));
          }
          break;
        case 'img':
          parts.push('![' + (block.alt || '') + '](' + (block.src || '') + ')');
          break;
        case 'hr':
          parts.push('---');
          break;
        default:
          break;
      }
    });
    return parts.filter(Boolean).join('\n\n') + '\n';
  }

  /** Assemble the final Markdown file for an article. */
  function buildMarkdown(article) {
    var head = ['# ' + (article.title || 'Untitled')];
    if (article.byline) head.push('*' + article.byline + '*');
    if (article.url) head.push('> Source: ' + article.url);
    return head.join('\n\n') + '\n\n' + blocksToMarkdown(article.blocks || []);
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function metaContent(doc, selector) {
    var node = doc.querySelector(selector);
    return node ? normalizeSpace(node.getAttribute('content')) : '';
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (error) {
      return '';
    }
  }

  function depthOf(element) {
    var depth = 0;
    var node = element;
    while (node && node.parentElement) {
      depth += 1;
      node = node.parentElement;
    }
    return depth;
  }

  function classAndId(element) {
    var className = typeof element.className === 'string' ? element.className : '';
    return (className + ' ' + (element.id || '')).trim();
  }

  /** Is this element obviously chrome (nav, ads, comments, share bars…)? */
  function isJunk(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute('aria-hidden') === 'true') return true;
    var hints = classAndId(element);
    return Boolean(hints) && JUNK_HINT.test(hints);
  }

  /** Feature vector used by `scoreCandidate`. */
  function featuresOf(element) {
    var text = normalizeSpace(element.textContent);
    var linkLength = 0;
    var links = element.querySelectorAll('a');
    for (var i = 0; i < links.length; i += 1) {
      linkLength += normalizeSpace(links[i].textContent).length;
    }
    return {
      tagName: element.tagName,
      className: typeof element.className === 'string' ? element.className : '',
      id: element.id || '',
      textLength: text.length,
      linkLength: linkLength,
      paragraphCount: element.querySelectorAll('p').length,
      commaCount: (text.match(/[,;:]/g) || []).length,
      imageCount: element.querySelectorAll('img').length
    };
  }

  function linkDensity(element) {
    var text = normalizeSpace(element.textContent).length;
    if (!text) return 1;
    var linkLength = 0;
    var links = element.querySelectorAll('a');
    for (var i = 0; i < links.length; i += 1) {
      linkLength += normalizeSpace(links[i].textContent).length;
    }
    return linkDensityOf(text, linkLength);
  }

  /**
   * Rebuild a subtree with a tag whitelist, no classes, no inline styles and
   * absolute URLs. Returns a DocumentFragment owned by `doc`.
   */
  function sanitizeNode(node, doc, baseUrl, options) {
    var opts = options || {};
    var frag = doc.createDocumentFragment();
    var children = node.childNodes;
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];

      if (child.nodeType === 3) {
        var raw = child.nodeValue.replace(/\s+/g, ' ');
        if (raw.trim() || /^\s$/.test(raw)) frag.appendChild(doc.createTextNode(raw));
        continue;
      }
      if (child.nodeType !== 1) continue;

      var tag = child.tagName;
      if (STRIP_TAGS.has(tag)) continue;
      if (isJunk(child)) continue;

      if (tag === 'IMG') {
        var src = absolutize(
          child.getAttribute('src') || child.getAttribute('data-src') ||
            child.getAttribute('data-original') || '',
          baseUrl
        );
        var width = parseFloat(child.getAttribute('width') || '0');
        var height = parseFloat(child.getAttribute('height') || '0');
        if (!src || /\.svg$/i.test(src)) continue;
        if ((width && width < 8) || (height && height < 8)) continue;
        var img = doc.createElement('img');
        img.setAttribute('src', src);
        var alt = child.getAttribute('alt');
        if (alt) img.setAttribute('alt', alt);
        img.setAttribute('loading', 'lazy');
        frag.appendChild(img);
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        frag.appendChild(sanitizeNode(child, doc, baseUrl, opts));
        continue;
      }

      var clean = doc.createElement(tag);

      if (tag === 'A') {
        var href = absolutize(child.getAttribute('href'), baseUrl);
        if (href && /^https?:/i.test(href)) {
          clean.setAttribute('href', href);
          clean.setAttribute('rel', 'noopener noreferrer');
          clean.setAttribute('target', '_blank');
        }
        if (/^https?:\/\//i.test(href) && opts.linksToText) {
          /* keep the label only — used when flattening chrome-ish links */
        }
      }

      clean.appendChild(sanitizeNode(child, doc, baseUrl, opts));

      var isBlock = tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' ||
        tag === 'FIGURE' || tag === 'TD' || tag === 'TH' || tag === 'UL' || tag === 'OL' ||
        /^H[1-6]$/.test(tag);
      if (isBlock && !normalizeSpace(clean.textContent) && !clean.querySelector('img')) {
        continue;
      }
      frag.appendChild(clean);
    }
    return frag;
  }

  /* ------------------------------------------------------------------ *
   * Markdown serialization (DOM -> blocks -> Markdown)
   * ------------------------------------------------------------------ */

  function inlineToMarkdown(node) {
    var out = '';
    var children = node.childNodes;
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      if (child.nodeType === 3) {
        out += child.nodeValue.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName;
      if (STRIP_TAGS.has(tag)) continue;
      if (tag === 'BR') {
        out += '\n';
        continue;
      }
      if (tag === 'IMG') {
        out += '![' + (child.getAttribute('alt') || '') + '](' + (child.getAttribute('src') || '') + ')';
        continue;
      }
      var inner = inlineToMarkdown(child);
      if (!inner.trim()) {
        out += inner;
        continue;
      }
      var label = inner.trim();
      if (tag === 'STRONG' || tag === 'B') out += '**' + label + '**';
      else if (tag === 'EM' || tag === 'I' || tag === 'CITE') out += '*' + label + '*';
      else if (tag === 'CODE' || tag === 'KBD') out += '`' + label + '`';
      else if (tag === 'A' && child.getAttribute('href')) out += '[' + label + '](' + child.getAttribute('href') + ')';
      else out += inner;
    }
    return out;
  }

  function tableToBlocks(table) {
    var rows = [];
    var trs = table.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i += 1) {
      var cells = [];
      var td = trs[i].querySelectorAll('th, td');
      for (var j = 0; j < td.length; j += 1) {
        cells.push(normalizeSpace(td[j].textContent));
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return [];
    var width = rows.reduce(function (max, row) {
      return Math.max(max, row.length);
    }, 0);
    var lines = rows.map(function (row) {
      var padded = row.slice();
      while (padded.length < width) padded.push('');
      return '| ' + padded.join(' | ') + ' |';
    });
    lines.splice(1, 0, '| ' + new Array(width + 1).join('--- |').replace(/--- \|$/, '--- |'));
    return [{ type: 'pre', text: lines.join('\n') }];
  }

  /** Flatten a rendered subtree into portable blocks. */
  function domToBlocks(root) {
    var blocks = [];

    function walk(node) {
      var children = node.childNodes;
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (child.nodeType === 3) {
          var loose = normalizeSpace(child.nodeValue);
          if (loose.length > 1) blocks.push({ type: 'p', text: loose });
          continue;
        }
        if (child.nodeType !== 1) continue;
        var tag = child.tagName;
        if (STRIP_TAGS.has(tag)) continue;

        if (/^H[1-6]$/.test(tag)) {
          blocks.push({ type: 'h', level: Number(tag.charAt(1)), text: normalizeSpace(child.textContent) });
          continue;
        }
        if (tag === 'P') {
          var inline = inlineToMarkdown(child).trim();
          if (inline) blocks.push({ type: 'p', text: inline });
          continue;
        }
        if (tag === 'PRE') {
          var code = child.textContent.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
          if (code) blocks.push({ type: 'pre', text: code });
          continue;
        }
        if (tag === 'BLOCKQUOTE') {
          var quote = inlineToMarkdown(child).trim();
          if (quote) blocks.push({ type: 'quote', text: quote });
          continue;
        }
        if (tag === 'UL' || tag === 'OL') {
          var items = [];
          var lis = child.querySelectorAll(':scope > li');
          for (var k = 0; k < lis.length; k += 1) {
            var item = inlineToMarkdown(lis[k]).trim();
            if (item) items.push(item);
          }
          if (items.length) blocks.push({ type: 'list', ordered: tag === 'OL', items: items });
          continue;
        }
        if (tag === 'IMG') {
          blocks.push({ type: 'img', src: child.getAttribute('src') || '', alt: child.getAttribute('alt') || '' });
          continue;
        }
        if (tag === 'HR') {
          blocks.push({ type: 'hr' });
          continue;
        }
        if (tag === 'TABLE') {
          blocks.push.apply(blocks, tableToBlocks(child));
          continue;
        }
        walk(child);
      }
    }

    walk(root);
    return blocks;
  }

  /* ------------------------------------------------------------------ *
   * Public entry point
   * ------------------------------------------------------------------ */

  function pickCandidate(doc) {
    if (!doc || !doc.body) return null;
    var nodes = doc.body.querySelectorAll('article, main, [role="main"], section, div, td');
    var scored = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var element = nodes[i];
      if (isJunk(element)) continue;
      var score = scoreCandidate(featuresOf(element));
      if (score > 0) scored.push({ element: element, score: score });
    }
    if (!scored.length) return null;

    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    var floor = scored[0].score * 0.9;
    var near = scored.filter(function (entry) {
      return entry.score >= floor;
    });
    /* Among near-best candidates, prefer the most specific (deepest) one. */
    near.sort(function (a, b) {
      return depthOf(b.element) - depthOf(a.element);
    });
    return near[0].element;
  }

  /**
   * Extract the main article of a document.
   * @param {Document} doc
   * @returns {null|{title:string,byline:string,excerpt:string,siteName:string,
   *   url:string,wordCount:number,readingMinutes:number,contentHtml:string,
   *   blocks:Array<Object>,markdown:string}}
   */
  function extract(doc) {
    if (!doc || !doc.body) return null;

    var url = (doc.location && doc.location.href) || '';
    var siteName = metaContent(doc, 'meta[property="og:site_name"]') ||
      metaContent(doc, 'meta[name="application-name"]') || hostnameOf(url);

    var title = cleanTitle(
      metaContent(doc, 'meta[property="og:title"]') ||
        metaContent(doc, 'meta[name="twitter:title"]') ||
        (doc.querySelector('h1') ? doc.querySelector('h1').textContent : '') ||
        doc.title,
      siteName
    );

    var byline = metaContent(doc, 'meta[name="author"]') ||
      metaContent(doc, 'meta[property="article:author"]');
    if (!byline) {
      var authorNode = doc.querySelector('[rel="author"], .byline, [class*="byline"], [itemprop="author"]');
      if (authorNode) byline = normalizeSpace(authorNode.textContent).slice(0, 120);
    }
    var excerpt = metaContent(doc, 'meta[name="description"]') ||
      metaContent(doc, 'meta[property="og:description"]');

    var winner = pickCandidate(doc);
    var content = winner ? sanitizeNode(winner, doc, url) : null;
    var text = content ? normalizeSpace(content.textContent) : '';

    if (!content || text.length < MIN_ARTICLE_CHARS) {
      content = sanitizeNode(doc.body, doc, url);
      text = normalizeSpace(content.textContent);
    }
    if (text.length < MIN_PAGE_CHARS) return null;

    var container = doc.createElement('div');
    container.appendChild(content);

    /* Drop a leading <h1> when it duplicates the title we already render. */
    var first = container.firstElementChild;
    while (first && !normalizeSpace(first.textContent)) {
      var next = first.nextElementSibling;
      first.remove();
      first = next;
    }
    if (first && first.tagName === 'H1' && normalizeSpace(first.textContent) === normalizeSpace(title)) {
      first.remove();
    }

    var blocks = domToBlocks(container);
    var wordCount = countWords(text);

    return {
      url: url,
      title: title || 'Untitled',
      byline: byline,
      excerpt: excerpt,
      siteName: siteName,
      wordCount: wordCount,
      readingMinutes: readingTime(text),
      contentHtml: container.innerHTML,
      blocks: blocks,
      markdown: buildMarkdown({
        title: title || 'Untitled',
        byline: byline,
        url: url,
        blocks: blocks
      })
    };
  }

  return {
    extract: extract,
    scoreCandidate: scoreCandidate,
    classWeight: classWeight,
    linkDensity: linkDensity,
    linkDensityOf: linkDensityOf,
    readingTime: readingTime,
    countWords: countWords,
    slugify: slugify,
    cleanTitle: cleanTitle,
    absolutize: absolutize,
    normalizeSpace: normalizeSpace,
    blocksToMarkdown: blocksToMarkdown,
    buildMarkdown: buildMarkdown,
    domToBlocks: domToBlocks,
    sanitizeNode: sanitizeNode,
    WORDS_PER_MINUTE: WORDS_PER_MINUTE
  };
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreCandidate,
  classWeight,
  readingTime,
  countWords,
  slugify,
  cleanTitle,
  absolutize,
  normalizeSpace,
  blocksToMarkdown,
  buildMarkdown
} = require('../src/extract.js');

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

test('scoreCandidate: plain prose beats a link farm', () => {
  const prose = scoreCandidate({
    tagName: 'DIV',
    className: 'post-content',
    textLength: 6000,
    linkLength: 120,
    paragraphCount: 24,
    commaCount: 180,
    imageCount: 3
  });
  const farm = scoreCandidate({
    tagName: 'DIV',
    className: 'sidebar',
    textLength: 2000,
    linkLength: 1900,
    paragraphCount: 30,
    commaCount: 10
  });
  assert.ok(prose > 0, 'prose should score above zero');
  assert.equal(farm, 0, 'a container made of links is rejected');
});

test('scoreCandidate: rejects very short blocks', () => {
  assert.equal(scoreCandidate({ tagName: 'DIV', textLength: 40 }), 0);
  assert.equal(scoreCandidate({}), 0);
});

test('scoreCandidate: <article> gets a structural bonus', () => {
  const base = {
    textLength: 1200,
    linkLength: 40,
    paragraphCount: 6,
    commaCount: 30
  };
  const asDiv = scoreCandidate(Object.assign({ tagName: 'DIV' }, base));
  const asArticle = scoreCandidate(Object.assign({ tagName: 'ARTICLE' }, base));
  assert.ok(asArticle > asDiv);
});

test('scoreCandidate: negative class hints lower the score', () => {
  const features = { tagName: 'DIV', textLength: 1500, linkLength: 50, paragraphCount: 8, commaCount: 40 };
  const neutral = scoreCandidate(features);
  const commented = scoreCandidate(Object.assign({ className: 'comments' }, features));
  assert.ok(commented < neutral);
});

test('classWeight: rewards content hints, punishes chrome hints', () => {
  assert.ok(classWeight('article-body', '') > 0);
  assert.ok(classWeight('', 'sidebar') < 0);
  assert.equal(classWeight('', ''), 0);
});

/* ------------------------------------------------------------------ *
 * Text metrics
 * ------------------------------------------------------------------ */

test('countWords and readingTime', () => {
  assert.equal(countWords('  one   two\nthree '), 3);
  assert.equal(countWords(''), 0);
  assert.equal(readingTime('word '.repeat(220)), 1);
  assert.equal(readingTime('word '.repeat(440)), 2);
  assert.equal(readingTime(''), 1);
});

test('normalizeSpace collapses whitespace', () => {
  assert.equal(normalizeSpace('  a \n\t b  '), 'a b');
});

/* ------------------------------------------------------------------ *
 * Titles and slugs
 * ------------------------------------------------------------------ */

test('cleanTitle strips a trailing site name', () => {
  assert.equal(cleanTitle('The quiet web | The Verge', 'The Verge'), 'The quiet web');
  assert.equal(cleanTitle('The quiet web - The Verge', 'The Verge'), 'The quiet web');
  assert.equal(cleanTitle('The Verge: The quiet web', 'The Verge'), 'The quiet web');
});

test('cleanTitle keeps the title when no site name is known', () => {
  assert.equal(cleanTitle('The quiet web | The Verge', ''), 'The quiet web | The Verge');
  assert.equal(cleanTitle('  spaced   out  ', ''), 'spaced out');
});

test('slugify produces safe file names', () => {
  assert.equal(slugify('Why Café culture Héritage matters!'), 'why-cafe-culture-heritage-matters');
  assert.equal(slugify('   '), 'lumen-article');
  assert.equal(slugify('a'.repeat(200)).length, 80);
});

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

test('absolutize resolves relative links', () => {
  assert.equal(absolutize('/a/b', 'https://example.com/x/y'), 'https://example.com/a/b');
  assert.equal(absolutize('c', 'https://example.com/x/y'), 'https://example.com/x/c');
  assert.equal(absolutize('https://other.test/z', 'https://example.com'), 'https://other.test/z');
});

test('absolutize refuses dangerous schemes and empty input', () => {
  assert.equal(absolutize('javascript:alert(1)', 'https://example.com'), '');
  assert.equal(absolutize('data:image/png;base64,AAA', 'https://example.com'), '');
  assert.equal(absolutize('', 'https://example.com'), '');
});

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

test('blocksToMarkdown renders every block kind', () => {
  const markdown = blocksToMarkdown([
    { type: 'h', level: 2, text: 'Section' },
    { type: 'p', text: 'A paragraph.' },
    { type: 'list', ordered: false, items: ['one', 'two'] },
    { type: 'list', ordered: true, items: ['first'] },
    { type: 'quote', text: 'Quoted.' },
    { type: 'pre', text: 'const a = 1;' },
    { type: 'img', src: 'https://example.com/a.png', alt: 'Alt' },
    { type: 'hr' },
    { type: 'unknown-kind' }
  ]);

  assert.match(markdown, /^## Section$/m);
  assert.match(markdown, /^A paragraph\.$/m);
  assert.match(markdown, /^- one\n- two$/m);
  assert.match(markdown, /^1\. first$/m);
  assert.match(markdown, /^> Quoted\.$/m);
  assert.match(markdown, /^```\nconst a = 1;\n```$/m);
  assert.match(markdown, /!\[Alt\]\(https:\/\/example\.com\/a\.png\)/);
  assert.match(markdown, /^---$/m);
  assert.ok(markdown.endsWith('\n'));
});

test('blocksToMarkdown clamps heading levels and survives junk input', () => {
  assert.match(blocksToMarkdown([{ type: 'h', level: 9, text: 'Deep' }]), /^###### Deep$/m);
  assert.equal(blocksToMarkdown(null), '\n');
  assert.equal(blocksToMarkdown([null, { type: 'p', text: '' }]), '\n');
});

test('buildMarkdown adds a title, byline and source', () => {
  const markdown = buildMarkdown({
    title: 'Hello',
    byline: 'Ada',
    url: 'https://example.com/post',
    blocks: [{ type: 'p', text: 'Body.' }]
  });
  assert.match(markdown, /^# Hello$/m);
  assert.match(markdown, /^\*Ada\*$/m);
  assert.match(markdown, /^> Source: https:\/\/example\.com\/post$/m);
  assert.match(markdown, /^Body\.$/m);
});

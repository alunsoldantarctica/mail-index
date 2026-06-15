/**
 * Distillation tests (SCOPE 1.1, PLAN §7 phase 2, CONTEXT.md "Enrichment",
 * ADR-0003). The distiller is the index's SIZE LEVER, so these assert it is
 * deterministic and that boilerplate (HTML chrome, quoted reply history,
 * signatures, unsubscribe/list footers, tracking junk) is removed while the
 * real prose survives — and that a representative newsletter HTML shrinks
 * dramatically. Tests import the compiled output; `pnpm test` builds first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  distill,
  htmlToText,
  deboilerplate,
  normalizeWhitespace,
} from '../dist/ingest/distill.js';

/** A representative newsletter: mostly markup, tracking pixel, footer chrome. */
const NEWSLETTER_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>This week in polar logistics</title>
  <style>
    .container { width: 600px; margin: 0 auto; font-family: Helvetica; }
    .footer { color: #999; font-size: 11px; }
    a { color: #0a7; }
  </style>
  <script type="text/javascript">
    (function () { window.__track = function (e) { /* analytics */ }; })();
  </script>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">
  <img src="https://bulletin.example.org/o/abc123.gif?open=1" width="1" height="1" alt="" style="display:none" />
  <table class="container" cellpadding="0" cellspacing="0" border="0">
    <tr><td>
      <h1 style="font-size:24px;">This week in polar logistics</h1>
      <p>Top stories: new zodiac schedules are out, and ice-class vessel
         availability for the December departures has been confirmed.</p>
      <p>Operators should book repositioning legs before the end of the month
         to lock current fuel surcharges.</p>
    </td></tr>
    <tr><td class="footer">
      <p>&copy; 2024 Expedition Weekly. All rights reserved.</p>
      <p>You are receiving this email because you subscribed at our website.</p>
      <p><a href="https://bulletin.example.org/unsubscribe?u=42">Unsubscribe</a> &middot;
         <a href="https://bulletin.example.org/prefs">Update your preferences</a> &middot;
         <a href="https://bulletin.example.org/view?id=42">View in browser</a></p>
    </td></tr>
  </table>
</body>
</html>`;

test('htmlToText strips scripts, styles, head and tags but keeps prose', () => {
  const text = htmlToText(NEWSLETTER_HTML);
  assert.ok(text.includes('new zodiac schedules'), 'real content survives');
  assert.ok(!/<[a-z]/i.test(text), 'no leftover HTML tags');
  assert.ok(!text.includes('window.__track'), 'script body gone');
  assert.ok(!text.includes('font-family'), 'style body gone');
});

test('htmlToText decodes entities', () => {
  assert.equal(htmlToText('a &amp; b &copy; &#8212; &#x2014;').trim(), 'a & b © — —');
});

test('distill shrinks a newsletter dramatically and drops footer chrome', () => {
  const out = distill({ bodyText: null, bodyHtml: NEWSLETTER_HTML, mimeType: 'text/html' });

  // The real prose is retained.
  assert.ok(out.includes('new zodiac schedules'), 'lead story kept');
  assert.ok(out.includes('repositioning legs'), 'second paragraph kept');

  // Footer / unsubscribe / tracking chrome is gone.
  assert.ok(!/unsubscribe/i.test(out), 'unsubscribe footer removed');
  assert.ok(!/update your preferences/i.test(out), 'preferences footer removed');
  assert.ok(!/all rights reserved/i.test(out), 'copyright footer removed');
  assert.ok(!/receiving this email/i.test(out), 'list-footer removed');
  assert.ok(!out.includes('abc123.gif'), 'tracking pixel url gone');

  // The SIZE LEVER: distilled output is a small fraction of the raw HTML.
  assert.ok(
    out.length < NEWSLETTER_HTML.length * 0.25,
    `expected dramatic shrink, got ${out.length} of ${NEWSLETTER_HTML.length}`,
  );
});

test('distill removes quoted reply history ("On … wrote:" + > lines)', () => {
  const body =
    'Hi Al,\n\nConfirming the 20% deposit is due Friday. Wire details below.\n\n' +
    'Best,\nJordan\n\n' +
    'On Tue, 28 May 2024 at 14:40, Al Operator <al@example.com> wrote:\n' +
    '> Can you confirm the deposit schedule?\n' +
    '> Thanks';
  const out = distill({ bodyText: body, bodyHtml: null });

  assert.ok(out.includes('Confirming the 20% deposit'), 'real content kept');
  assert.ok(!out.includes('Can you confirm the deposit schedule?'), 'quoted history gone');
  assert.ok(!/wrote:/.test(out), 'quote header gone');
  assert.ok(!/^\s*>/m.test(out), 'no quote-prefixed lines remain');
});

test('distill removes a signature block after the -- delimiter', () => {
  const body =
    'Sounds good, see you Friday.\n\n--\nJordan Partner\nVP, Charters\n+1 555 0100\njordan@partner.example.com';
  const out = distill({ bodyText: body, bodyHtml: null });

  assert.ok(out.includes('Sounds good'), 'content kept');
  assert.ok(!out.includes('VP, Charters'), 'signature removed');
  assert.ok(!out.includes('555 0100'), 'signature phone removed');
});

test('distill prefers plain bodyText over HTML when both present', () => {
  const out = distill({
    bodyText: 'the plain text version',
    bodyHtml: '<p>the <b>html</b> version</p>',
    mimeType: 'multipart/alternative',
  });
  assert.equal(out, 'the plain text version');
});

test('distill falls back to stripped HTML when bodyText is empty/blank', () => {
  const out = distill({ bodyText: '   \n  ', bodyHtml: '<p>html fallback content</p>', mimeType: null });
  assert.equal(out, 'html fallback content');
});

test('distill is deterministic and returns "" for a bodyless message', () => {
  const a = distill({ bodyText: null, bodyHtml: NEWSLETTER_HTML });
  const b = distill({ bodyText: null, bodyHtml: NEWSLETTER_HTML });
  assert.equal(a, b, 'same input → same output');
  assert.equal(distill({ bodyText: null, bodyHtml: null }), '');
});

test('normalizeWhitespace collapses blank-line runs and trims', () => {
  assert.equal(normalizeWhitespace('a\n\n\n\nb\n   \n c '), 'a\n\nb\n\nc');
});

test('deboilerplate keeps content when there is no boilerplate', () => {
  const text = 'Line one.\nLine two.\nLine three.';
  assert.equal(deboilerplate(text), text);
});

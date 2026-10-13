import { describe, expect, it } from 'vitest';

import {
  blogFingerprint,
  decodeEntities,
  diffFingerprints,
  docsFingerprint,
  hasChanges,
  report,
  stateMarker,
} from '../scripts/upstream-fingerprint.js';

// Invented content laid out like the Fireside documentation page.
function page({ csrf = 'token-one', note = 'Widgets are listed newest first.', extra = '' } = {}): string {
  return `<html><head><meta name="csrf-token" content="${csrf}" /></head><body>
<nav>Navigation</nav>
<main id="main" tabindex="-1">
  <h2 id="widgets" class="mt-5">List Widgets</h2>
  <pre><code>GET /api/v1/widgets</code></pre>
  <p>${note} Limited to <strong>10 per page</strong>.</p>
  <table class="table"><thead><tr><th>Parameter</th><th>Type</th><th>Description</th></tr></thead>
  <tbody><tr><td><code>page</code></td><td>integer</td><td>Which page, from 1</td></tr></tbody></table>
  <h3>Response</h3>
<pre><code>{
  "data": [{ "token": "w1", "name": "Gear &amp; Co" }],
  "pagination": { "next": null }
}</code></pre>
  <svg><path id="wave-${csrf}" /></svg>
  ${extra}
  <h2 id="widget-create" class="mt-5">Create Widget</h2>
  <pre><code>POST /api/v1/widgets</code></pre>
  <p>A taken name returns 422 with the code <code>name_taken</code>.</p>
<pre><code>{ "error": { "message": "Nope", "code": "write_access_required" } }</code></pre>
</main>
<footer><a href="/blog">Blog</a></footer>
</body></html>`;
}

const UPLOADS = `<h2 id="uploads">Upload a Widget</h2>
  <pre><code>POST /api/v1/uploads</code></pre>
  <table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
  <tbody><tr><td><code>kind</code></td><td>string</td><td>What it is</td></tr></tbody></table>`;

describe('docsFingerprint', () => {
  const lines = docsFingerprint(page());

  it('starts with a hash of the text', () => {
    expect(lines[0]).toMatch(/^text-sha256 [0-9a-f]{64}$/);
  });

  it('records endpoints, table rows without descriptions, JSON key paths, error codes and emphasised figures', () => {
    expect(lines.slice(1)).toEqual([
      'section widgets List Widgets',
      'endpoint widgets GET /api/v1/widgets',
      'json widgets data',
      'json widgets data[].token',
      'json widgets data[].name',
      'json widgets pagination',
      'json widgets pagination.next',
      'row widgets Parameter=page; Type=integer',
      'fact widgets 10 per page',
      'section widget-create Create Widget',
      'endpoint widget-create POST /api/v1/widgets',
      'json widget-create error',
      'json widget-create error.message',
      'json widget-create error.code',
      'code widget-create write_access_required',
      'code widget-create name_taken',
    ]);
  });

  it('keeps no description text or example values', () => {
    const joined = lines.join('\n');
    expect(joined).not.toContain('Which page');
    expect(joined).not.toContain('Gear');
    expect(joined).not.toContain('Nope');
  });

  it('ignores per-request tokens and content outside <main>', () => {
    expect(docsFingerprint(page({ csrf: 'token-two' }))).toEqual(lines);
  });

  it('refuses a page whose layout it does not recognise', () => {
    expect(() => docsFingerprint('<html><body><h2 id="x">X</h2></body></html>')).toThrow(/No <main>/);
    expect(() => docsFingerprint('<main><h2>X</h2></main>')).toThrow(/No <h2 id>/);
  });
});

describe('diffFingerprints', () => {
  const baseline = docsFingerprint(page());

  it('reports nothing for the same page', () => {
    expect(hasChanges(diffFingerprints(baseline, docsFingerprint(page({ csrf: 'other' }))))).toBe(false);
  });

  it('reports a new endpoint and its fields as added', () => {
    const diff = diffFingerprints(baseline, docsFingerprint(page({ extra: UPLOADS })));
    expect(diff.added).toEqual([
      'section uploads Upload a Widget',
      'endpoint uploads POST /api/v1/uploads',
      'row uploads Field=kind; Type=string',
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.textChanged).toBe(true);
  });

  it('reports a removed endpoint as removed', () => {
    const diff = diffFingerprints(docsFingerprint(page({ extra: UPLOADS })), baseline);
    expect(diff.removed).toContain('endpoint uploads POST /api/v1/uploads');
    expect(diff.added).toEqual([]);
  });

  it('reports a wording-only change through the text hash', () => {
    const diff = diffFingerprints(baseline, docsFingerprint(page({ note: 'Widgets are listed oldest first.' })));
    expect(diff).toEqual({ added: [], removed: [], textChanged: true });
    expect(hasChanges(diff)).toBe(true);
  });

  it('reports a changed probe status', () => {
    const diff = diffFingerprints(['probe GET /api/v2/podcasts 404'], ['probe GET /api/v2/podcasts 401']);
    expect(diff.added).toEqual(['probe GET /api/v2/podcasts 401']);
    expect(diff.removed).toEqual(['probe GET /api/v2/podcasts 404']);
  });
});

describe('blogFingerprint', () => {
  const rss = `<rss><channel>
    <item><title>Podcast tips</title><link>https://blog.example/tips/</link><description>Microphones.</description></item>
    <item><title><![CDATA[New: an API for uploads]]></title><link>https://blog.example/api/</link><description>x</description></item>
    <item><title>Integrations</title><link>https://blog.example/int/</link><description><![CDATA[Our API now &amp; more]]></description></item>
    <item><title>Rapid growth</title><link>https://blog.example/rapid/</link><description>Not the word.</description></item>
  </channel></rss>`;

  it('lists only posts that mention the API', () => {
    expect(blogFingerprint(rss)).toEqual([
      'blog https://blog.example/api/ New: an API for uploads',
      'blog https://blog.example/int/ Integrations',
    ]);
  });
});

describe('report', () => {
  const before = docsFingerprint(page());
  const after = docsFingerprint(page({ extra: UPLOADS }));

  it('starts with a marker for the current state and lists the changes', () => {
    const body = report(diffFingerprints(before, after), after, 'scripts/fireside-api-baseline.txt');
    expect(body.split('\n')[0]).toBe(stateMarker(after));
    expect(body).toContain('### Added\n\n- `section uploads Upload a Widget`');
    expect(body).not.toContain('### Removed');
    expect(body).toContain('AGENTS.md');
  });

  it('says when only the wording changed', () => {
    const reworded = docsFingerprint(page({ note: 'Changed.' }));
    expect(report(diffFingerprints(before, reworded), reworded, 'b.txt')).toContain('Only the documentation text changed');
  });

  it('gives each state its own marker', () => {
    expect(stateMarker(after)).not.toBe(stateMarker(before));
    expect(stateMarker(after)).toBe(stateMarker([...after]));
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(decodeEntities('it&rsquo;s &amp; &#39;x&#x27; &bogus;')).toBe('it’s & \'x\' &bogus;');
  });
});

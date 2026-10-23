/**
 * Reduces the Fireside API documentation to a list of facts (endpoints, table rows, JSON keys,
 * error codes, emphasised figures) so that a scheduled check can report what changed. Descriptions
 * are left out on purpose: the baseline lives in a public repository and should not republish
 * Fireside's prose. A hash of the full text still catches wording-only changes.
 */

import { createHash } from 'node:crypto';

export const DOCS_URL = 'https://fireside.fm/docs/api';
export const BLOG_RSS_URL = 'https://blog.fireside.fm/rss/';

// An unauthenticated request to a real endpoint returns 401; an unknown version returns 404.
export const PROBES = ['GET /api/v1/podcasts', 'GET /api/v2/podcasts'] as const;

const TEXT_HASH = 'text-sha256 ';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function plain(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The documentation's `<main>` element, which excludes navigation, per-request tokens and footer links. */
export function mainContent(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  if (main === undefined) throw new Error('No <main> element in the documentation page; the page layout changed.');
  return main.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '');
}

interface Section {
  id: string;
  title: string;
  html: string;
}

function sections(main: string): Section[] {
  const heading = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
  const found = [...main.matchAll(heading)];
  if (found.length === 0) throw new Error('No <h2 id> headings in the documentation; the page layout changed.');
  return found.map((match, i) => ({
    id: match[1] ?? '',
    title: plain(match[2] ?? ''),
    html: main.slice((match.index ?? 0) + match[0].length, found[i + 1]?.index ?? main.length),
  }));
}

function cells(row: string, tag: 'th' | 'td'): string[] {
  return [...row.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => plain(m[1] ?? ''));
}

function tableRows(html: string): string[] {
  const lines: string[] = [];
  for (const table of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    const header = rows.map((r) => cells(r, 'th')).find((h) => h.length > 0) ?? [];
    for (const row of rows) {
      const values = cells(row, 'td');
      if (values.length === 0) continue;
      const kept = values.flatMap((value, i) => {
        const column = header[i] ?? `column ${i + 1}`;
        return column.toLowerCase() === 'description' ? [] : [`${column}=${value}`];
      });
      lines.push(kept.join('; '));
    }
  }
  return lines;
}

function jsonPaths(value: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) jsonPaths(item, `${prefix}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      jsonPaths(child, path, out);
    }
  }
}

function codeBlocks(html: string): string[] {
  return [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')));
}

/** The fingerprint as lines, in document order, without duplicates. The first line is the text hash. */
export function docsFingerprint(html: string): string[] {
  const main = mainContent(html);
  const lines = [`${TEXT_HASH}${createHash('sha256').update(plain(main)).digest('hex')}`];
  for (const section of sections(main)) {
    const at = (kind: string, value: string) => lines.push(`${kind} ${section.id} ${value}`);
    at('section', section.title);
    for (const block of codeBlocks(section.html)) {
      const text = block.trim();
      // A block may list several endpoints, one per line (Downloads by Day lists two).
      const endpoints = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/.exec(line));
      if (endpoints.length > 0 && endpoints.every(Boolean)) {
        for (const endpoint of endpoints) at('endpoint', `${endpoint![1]} ${endpoint![2]}`);
        continue;
      }
      if (!text.startsWith('{') && !text.startsWith('[')) continue;
      const paths: string[] = [];
      try {
        jsonPaths(JSON.parse(text), '', paths);
      } catch {
        // Examples are meant to be valid JSON; if one is not, still record its key names.
        for (const m of text.matchAll(/"([^"]+)"\s*:/g)) paths.push(`~${m[1]}`);
      }
      for (const path of paths) at('json', path);
      for (const m of text.matchAll(/"code"\s*:\s*"([^"]+)"/g)) at('code', m[1] ?? '');
    }
    for (const row of tableRows(section.html)) at('row', row);
    for (const m of section.html.matchAll(/\bcode\s*<code>([a-z0-9_]+)<\/code>/gi)) at('code', m[1] ?? '');
    for (const m of section.html.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) at('fact', plain(m[1] ?? ''));
  }
  return [...new Set(lines)];
}

/** Blog posts that mention the API, as `blog <link> <title>` lines. */
export function blogFingerprint(rss: string): string[] {
  const lines: string[] = [];
  for (const item of rss.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const field = (name: string) =>
      decodeEntities(
        (new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item[0])?.[1] ?? '').replace(
          /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/,
          '$1',
        ),
      );
    if (!/\bAPI\b/.test(`${field('title')} ${field('description')} ${field('content:encoded')}`)) continue;
    lines.push(`blog ${field('link').trim()} ${plain(field('title'))}`);
  }
  return [...new Set(lines)];
}

export interface FingerprintDiff {
  added: string[];
  removed: string[];
  textChanged: boolean;
}

export function diffFingerprints(baseline: readonly string[], current: readonly string[]): FingerprintDiff {
  const facts = (lines: readonly string[]) => new Set(lines.filter((l) => !l.startsWith(TEXT_HASH)));
  const before = facts(baseline);
  const after = facts(current);
  const hash = (lines: readonly string[]) => lines.find((l) => l.startsWith(TEXT_HASH));
  return {
    added: [...after].filter((l) => !before.has(l)),
    removed: [...before].filter((l) => !after.has(l)),
    textChanged: hash(baseline) !== hash(current),
  };
}

export function hasChanges(diff: FingerprintDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.textChanged;
}

/** A marker that identifies this exact state, so a daily run does not report the same change twice. */
export function stateMarker(current: readonly string[]): string {
  return `<!-- upstream-watch:${createHash('sha256').update(current.join('\n')).digest('hex')} -->`;
}

export function report(diff: FingerprintDiff, current: readonly string[], baselinePath: string): string {
  const list = (lines: string[]) => lines.map((l) => `- \`${l}\``).join('\n');
  const parts = [
    stateMarker(current),
    `The Fireside API documentation (${DOCS_URL}), the API version probes or the Fireside blog changed since the baseline in \`${baselinePath}\`.`,
  ];
  if (diff.added.length > 0) parts.push(`### Added\n\n${list(diff.added)}`);
  if (diff.removed.length > 0) parts.push(`### Removed\n\n${list(diff.removed)}`);
  if (diff.textChanged) {
    parts.push(
      diff.added.length + diff.removed.length > 0
        ? 'The documentation text changed as well; read the page for changes in wording, limits or behaviour.'
        : 'Only the documentation text changed: no endpoint, field, key, error code or emphasised figure did. Read the page for changes in wording, limits or behaviour.',
    );
  }
  parts.push(
    'Follow "Upstream API changes" in `AGENTS.md`. The pull request that handles this updates the baseline with `npx tsx scripts/upstream-watch.ts --update`.',
  );
  return `${parts.join('\n\n')}\n`;
}

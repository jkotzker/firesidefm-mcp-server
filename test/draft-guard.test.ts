import { describe, expect, it } from 'vitest';

import { draftGuard } from '../scripts/draft-guard.js';

const API = 'https://fireside.fm/api/v1/';
const POD = '550e8400-e29b-41d4-a716-446655440000';
const DRAFT = '6a20c700-51d3-4c0a-abe7-da88d972a27c';
const OTHER = '11111111-2222-3333-4444-555555555555';

function setup() {
  const sent: string[] = [];
  const guard = draftGuard(async (input, init) => {
    sent.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response('{}');
  });
  return { guard, sent };
}

describe('draftGuard', () => {
  it('allows reads', async () => {
    const { guard, sent } = setup();
    await guard.fetch(`${API}podcasts/${POD}/episodes?status=draft`);
    expect(sent).toHaveLength(1);
  });

  it('allows one create and refuses a second', async () => {
    const { guard, sent } = setup();
    await guard.fetch(`${API}podcasts/${POD}/episodes`, { method: 'POST' });
    expect(() => guard.fetch(`${API}podcasts/${POD}/episodes`, { method: 'POST' })).toThrow(/exactly one draft/);
    expect(sent).toHaveLength(1);
  });

  it.each(['publish', 'unpublish'])('refuses %s even for the allowed draft', (action) => {
    const { guard, sent } = setup();
    guard.allow(DRAFT);
    expect(() => guard.fetch(`${API}podcasts/${POD}/episodes/${DRAFT}/${action}`, { method: 'POST' })).toThrow(/never sent/);
    expect(sent).toEqual([]);
  });

  it('refuses a publish sent as a Request object', () => {
    const { guard, sent } = setup();
    const request = new Request(`${API}podcasts/${POD}/episodes/${DRAFT}/publish`, { method: 'POST' });
    expect(() => guard.fetch(request)).toThrow(/never sent/);
    expect(sent).toEqual([]);
  });

  it('reads the method from a Request object', () => {
    const { guard, sent } = setup();
    const request = new Request(`${API}podcasts/${POD}/episodes/${OTHER}`, { method: 'PATCH' });
    expect(() => guard.fetch(request)).toThrow(/only the draft/);
    expect(sent).toEqual([]);
  });

  it('patches only the registered draft', async () => {
    const { guard, sent } = setup();
    expect(() => guard.fetch(`${API}podcasts/${POD}/episodes/${DRAFT}`, { method: 'PATCH' })).toThrow(/only the draft/);
    guard.allow(DRAFT);
    await guard.fetch(`${API}podcasts/${POD}/episodes/${DRAFT}`, { method: 'PATCH' });
    expect(() => guard.fetch(`${API}podcasts/${POD}/episodes/${OTHER}`, { method: 'PATCH' })).toThrow(/only the draft/);
    expect(sent).toHaveLength(1);
  });

  it.each(['DELETE', 'PUT'])('refuses %s', (method) => {
    const { guard } = setup();
    guard.allow(DRAFT);
    expect(() => guard.fetch(`${API}podcasts/${POD}/episodes/${DRAFT}`, { method })).toThrow(/not allowed/);
  });
});

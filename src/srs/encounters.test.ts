import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import { encounterCounts, logEncounters } from './encounters.ts';
import { introduceItem } from './items.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

describe('encounters', () => {
  it('logs one row per item, day and source, for introduced items only', async () => {
    await introduceItem('word', '1', at(2026, 3, 1));
    await introduceItem('word', '2', at(2026, 3, 1));
    expect(await logEncounters(['word:1', 'word:2', 'word:9', 'word:1'], 'sentence', at(2026, 3, 10, 9))).toBe(2);
    expect(await logEncounters(['word:1'], 'sentence', at(2026, 3, 10, 20))).toBe(0);
    expect(await logEncounters(['word:1'], 'story', at(2026, 3, 10, 20))).toBe(1);
    expect(await logEncounters(['word:1'], 'sentence', at(2026, 3, 11, 9))).toBe(1);
    expect(await db.encounters.count()).toBe(4);
  });

  it('counts the last 42 days', async () => {
    await introduceItem('word', '1', at(2026, 1, 1));
    await logEncounters(['word:1'], 'sentence', at(2026, 1, 2));
    await logEncounters(['word:1'], 'sentence', at(2026, 3, 1));
    await logEncounters(['word:1'], 'output', at(2026, 3, 2));
    const now = at(2026, 3, 10);
    expect(await encounterCounts(['word:1', 'word:2'], now)).toEqual(new Map([['word:1', 2], ['word:2', 0]]));
    expect((await encounterCounts(undefined, now)).get('word:1')).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { parseFavorites } from '../src/lib/favorites';
import { readFilters, writeFilters } from '../src/pages/workflows/filter';

describe('personal favorites', () => {
  it('recovers safely from corrupt or unexpected browser storage', () => {
    for (const raw of [null, '', '{bad json', '{}', 'null', 'true']) expect(parseFavorites(raw)).toEqual([]);
    expect(parseFavorites('["one",12,null,"two","one"]')).toEqual(['one', 'two']);
  });

  it('preserves favorites together with the other filters in a shareable URL', () => {
    const filters = { q: 'Atlas', tags: ['a', 'b'], active: 'active' as const, sort: 'name' as const, favorites: true };
    expect(readFilters(writeFilters(filters))).toEqual(filters);
    expect(writeFilters({ ...filters, favorites: false }).has('favorites')).toBe(false);
    expect(readFilters(new URLSearchParams('favorites=anything')).favorites).toBe(false);
  });
});

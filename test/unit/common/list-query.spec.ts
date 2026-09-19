import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  commaList,
  createdRange,
  escapeRegex,
  limitParam,
  repeatedList,
} from '../../../src/common/http/list-query';

describe('commaList', () => {
  const schema = commaList(z.enum(['A', 'B', 'C']));

  it('accepts comma separated values, repeated parameters and both', () => {
    expect(schema.parse('A')).toEqual(['A']);
    expect(schema.parse('A,B')).toEqual(['A', 'B']);
    expect(schema.parse(' A , B ,')).toEqual(['A', 'B']);
    expect(schema.parse(['A', 'B,C'])).toEqual(['A', 'B', 'C']);
  });

  it('refuses unknown values, empty input and too many values', () => {
    expect(schema.safeParse('A,Z').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse(',').success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 51 }, () => 'A')).success).toBe(false);
  });
});

describe('repeatedList', () => {
  it('never splits on commas', () => {
    const schema = repeatedList(z.string().min(1));

    expect(schema.parse('pratica,4521')).toEqual(['pratica,4521']);
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('limitParam', () => {
  it('defaults to 100 and stays within 1-500', () => {
    expect(limitParam.parse(undefined)).toBe(100);
    expect(limitParam.parse('500')).toBe(500);
    for (const bad of ['0', '501', '-1', '1.5', 'abc', '99999']) {
      expect(limitParam.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('escapeRegex', () => {
  it('makes a search string literal', () => {
    const pattern = new RegExp(escapeRegex('(.*)+[a]$^{1}|\\'));

    expect(pattern.test('(.*)+[a]$^{1}|\\')).toBe(true);
    expect(pattern.test('anything')).toBe(false);
  });
});

describe('createdRange', () => {
  it('is inclusive at the start, exclusive at the end, absent when unused', () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const before = new Date('2026-10-01T00:00:00Z');

    expect(createdRange(undefined, undefined)).toEqual({});
    expect(createdRange(from, before)).toEqual({ createdAt: { $gte: from, $lt: before } });
    expect(createdRange(undefined, before)).toEqual({ createdAt: { $lt: before } });
  });
});

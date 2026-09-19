import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors/app-error';
import { afterCreatedAt, createdAtKeys, decodeCursor, encodeCursor } from '../../../src/common/http/cursor';

describe('cursor', () => {
  it('round-trips the keys of its own list', () => {
    const cursor = encodeCursor('messages', ['2026-09-19T10:00:00.000Z', 'm_x']);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor('messages', cursor)).toEqual(['2026-09-19T10:00:00.000Z', 'm_x']);
  });

  it('refuses a cursor of another list, garbage and oversized input', () => {
    const cursor = encodeCursor('batches', ['2026-09-19T10:00:00.000Z', 'b_x']);

    for (const raw of [
      cursor,
      'garbage',
      '',
      'x'.repeat(600),
      Buffer.from('{"v":2,"l":"messages","k":[1]}').toString('base64url'),
    ]) {
      expect(() => decodeCursor('messages', raw)).toThrow(AppError);
    }
  });

  it('checks the shape of createdAt keys', () => {
    expect(createdAtKeys(['2026-09-19T10:00:00.000Z', 'm_x'])).toEqual({
      createdAt: new Date('2026-09-19T10:00:00.000Z'),
      id: 'm_x',
    });
    expect(() => createdAtKeys([1, 'm_x'])).toThrow(AppError);
    expect(() => createdAtKeys(['not a date', 'm_x'])).toThrow(AppError);
    expect(() => createdAtKeys(['2026-09-19T10:00:00.000Z'])).toThrow(AppError);
  });

  it('builds the "after this item" condition of a newest-first list', () => {
    const at = new Date('2026-09-19T10:00:00.000Z');

    expect(afterCreatedAt(at, 'm_x')).toEqual({
      $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: 'm_x' } }],
    });
  });
});

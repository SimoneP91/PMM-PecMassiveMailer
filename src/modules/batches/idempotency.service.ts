import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppError } from '../../common/errors/app-error';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { TenantId } from '../../common/types/branded';
import {
  IDEMPOTENCY_MODEL,
  type IdempotencyDocument,
  type StoredResponse,
} from './schemas/idempotency.schema';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const LOCK_MS = 10 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type IdempotencyStart =
  { readonly kind: 'new' } | { readonly kind: 'replay'; readonly response: StoredResponse };

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * "Send the same request twice, get the same answer once."
 *
 * The key is a lock first and a cache second: the record is inserted before
 * the work starts, so a retry that overlaps the original gets a 409 instead
 * of a second batch, and is filled with the response when the work ends.
 * A key reused with a different body is a client bug and is refused.
 */
@Injectable()
export class IdempotencyService {
  public constructor(
    @InjectModel(IDEMPOTENCY_MODEL) private readonly model: Model<IdempotencyDocument>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public static parseKey(header: string | readonly string[] | undefined): string {
    const value = typeof header === 'string' ? header : header?.[0];
    if (value === undefined || value === '') {
      throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required', {
        detail:
          'Send a unique key per batch (a UUID is fine); a retry with the same key returns the same answer',
      });
    }
    if (!KEY_PATTERN.test(value)) {
      throw AppError.badRequest('IDEMPOTENCY_KEY_INVALID', 'Invalid Idempotency-Key', {
        detail: 'letters, digits, ".", "_", ":" and "-" only, up to 200 characters',
      });
    }

    return value;
  }

  public async begin(tenantId: TenantId, key: string, fingerprint: string): Promise<IdempotencyStart> {
    const now = this.clock.now();
    try {
      await this.model.create({
        tenantId,
        key,
        fingerprint,
        state: 'IN_PROGRESS',
        lockedUntil: new Date(now.getTime() + LOCK_MS),
        expiresAt: new Date(now.getTime() + RETENTION_MS),
      });

      return { kind: 'new' };
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await this.model.findOne({ tenantId, key }).lean();
    if (existing === null) {
      // Expired between the insert and the read: try once more.
      return this.begin(tenantId, key, fingerprint);
    }
    if (existing.fingerprint !== fingerprint) {
      throw AppError.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key already used for a different request',
        {
          detail: 'The same key was sent with a different batch or different files; use a new key',
        },
      );
    }
    if (existing.state === 'COMPLETED' && existing.response !== undefined) {
      return { kind: 'replay', response: existing.response };
    }
    if (existing.lockedUntil.getTime() > now.getTime()) {
      throw AppError.conflict('IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed', {
        detail: 'Wait for the first request to finish, then retry with the same key to get its result',
        headers: { 'retry-after': '5' },
      });
    }

    // A previous attempt died mid-way: take the lock over.
    const taken = await this.model.updateOne(
      { tenantId, key, state: 'IN_PROGRESS', lockedUntil: existing.lockedUntil },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    );
    if (taken.modifiedCount === 0) {
      return this.begin(tenantId, key, fingerprint);
    }

    return { kind: 'new' };
  }

  public async complete(tenantId: TenantId, key: string, response: StoredResponse): Promise<void> {
    await this.model.updateOne({ tenantId, key }, { $set: { state: 'COMPLETED', response } });
  }

  /** The request failed before producing a result: let the client retry with the same key. */
  public async abandon(tenantId: TenantId, key: string): Promise<void> {
    await this.model.deleteOne({ tenantId, key, state: 'IN_PROGRESS' });
  }
}

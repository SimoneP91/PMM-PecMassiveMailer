import { Schema } from 'mongoose';

import type { TenantId } from '../../../common/types/branded';

export const IDEMPOTENCY_MODEL = 'IdempotencyKey';

export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface IdempotencyDocument {
  readonly tenantId: TenantId;
  readonly key: string;
  /** SHA-256 over the batch JSON and every file (name, size, hash): "the same request". */
  readonly fingerprint: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly lockedUntil: Date;
  readonly response?: StoredResponse;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export const idempotencySchema = new Schema<IdempotencyDocument>(
  {
    tenantId: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    state: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
    response: {
      type: new Schema(
        { status: Number, headers: { type: Map, of: String }, body: Schema.Types.Mixed },
        { _id: false, minimize: false },
      ),
    },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'idempotency_keys', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

idempotencySchema.index({ tenantId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

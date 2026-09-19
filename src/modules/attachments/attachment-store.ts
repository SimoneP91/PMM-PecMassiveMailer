import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Inject, Injectable } from '@nestjs/common';

import { HashingTap } from '../../common/fs/hashing-tap';
import type { BatchId, TenantId } from '../../common/types/branded';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

export const HEAD_BYTES = 512;

export interface StagedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly head: Buffer;
  /** Set when the stream was cut by a size limit: the file on disk is incomplete. */
  readonly truncated: boolean;
}

export interface StagingArea {
  readonly id: string;
  readonly dir: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Files arrive with the request and are written to disk as they stream in:
 * first to a staging directory named after the request, then - once the
 * batch is accepted - moved under the batch. A rejected request leaves
 * nothing behind.
 *
 * Layout under STORAGE_DIR:
 *   staging/<request id>/<part name>
 *   batches/<tenant id>/<batch id>/parts/<part name>
 */
@Injectable()
export class AttachmentStore {
  private readonly root: string;

  public constructor(@Inject(ENV) env: Env) {
    this.root = resolve(env.STORAGE_DIR);
  }

  public async openStaging(requestId: string): Promise<StagingArea> {
    const dir = this.safeJoin('staging', requestId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await mkdir(dir, { recursive: true });

    return { id: requestId, dir };
  }

  /** Streams a part to the staging area through a hashing tap. Never buffers the file. */
  public async stage(
    area: StagingArea,
    partName: string,
    stream: Readable,
    isTruncated: () => boolean,
  ): Promise<StagedFile> {
    if (!SAFE_NAME.test(partName)) {
      throw new Error(`part name "${partName}" rejected before reaching the store`);
    }
    const path = join(area.dir, partName);
    const tap = new HashingTap(HEAD_BYTES);
    await pipeline(stream, tap, createWriteStream(path, { flags: 'wx' }));
    const { sha256, head } = tap.digest();

    return { path, size: tap.size, sha256, head, truncated: isTruncated() };
  }

  public async commit(area: StagingArea, tenantId: TenantId, batchId: BatchId): Promise<string> {
    const target = this.batchDir(tenantId, batchId);
    await mkdir(resolve(target, '..'), { recursive: true });
    await rename(area.dir, target);

    return target;
  }

  public async discard(area: StagingArea): Promise<void> {
    await rm(area.dir, { recursive: true, force: true });
  }

  public batchDir(tenantId: TenantId, batchId: BatchId): string {
    return this.safeJoin('batches', tenantId, batchId, 'parts');
  }

  /** Relative to STORAGE_DIR with "/" separators: what is recorded in the database. */
  public relative(absolute: string): string {
    if (!absolute.startsWith(this.root + sep)) {
      throw new Error('path is not under the storage root');
    }

    return absolute
      .slice(this.root.length + 1)
      .split(sep)
      .join('/');
  }

  /** The inverse of relative(): an absolute path under the root, or an error. */
  public absolute(relativePath: string): string {
    return this.safeJoin(...relativePath.split('/'));
  }

  private safeJoin(...segments: string[]): string {
    const joined = resolve(this.root, ...segments);
    if (!joined.startsWith(this.root + sep)) {
      throw new Error('path escapes the storage root');
    }

    return joined;
  }
}

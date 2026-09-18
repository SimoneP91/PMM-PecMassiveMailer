import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { BatchId, TenantId } from '../../common/types/branded';

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

  /**
   * Streams a part to the staging area while hashing it, counting it and
   * keeping its first bytes for type detection. Never buffers the file.
   */
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
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let size = 0;

    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
      if (headLength < HEAD_BYTES) {
        const slice = chunk.subarray(0, HEAD_BYTES - headLength);
        headChunks.push(slice);
        headLength += slice.length;
      }
    });
    await pipeline(stream, createWriteStream(path, { flags: 'wx' }));

    return {
      path,
      size,
      sha256: hash.digest('hex'),
      head: Buffer.concat(headChunks),
      truncated: isTruncated(),
    };
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

  /** Relative to STORAGE_DIR, what is recorded in the database. */
  public relative(absolute: string): string {
    return absolute
      .slice(this.root.length + 1)
      .split(sep)
      .join('/');
  }

  private safeJoin(...segments: string[]): string {
    const joined = resolve(this.root, ...segments);
    if (!joined.startsWith(this.root + sep)) {
      throw new Error('path escapes the storage root');
    }

    return joined;
  }
}

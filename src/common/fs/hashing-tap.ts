import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Sits in a pipeline between a source and a file: hashes and counts exactly
 * the bytes that are written, and keeps the first `headBytes` of them.
 */
export class HashingTap extends Transform {
  public size = 0;
  private readonly hash: Hash = createHash('sha256');
  private readonly headChunks: Buffer[] = [];
  private headLength = 0;

  public constructor(private readonly headBytes = 0) {
    super();
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.length;
    this.hash.update(chunk);
    if (this.headLength < this.headBytes) {
      const slice = chunk.subarray(0, this.headBytes - this.headLength);
      this.headChunks.push(slice);
      this.headLength += slice.length;
    }
    callback(null, chunk);
  }

  /** Call once, after the pipeline finished. */
  public digest(): { sha256: string; head: Buffer } {
    return { sha256: this.hash.digest('hex'), head: Buffer.concat(this.headChunks) };
  }
}

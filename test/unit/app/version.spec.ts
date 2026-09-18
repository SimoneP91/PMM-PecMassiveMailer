import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_VERSION } from '../../../src/app/version';

describe('APP_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as {
      version: string;
    };

    expect(APP_VERSION).toBe(pkg.version);
  });
});

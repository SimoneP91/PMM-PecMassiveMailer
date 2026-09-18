import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../../../src/config/env.schema';

const MINIMAL = { MONGODB_URI: 'mongodb://localhost:27017/pecmailer' };

describe('parseEnv', () => {
  it('applies defaults on top of the minimal environment', () => {
    const env = parseEnv(MINIMAL);

    expect(env.NODE_ENV).toBe('development');
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.HTTP_HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.CONFIG_FILE).toBe('./config/pecmailer.yaml');
  });

  it('coerces numbers and booleans from their string form', () => {
    const env = parseEnv({ ...MINIMAL, HTTP_PORT: '8080', LOG_PRETTY: 'true', SWAGGER_ENABLED: 'no' });

    expect(env.HTTP_PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('refuses a missing database uri, naming the variable', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(() => parseEnv({})).toThrow(/MONGODB_URI/);
  });

  it('refuses a database uri that is not mongodb://', () => {
    expect(() => parseEnv({ MONGODB_URI: 'postgres://x' })).toThrow(/MONGODB_URI/);
  });

  it('refuses an out of range port', () => {
    expect(() => parseEnv({ ...MINIMAL, HTTP_PORT: '70000' })).toThrow(/HTTP_PORT/);
    expect(() => parseEnv({ ...MINIMAL, HTTP_PORT: 'abc' })).toThrow(/HTTP_PORT/);
  });

  it('refuses an unknown log level or environment', () => {
    expect(() => parseEnv({ ...MINIMAL, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => parseEnv({ ...MINIMAL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('ignores unrelated variables', () => {
    expect(() => parseEnv({ ...MINIMAL, PATH: '/usr/bin', HOME: '/home/x' })).not.toThrow();
  });
});

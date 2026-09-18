import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One in-memory replica set for the whole e2e run (each test stack gets its
 * own database inside it). Starting mongod is the slow part, not creating a
 * database; and one process downloading the binary avoids two racing for it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', mongo.getUri());

  return async () => {
    await mongo.stop();
  };
}

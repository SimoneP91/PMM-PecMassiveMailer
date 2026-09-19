import type { INestApplicationContext } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { ALL_SCHEMAS } from '../database/all-schemas';

/**
 * Brings the indexes of every collection in line with the schemas: creates
 * the missing ones, drops the ones no schema declares any more. Run once per
 * release, before the new version starts (a Kubernetes Job, or by hand).
 *
 * The API and the worker never do it themselves in production (autoIndex is
 * off): several replicas racing to build and drop indexes at boot is how an
 * outage starts. Some of these indexes carry guarantees - a dedupKey used
 * once per tenant, a ref once per batch - so this command is not optional.
 */
export async function runDbSyncIndexes(app: INestApplicationContext, dryRun: boolean): Promise<number> {
  const connection = app.get<Connection>(getConnectionToken());
  let changes = 0;

  for (const { name, schema } of ALL_SCHEMAS) {
    const model = connection.models[name] ?? connection.model(name, schema);
    await model.createCollection().catch(() => undefined);
    const diff = await model.diffIndexes();
    const toCreate = diff.toCreate.map((spec) => JSON.stringify(spec));
    changes += diff.toCreate.length + diff.toDrop.length;

    console.log(model.collection.collectionName);
    if (toCreate.length === 0 && diff.toDrop.length === 0) {
      console.log('  up to date');
      continue;
    }
    for (const spec of toCreate) {
      console.log(`  + ${spec}`);
    }
    for (const index of diff.toDrop) {
      console.log(`  - ${String(index)}`);
    }
    if (!dryRun) {
      await model.syncIndexes();
      console.log('  synced');
    }
  }

  console.log(
    dryRun ? `\n${String(changes)} change(s) to apply (dry run)` : `\n${String(changes)} change(s) applied`,
  );

  return 0;
}

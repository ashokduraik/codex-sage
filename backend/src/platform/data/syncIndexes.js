/**
 * Explicit Mongoose index sync for development startup and the test harness.
 * Production relies on schema-declared indexes applied deliberately — never autoIndex.
 */

/**
 * Syncs declared indexes for each model (create missing, drop obsolete).
 * @param {import('mongoose').Model[]} models Models whose schemas declare indexes.
 * @returns {Promise<void>}
 */
export async function syncSchemaIndexes(models) {
  if (!Array.isArray(models)) {
    throw new TypeError('syncSchemaIndexes expects an array of models');
  }
  for (const model of models) {
    if (!model || typeof model.syncIndexes !== 'function') {
      throw new TypeError('syncSchemaIndexes received a non-model entry');
    }
    await model.syncIndexes();
  }
}

/** Index layer barrel (SCOPE 0.2). */
export { openDb, defaultDbPath, IndexError, type OpenOptions } from './db.js';
export { runMigrations, getUserVersion, MIGRATIONS, type Migration } from './migrations.js';
export { Repo } from './repo.js';
export type {
  MessageInput,
  MessageRow,
  ContactInput,
  DomainCategoryInput,
  SyncRunStart,
  SyncRunFinish,
  AggregationMessageRow,
  ContactAggregate,
  DomainAggregate,
  ThreadAggregate,
  ContactRow,
  DomainRow,
  ThreadRow,
} from './repo.js';
export {
  SCHEMA_VERSION,
  BODY_STATES,
  BODY_STATE_RANK,
  CATEGORIES,
  CURATIONS,
  DIRECTIONS,
  SYNC_PHASES,
  type BodyState,
  type Category,
  type Curation,
  type Direction,
  type SyncPhase,
} from './schema.js';

/** Intelligence layer barrel (M2). Derived, INDEX-ONLY engines (PLAN §4). */
export {
  aggregateAccount,
  computeAggregates,
  type Aggregates,
} from './aggregate.js';
export {
  computeCadence,
  type CadenceOptions,
  type CadenceRow,
} from './cadence.js';
export { registrableDomain, hostOf } from './domain.js';
export {
  scoreContact,
  interestPass,
  type ContactFeatures,
  type ScoredContact,
  type InterestResult,
  type InterestOptions,
  W_REPLIED,
  W_INITIATED,
  W_IMPORTANT,
  W_READ_RATE,
  W_STARRED,
  W_RECENCY_VOL,
  W_BULK,
  W_NEVER_OPENED,
} from './interest.js';

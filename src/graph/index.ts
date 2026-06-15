/**
 * Graph layer barrel (M2.3, PLAN §9). The ONLY place graphology is imported
 * (D8) — the core index never pulls this in, so skipping a `graph build` leaves
 * sync / enrich / search fully functional.
 */
export {
  buildGraph,
  type GraphBuildOptions,
  type GraphBuildResult,
} from './build.js';

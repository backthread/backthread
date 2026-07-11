// (Slice 1) — the shared file-based-routing extractor.
//
// A pure, reusable LIBRARY (no pipeline wiring): a convention-agnostic route-tree
// model + the Expo Router convention parser. The RN/Expo adapter ( Slice
// B) and the Next.js adapter call these from their FrameworkAdapter
// hooks and map the RouteTree onto contribute-step contributions:
//   * navEdges  → `syntheticEdges` (each a `calls` FrameworkEdge — nav = `calls`)
//   * routes    → `roleTags` (role per fileId; the adapter maps role → ModuleKind)
//   * routePath + parentFileId  → carried as nesting METADATA (NOT an edge)
//
// Slice 1 of 2: Expo Router only. Next (app + pages) / Remix / Nuxt / SvelteKit /
// TanStack are Slice 2 (partly folded into ).

export {
  type RouteRole,
  type RouteNode,
  type RouteNavEdge,
  type RouteTree,
  ROUTE_ROLES,
  normalizeHref,
  buildHrefResolver,
} from './route-tree.js';

export {
  type ExpoRouterOptions,
  EXPO_ROUTER_CONVENTION,
  extractExpoRouterTree,
  findExpoRouterAppDir,
  expoRouteInfo,
} from './expo-router.js';

export {
  type NextRouter,
  NEXT_CONVENTION,
  extractNextRouteTree,
  findNextRouteDirs,
  walkNextSourceFiles,
  nextRouteInfo,
  nextSegmentKey,
} from './next-router.js';

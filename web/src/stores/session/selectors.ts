import type { SessionState } from './types'

/** FTS search slice shared by HomePage and Sidebar. Pair with `useShallow`. */
export function selectSessionSearch(state: SessionState) {
  return {
    searchResults: state.searchResults,
    searchIndexReady: state.searchIndexReady,
    searchIndexMessage: state.searchIndexMessage,
    searchFromServer: state.searchFromServer,
    searchHasMore: state.searchHasMore,
    searchTotal: state.searchTotal,
    searchPending: state.searchPending,
    searchError: state.searchError,
  }
}

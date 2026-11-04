import { ragIndexer } from './indexer.js';

export function projectSearch(query) {
  return ragIndexer.search(query);
}

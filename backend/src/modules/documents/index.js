/**
 * Public surface of the documents module (DocumentSection FTS rows).
 */
export { DocumentSection } from './documentSection.model.js';
export {
  softDeleteSectionsForVersion,
  softDeleteSectionsForPath,
  insertDocumentSections,
  listSectionsForPath,
  countSectionsForVersion,
} from './documentSection.repository.js';
export {
  DOCUMENT_SECTION_MAX_CHARS,
  DOCUMENT_TXT_SECTION_LINE_WINDOW,
  isDocumentPath,
  capSectionText,
  parseDocumentSections,
} from './documentSection.parse.js';

import { DocumentSection } from './documentSection.model.js';

/** Models whose indexes are synced on development API startup / test harness. */
export const DOCUMENT_MODELS = Object.freeze([DocumentSection]);

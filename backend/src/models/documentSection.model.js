/**
 * `documentSections` — one searchable chunk of a docs file.
 * Example: the "## Auth" section of README.md, lines 40–80.
 * Chat retrieval finds these chunks as evidence for an answer.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const documentSectionSchema = createBaseSchema({
  // Project this docs chunk belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Snapshot the chunk was cut from
  sourceVersionId: { type: ObjectId, ref: 'SourceVersion', required: true },
  // File the chunk came from, e.g. README.md
  path: { type: String, required: true, trim: true },
  // Heading at the start of the chunk, e.g. "## Auth"; null if none
  heading: { type: String, default: null },
  // First line of the chunk in that file
  startLine: { type: Number, required: true, min: 1 },
  // Last line of the chunk in that file
  endLine: { type: Number, required: true, min: 1 },
  // Searchable body of the chunk
  text: { type: String, required: true, default: '' },
  // Position of this chunk among others in the same file (0, 1, 2…)
  sectionIndex: { type: Number, required: true, min: 0 },
});

documentSectionSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1, path: 1, sectionIndex: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

documentSectionSchema.index({ orgId: 1, projectId: 1, sourceVersionId: 1, status: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

// Full-text search on heading + body; org/project filters are applied in the query.
documentSectionSchema.index(
  { text: 'text', heading: 'text' },
  {
    weights: { text: 10, heading: 5 },
    name: 'document_sections_text',
  },
);

export const DocumentSection = mongoose.models.DocumentSection ?? mongoose.model('DocumentSection', documentSectionSchema, 'documentSections');

/**
 * `documentSections` — searchable slices of documentation extracted from a
 * source snapshot, used to retrieve evidence for grounded answers.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const documentSectionSchema = createBaseSchema({
  // Project this documentation slice belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Snapshot the section was extracted from
  sourceVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Source file path this section came from
  path: { type: String, required: true, trim: true },
  // Heading that starts the section, when one exists
  heading: { type: String, default: null },
  // First line of the section in the source file
  startLine: { type: Number, required: true, min: 1 },
  // Last line of the section in the source file
  endLine: { type: Number, required: true, min: 1 },
  // Searchable section body
  text: { type: String, required: true, default: '' },
  // Order of this section within the file
  sectionIndex: { type: Number, required: true, min: 0 },
});

documentSectionSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1, path: 1, sectionIndex: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

documentSectionSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

// Text index for phase 38 FTS; compound tenant filters applied at query time.
documentSectionSchema.index(
  { text: 'text', heading: 'text' },
  {
    weights: { text: 10, heading: 5 },
    name: 'document_sections_text',
  },
);

export const DocumentSection =
  mongoose.models.DocumentSection ??
  mongoose.model('DocumentSection', documentSectionSchema, 'documentSections');

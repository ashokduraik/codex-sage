/**
 * DocumentSection Mongoose model — searchable doc slices for a source version.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

const documentSectionSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  sourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  path: {
    type: String,
    required: true,
    trim: true,
  },
  heading: {
    type: String,
    default: null,
  },
  startLine: {
    type: Number,
    required: true,
    min: 1,
  },
  endLine: {
    type: Number,
    required: true,
    min: 1,
  },
  text: {
    type: String,
    required: true,
    default: '',
  },
  sectionIndex: {
    type: Number,
    required: true,
    min: 0,
  },
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

/**
 * Shared source file preview (metadata + line slice drawer) for knowledge and chat.
 */
export { default as SourcePreviewDrawer } from './SourcePreviewDrawer.jsx';
export { useSourcePreview } from './useSourcePreview.js';
export { fetchSourceFileMetadata, fetchSourceSlice, sourcePreviewQueryKey } from './sourcePreviewApi.js';

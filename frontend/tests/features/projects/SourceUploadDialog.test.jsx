import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/index';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

const mutateAsync = vi.fn();
const reset = vi.fn();
const resetProgress = vi.fn();
let hookError = null;
let hookProgress = { loaded: 0, total: 0 };

vi.mock('@/features/projects/hooks/useUploadSource.js', () => ({
  useUploadSource: () => {
    const [pending, setPending] = useState(false);
    return {
      mutateAsync: async (...args) => {
        setPending(true);
        try {
          return await mutateAsync(...args);
        } catch (error) {
          hookError = error;
          throw error;
        } finally {
          setPending(false);
        }
      },
      isPending: pending,
      get error() {
        return hookError;
      },
      reset,
      resetProgress,
      progress: hookProgress,
    };
  },
}));

import { SourceUploadDialog } from '@/features/projects/SourceUploadDialog';

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  reset.mockReset();
  resetProgress.mockReset();
  hookError = null;
  hookProgress = { loaded: 0, total: 0 };
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

/**
 * @returns {HTMLInputElement}
 */
function getZipInput() {
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  expect(input.getAttribute('accept')).toContain('.zip');
  return input;
}

describe('SourceUploadDialog', () => {
  it('uploads a ZIP and calls onUploaded with ids from 202', async () => {
    mutateAsync.mockResolvedValue({ sourceVersionId: 'sv1', jobId: 'j1' });
    const onUploaded = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <SourceUploadDialog
        open
        onOpenChange={onOpenChange}
        projectId="prj_atlas"
        onUploaded={onUploaded}
      />,
    );
    expect(screen.getByText(/Folder upload is not supported/i)).toBeTruthy();
    const zip = new File(['pk'], 'src.zip', { type: 'application/zip' });
    fireEvent.change(getZipInput(), { target: { files: [zip] } });
    expect(screen.getByText('src.zip')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith({ sourceVersionId: 'sv1', jobId: 'j1' });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'prj_atlas', file: zip }),
    );
  });

  it('shows SOURCE_ZIP_SLIP and a correlation id', async () => {
    const error = new ApiError({
      status: 400,
      code: 'SOURCE_ZIP_SLIP',
      message: 'Unsafe archive path',
      correlationId: 'corr-slip',
    });
    mutateAsync.mockRejectedValue(error);
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(getZipInput(), {
      target: { files: [new File(['pk'], 'bad.zip', { type: 'application/zip' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unsafe archive path')).toBeTruthy();
    expect(screen.getByText('corr-slip')).toBeTruthy();
  });

  it('rejects a non-zip selection with folder-unsupported copy', () => {
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(getZipInput(), {
      target: { files: [new File(['x'], 'readme.md', { type: 'text/plain' })] },
    });
    expect(screen.getAllByText(/Folder upload is not supported/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('readme.md')).toBeNull();
  });

  it('cancels from the pick stage', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={onOpenChange} projectId="prj_atlas" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows 403 and IDEMPOTENCY_IN_FLIGHT messages', async () => {
    mutateAsync.mockRejectedValueOnce(
      new ApiError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Missing sources.upload',
        correlationId: 'corr-403',
      }),
    );
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(getZipInput(), {
      target: { files: [new File(['pk'], 'src.zip', { type: 'application/zip' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText('Missing sources.upload')).toBeTruthy();
    expect(screen.getByText('corr-403')).toBeTruthy();

    mutateAsync.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: 'IDEMPOTENCY_IN_FLIGHT',
        message: 'in flight',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText(/still processing/i)).toBeTruthy();
  });

  it('issues a new Idempotency-Key after a network failure', async () => {
    mutateAsync
      .mockRejectedValueOnce(
        new ApiError({ status: 0, code: 'NETWORK', message: 'offline' }),
      )
      .mockResolvedValueOnce({ sourceVersionId: 'sv2', jobId: 'j2' });
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(getZipInput(), {
      target: { files: [new File(['pk'], 'src.zip', { type: 'application/zip' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText('offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[0][0].idempotencyKey).not.toBe(
      mutateAsync.mock.calls[1][0].idempotencyKey,
    );
  });

  it('constrains the dialog width on a 375px viewport', () => {
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.className).toContain('w-[calc(100vw-1.5rem)]');
  });

  it('accepts a dropped ZIP, shows size units, and pending progress', async () => {
    let resolveUpload;
    mutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    hookProgress = { loaded: 512, total: 1024 };
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    const dropzone = screen.getByText(/Drag & drop a ZIP archive/i).parentElement;
    fireEvent.dragOver(dropzone, { preventDefault() {} });
    fireEvent.dragLeave(dropzone);
    const zip = new File([new Uint8Array(2048)], 'pack.zip', { type: 'application/zip' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [zip] } });
    expect(screen.getByText('pack.zip')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText(/Uploading archive/i)).toBeTruthy();
    resolveUpload({ sourceVersionId: 'sv3', jobId: 'j3' });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  });

  it('formats megabyte sizes and accepts zip mime without a .zip name', () => {
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    const large = new File([new Uint8Array(1024 * 1024 + 10)], 'archive.bin', {
      type: 'application/x-zip-compressed',
    });
    fireEvent.change(getZipInput(), { target: { files: [large] } });
    expect(screen.getByText('archive.bin')).toBeTruthy();
    expect(screen.getByText(/MB/)).toBeTruthy();
  });

  it('clears a missing file selection and surfaces a non-ApiError message', async () => {
    mutateAsync.mockRejectedValue('offline-now');
    renderWithProviders(
      <SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas" />,
    );
    fireEvent.change(getZipInput(), { target: { files: [] } });
    fireEvent.change(getZipInput(), {
      target: { files: [new File(['pk'], 'src.zip', { type: 'application/zip' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(await screen.findByText('offline-now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  });
});

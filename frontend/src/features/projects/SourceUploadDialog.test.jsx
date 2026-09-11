import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import { SourceUploadDialog } from './SourceUploadDialog';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
/**
 * Build a File with an optional webkitRelativePath for upload analysis.
 *
 * @param name - File name
 * @param contents - File contents
 * @param relativePath - Optional relative path
 * @returns File with optional webkitRelativePath
 */
function buildUploadFile(name, contents = 'hello', relativePath) {
    const file = new File([contents], name, { type: 'text/plain' });
    if (relativePath) {
        Object.defineProperty(file, 'webkitRelativePath', {
            value: relativePath,
            configurable: true,
        });
    }
    return file;
}
describe('SourceUploadDialog', () => {
    /**
     * File inputs are portaled with the dialog, so query the document.
     *
     * @returns The multi-file / ZIP input
     */
    function getFilesInput() {
        const inputs = document.querySelectorAll('input[type="file"]');
        expect(inputs.length).toBeGreaterThanOrEqual(2);
        return inputs[1];
    }
    it('analyzes selected files and completes an upload', async () => {
        const onUploaded = vi.fn();
        const onOpenChange = vi.fn();
        renderWithProviders(<SourceUploadDialog open onOpenChange={onOpenChange} projectId="prj_atlas" onUploaded={onUploaded}/>);
        expect(screen.getByRole('heading', { name: 'Upload source' })).toBeTruthy();
        const filesInput = getFilesInput();
        const kept = buildUploadFile('readme.md', 'docs', 'src/readme.md');
        const noisy = buildUploadFile('index.js', 'x', 'node_modules/pkg/index.js');
        fireEvent.change(filesInput, { target: { files: [kept, noisy] } });
        expect(await screen.findByText('Start processing')).toBeTruthy();
        expect(screen.getByText('src/readme.md')).toBeTruthy();
        expect(screen.getByText(/auto-excluded/i)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
        expect(await screen.findByText('Upload complete')).toBeTruthy();
        const closeButtons = screen.getAllByRole('button', { name: 'Close' });
        // DialogContent's absolute X is last; the footer action is earlier.
        fireEvent.click(closeButtons[0]);
        expect(onUploaded).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    it('rejects a ZIP that embeds excluded noise folders', async () => {
        renderWithProviders(<SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas"/>);
        const filesInput = getFilesInput();
        const zip = buildUploadFile('project.zip', 'zip', 'node_modules/a.js');
        fireEvent.change(filesInput, { target: { files: [zip] } });
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByText(/excluded folders/i)).toBeTruthy();
    });
    it('resets the preview selection', async () => {
        renderWithProviders(<SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas"/>);
        const filesInput = getFilesInput();
        fireEvent.change(filesInput, {
            target: { files: [buildUploadFile('a.ts', 'code')] },
        });
        expect(await screen.findByText('Start processing')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
        expect(screen.getByText(/Drag & drop/i)).toBeTruthy();
    });
    it('accepts a folder drop onto the drop zone', async () => {
        renderWithProviders(<SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas"/>);
        const dropZone = screen.getByText(/Drag & drop/i).parentElement;
        expect(dropZone).toBeTruthy();
        const file = buildUploadFile('main.ts', 'code', 'app/main.ts');
        const dataTransfer = {
            items: [
                {
                    kind: 'file',
                    getAsFile: () => file,
                    webkitGetAsEntry: () => ({ isDirectory: false }),
                },
            ],
            files: [file],
        };
        fireEvent.dragOver(dropZone);
        fireEvent.drop(dropZone, { dataTransfer });
        await waitFor(() => {
            expect(screen.getByText('Start processing')).toBeTruthy();
        });
    });
    it('cancels from the pick stage', () => {
        const onOpenChange = vi.fn();
        renderWithProviders(<SourceUploadDialog open onOpenChange={onOpenChange} projectId="prj_atlas"/>);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    it('formats file sizes across byte ranges in the preview list', async () => {
        renderWithProviders(<SourceUploadDialog open onOpenChange={() => undefined} projectId="prj_atlas"/>);
        const filesInput = getFilesInput();
        const tiny = new File(['x'], 'tiny.txt');
        const kilo = new File(['x'], 'mid.bin');
        Object.defineProperty(kilo, 'size', { value: 2048 });
        const mega = new File(['x'], 'big.bin');
        Object.defineProperty(mega, 'size', { value: 1024 * 1024 + 10 });
        fireEvent.change(filesInput, { target: { files: [tiny, kilo, mega] } });
        expect(await screen.findByText('1 B')).toBeTruthy();
        expect(screen.getByText('2 KB')).toBeTruthy();
        expect(screen.getByText('1.0 MB')).toBeTruthy();
    });
});

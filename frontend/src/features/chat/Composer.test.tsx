import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import { Composer } from './Composer';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('Composer', () => {
  it('submits and calls onSend with trimmed text', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    renderWithProviders(
      <Composer onSend={onSend} onStop={onStop} />,
    );

    const input = screen.getByPlaceholderText(
      'Ask anything about this project…',
    );
    fireEvent.change(input, { target: { value: '  How does auth work?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('How does auth work?');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send when disabled or empty', () => {
    const onSend = vi.fn();
    renderWithProviders(
      <Composer onSend={onSend} onStop={() => undefined} disabled />,
    );

    const input = screen.getByPlaceholderText(
      'Ask anything about this project…',
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows stop control while generating', () => {
    const onStop = vi.fn();
    renderWithProviders(
      <Composer
        onSend={() => undefined}
        onStop={onStop}
        isGenerating
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('submits on Enter without Shift', () => {
    const onSend = vi.fn();
    renderWithProviders(
      <Composer onSend={onSend} onStop={() => undefined} />,
    );

    const input = screen.getByPlaceholderText(
      'Ask anything about this project…',
    );
    fireEvent.change(input, { target: { value: 'Explain checkout' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('Explain checkout');
  });

  it('shows queued and context warning notices', () => {
    renderWithProviders(
      <Composer
        onSend={() => undefined}
        onStop={() => undefined}
        queued
        contextWarning
      />,
    );
    expect(screen.getByText(/queued/i)).toBeTruthy();
    expect(screen.getByText(/context/i)).toBeTruthy();
  });
});

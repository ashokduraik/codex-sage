import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import { CreateProjectDialog } from './CreateProjectDialog';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('CreateProjectDialog', () => {
  it('opens and creates a project via upload path', async () => {
    renderWithProviders(
      <CreateProjectDialog open={true} onOpenChange={() => undefined} />,
    );

    expect(screen.getByRole('heading', { name: 'Create project' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Nova Retail' },
    });
    fireEvent.click(screen.getByText('Upload source'));

    const continueButton = screen.getByRole('button', {
      name: /Continue to upload/i,
    }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);

    expect(
      await screen.findByRole('heading', { name: 'Upload source' }),
    ).toBeTruthy();
  });

  it('keeps continue disabled until name and source type are set', () => {
    renderWithProviders(
      <CreateProjectDialog open={true} onOpenChange={() => undefined} />,
    );

    expect(
      (screen.getByRole('button', { name: /Next/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Nova Retail' },
    });
    expect(
      (screen.getByRole('button', { name: /Next/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('opens the connect-repository flow for the repo source type', async () => {
    renderWithProviders(
      <CreateProjectDialog open={true} onOpenChange={() => undefined} />,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Repo Project' },
    });
    fireEvent.click(screen.getByText('Connect repository'));
    const continueButton = screen.getByRole('button', {
      name: /Continue to connect/i,
    }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);
    expect(
      await screen.findByRole('heading', { name: 'Connect repository' }),
    ).toBeTruthy();
  });
});

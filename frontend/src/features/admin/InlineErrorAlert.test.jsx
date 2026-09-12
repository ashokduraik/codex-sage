import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/shared/i18n';
import { InlineErrorAlert } from './InlineErrorAlert';

afterEach(() => {
  cleanup();
});

describe('InlineErrorAlert', () => {
  it('renders nothing when message is empty', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <InlineErrorAlert message="" />
      </I18nextProvider>,
    );
    expect(container.textContent).toBe('');
  });

  it('renders the message and optional correlation id', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <InlineErrorAlert message="Boom" correlationId="c-9" />
      </I18nextProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Boom');
    expect(screen.getByText(/c-9/)).toBeTruthy();
  });

  it('omits correlation when absent', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <InlineErrorAlert message="Boom" />
      </I18nextProvider>,
    );
    expect(screen.getByText('Boom')).toBeTruthy();
    expect(screen.queryByText(/Support reference/i)).toBeNull();
  });
});

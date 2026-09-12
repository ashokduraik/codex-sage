import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/shared/i18n';
import { RoleMultiSelect } from './RoleMultiSelect';

afterEach(() => {
  cleanup();
});

/**
 * @param {import('react').ReactElement} ui
 */
function renderSelect(ui) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('RoleMultiSelect', () => {
  it('shows an empty message when no roles are available', () => {
    renderSelect(
      <RoleMultiSelect roles={[]} selectedRoleIds={[]} onChange={() => {}} />,
    );
    expect(screen.getByText('No roles available to assign.')).toBeTruthy();
  });

  it('toggles roles on and off', () => {
    const onChange = vi.fn();
    renderSelect(
      <RoleMultiSelect
        roles={[
          { id: 'r1', name: 'Viewer' },
          { id: 'r2', name: 'Member' },
        ]}
        selectedRoleIds={['r1']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Member'));
    expect(onChange).toHaveBeenCalledWith(['r1', 'r2']);

    fireEvent.click(screen.getByLabelText('Viewer'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

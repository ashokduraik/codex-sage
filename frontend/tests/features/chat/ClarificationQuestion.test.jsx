/**
 * ClarificationQuestion type-specific controls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClarificationQuestion } from '@/features/chat/ClarificationQuestion.jsx';

afterEach(() => {
  cleanup();
});

describe('ClarificationQuestion', () => {
  it('toggles multi_select options', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ClarificationQuestion
        question={{
          id: 'q2',
          type: 'multi_select',
          prompt: 'Areas?',
          options: ['orders', 'payments'],
          required: true,
        }}
        value={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Areas?')).toBeTruthy();
    fireEvent.click(screen.getByDisplayValue('orders'));
    expect(onChange).toHaveBeenCalledWith(['orders']);
    rerender(
      <ClarificationQuestion
        question={{
          id: 'q2',
          type: 'multi_select',
          prompt: 'Areas?',
          options: ['orders', 'payments'],
          required: true,
        }}
        value={['orders']}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByDisplayValue('orders'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('renders unsupported type as an alert', () => {
    render(<ClarificationQuestion question={{ id: 'q9', type: 'unknown_type', prompt: 'Nope' }} value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/not supported/i);
  });

  it('returns null when question is missing', () => {
    const { container } = render(<ClarificationQuestion question={null} value={undefined} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

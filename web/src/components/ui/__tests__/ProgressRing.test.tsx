import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressRing } from '../ProgressRing';

describe('ProgressRing (render smoke)', () => {
  it('renders the rounded percentage as text', () => {
    render(<ProgressRing percentage={73.4} />);
    expect(screen.getByText('73')).toBeInTheDocument();
  });

  it('clamps the displayed value and renders an svg', () => {
    const { container } = render(<ProgressRing percentage={150} />);
    expect(screen.getByText('150')).toBeInTheDocument(); // label shows raw rounded value
    // two <circle> elements (track + progress) inside one svg
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('exposes a phase tooltip when provided', () => {
    const { container } = render(<ProgressRing percentage={42} phase="Building" />);
    const wrapper = container.querySelector('[title]');
    expect(wrapper?.getAttribute('title')).toBe('Building — 42%');
  });
});

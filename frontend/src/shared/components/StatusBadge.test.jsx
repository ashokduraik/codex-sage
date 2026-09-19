import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KnowledgeHealthBadge,
  KnowledgeStatusBadge,
  ProjectLifecycleBadge,
  ProjectStatusBadge,
} from '@/shared/components/StatusBadge';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('StatusBadge', () => {
  it('renders a project status label', () => {
    clearAuthSession();
    renderWithProviders(<ProjectStatusBadge status="Knowledge ready" />);
    expect(screen.getByText('Knowledge ready')).toBeTruthy();
  });

  it('renders a knowledge status label with a status dot', () => {
    renderWithProviders(<KnowledgeStatusBadge status="Ready" />);
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('falls back gracefully for unknown statuses', () => {
    renderWithProviders(<ProjectStatusBadge status="Mystery" />);
    expect(screen.getByText('Mystery')).toBeTruthy();
  });

  it('renders lifecycle and knowledge-health badges from backend codes', () => {
    renderWithProviders(
      <>
        <ProjectLifecycleBadge code="knowledge_ready" />
        <ProjectLifecycleBadge code="partially_available" />
        <ProjectLifecycleBadge code="failed" />
        <ProjectLifecycleBadge code="processing" />
        <ProjectLifecycleBadge code="future_state" />
        <KnowledgeHealthBadge code="ready" />
        <KnowledgeHealthBadge code="stale" />
        <KnowledgeHealthBadge code="failed" />
        <KnowledgeHealthBadge code="partially_available" />
        <KnowledgeHealthBadge code="none" />
        <KnowledgeHealthBadge code="mystery" />
      </>,
    );
    expect(screen.getByText('Knowledge ready')).toBeTruthy();
    expect(screen.getAllByText('Partially available').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Outdated')).toBeTruthy();
    expect(screen.getByText('Unknown status')).toBeTruthy();
    expect(screen.getByText('Unknown health')).toBeTruthy();
  });

  it('covers mock knowledge style keys including unknown', () => {
    renderWithProviders(
      <>
        <KnowledgeStatusBadge status="Ready" />
        <KnowledgeStatusBadge status="Updating" />
        <KnowledgeStatusBadge status="Needs attention" />
        <KnowledgeStatusBadge status="Outdated" />
        <KnowledgeStatusBadge status="Partially available" />
        <KnowledgeStatusBadge status="Mystery" />
        <ProjectStatusBadge status="Failed" />
        <ProjectStatusBadge status="Archived" />
      </>,
    );
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Outdated')).toBeTruthy();
    expect(screen.getByText('Mystery')).toBeTruthy();
  });
});

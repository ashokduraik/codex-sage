import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, Route, Routes } from 'react-router-dom';
import ScrollToTop from '@/shared/components/ScrollToTop';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});
describe('ScrollToTop', () => {
    beforeEach(() => {
        clearAuthSession();
        localStorage.clear();
    });
    it('scrolls to top on push navigation without a hash', () => {
        const scrollTo = vi.fn();
        window.scrollTo = scrollTo;
        renderWithProviders(<>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Link to="/projects">Go projects</Link>}/>
          <Route path="/projects" element={<div>Projects</div>}/>
        </Routes>
      </>, { route: '/' });
        fireEvent.click(screen.getByRole('link', { name: 'Go projects' }));
        expect(scrollTo).toHaveBeenCalled();
    });
    it('scrolls a hash target into view after a short delay', () => {
        vi.useFakeTimers();
        const scrollIntoView = vi.fn();
        const target = document.createElement('div');
        target.id = 'section-a';
        target.scrollIntoView = scrollIntoView;
        document.body.appendChild(target);
        renderWithProviders(<>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Link to="/docs#section-a">Go hash</Link>}/>
          <Route path="/docs" element={<div>Docs</div>}/>
        </Routes>
      </>, { route: '/' });
        fireEvent.click(screen.getByRole('link', { name: 'Go hash' }));
        vi.advanceTimersByTime(60);
        expect(scrollIntoView).toHaveBeenCalled();
        target.remove();
    });
});

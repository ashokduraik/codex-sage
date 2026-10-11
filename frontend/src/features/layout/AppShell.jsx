import Header from './Header';
import Sidebar from './Sidebar';
import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sheet, SheetContent } from '@/shared/ui/sheet';

/**
 * Authenticated application chrome: sidebar (desktop + mobile sheet) and header.
 *
 * @returns Shell layout wrapping nested route content via Outlet.
 */
export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="hidden lg:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[232px] p-0">
          <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenu={() => setMobileOpen(true)} />
        <main key={location.pathname} className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

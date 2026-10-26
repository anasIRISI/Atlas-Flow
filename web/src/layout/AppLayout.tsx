import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import type { PublicUser } from '@flowforge/shared';
import { wsClient } from '../lib/ws';
import { Sidebar } from './Sidebar';

const COLLAPSE_KEY = 'ff.sidebarCollapsed';

export function AppLayout({ user }: { user: PublicUser }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' || window.matchMedia('(max-width: 768px)').matches; }
    catch { return window.matchMedia('(max-width: 768px)').matches; }
  });

  // Stays connected while moving between pages and the editor; signing out disconnects.
  useEffect(() => {
    wsClient.connect();
  }, []);

  const toggle = () =>
    setCollapsed((value) => {
      try { localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1'); } catch { /* Storage can be disabled. */ }
      return !value;
    });

  return (
    <div className="flex h-full">
      <Sidebar user={user} collapsed={collapsed} onToggle={toggle} />
      <main className="atlas-content min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

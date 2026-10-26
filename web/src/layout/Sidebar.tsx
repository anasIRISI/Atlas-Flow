import { NavLink, useNavigate } from 'react-router';
import { LogOut, PanelLeftClose, PanelLeftOpen, Play } from 'lucide-react';
import type { PublicUser } from '@flowforge/shared';
import { Logo } from '../components/Logo';
import { cn } from '../components/ui/cn';
import { useLogout } from '../lib/auth';
import { startDemo, useDemo } from '../demo/demo-store';
import { ConnectionIndicator } from './ConnectionIndicator';
import { MAIN_NAV, SETTINGS_NAV, type NavItem } from './nav';

function NavEntry({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-3 rounded-md px-3 text-[13.5px] font-medium transition-colors',
          collapsed && 'justify-center px-0',
          isActive ? 'bg-accent-soft text-sky-300 ring-1 ring-sky-400/20' : 'text-muted hover:bg-panel-3 hover:text-fg',
        )
      }
    >
      <Icon size={18} className="shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

export function Sidebar({ user, collapsed, onToggle }: { user: PublicUser; collapsed: boolean; onToggle: () => void }) {
  const logout = useLogout();
  const navigate = useNavigate();
  const starting = useDemo((s) => s.starting);
  const initials = `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase() || '?';
  return (
    <aside
      className={cn(
        'atlas-sidebar flex h-full shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200',
        collapsed ? 'w-[56px]' : 'w-[240px]',
      )}
    >
      <div className={cn('flex h-14 items-center border-b border-line', collapsed ? 'justify-center' : 'justify-between px-4')}>
        {!collapsed && <Logo />}
        <button
          onClick={onToggle}
          className="rounded-md p-1.5 text-subtle hover:bg-panel-3 hover:text-fg"
          aria-label={collapsed ? 'Ouvrir le menu' : 'Réduire le menu'}
          title={collapsed ? 'Ouvrir le menu' : 'Réduire le menu'}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Navigation principale">
        {MAIN_NAV.map((item) => (
          <NavEntry key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-line p-2">
        <button
          onClick={() => void startDemo(navigate)}
          disabled={starting}
          className={cn('flex h-9 items-center gap-2.5 rounded-md bg-accent-soft px-2.5 text-[13px] font-medium text-accent hover:bg-accent hover:text-white disabled:opacity-60', collapsed && 'justify-center px-0')}
          title="Démo guidée"
          data-testid="demo-mode-button"
        >
          <Play size={16} />
          {!collapsed && (starting ? 'Chargement…' : 'Démo guidée')}
        </button>
        <NavEntry item={SETTINGS_NAV} collapsed={collapsed} />
        <ConnectionIndicator collapsed={collapsed} />
        <div className={cn('flex items-center gap-2.5 rounded-md p-2', collapsed && 'flex-col p-1')}>
          <div
            className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-600 to-teal-600 text-[12px] font-semibold text-white"
            title={`${user.firstName} ${user.lastName}`.trim()}
          >
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium" data-testid="user-name">
                {`${user.firstName} ${user.lastName}`.trim()}
              </div>
              <div className="truncate text-[12px] text-subtle">{user.email}</div>
            </div>
          )}
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="rounded-md p-1.5 text-subtle hover:bg-panel-3 hover:text-fg"
            aria-label="Se déconnecter"
            title="Se déconnecter"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

import type { ReactElement } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import type { PublicUser } from '@flowforge/shared';
import { FullScreenError, FullScreenLoader } from '../components/FullScreen';
import { errorMessage } from '../lib/api';
import { useAuthStatus } from '../lib/auth';
import { safeRedirect } from '../pages/SignInPage';

/** Renders children only for a signed-in user; otherwise redirects to setup or sign-in. */
export function RequireAuth({ children }: { children: (user: PublicUser) => ReactElement }) {
  const status = useAuthStatus();
  const location = useLocation();
  if (status.isPending) return <FullScreenLoader />;
  if (status.isError) return <FullScreenError message={errorMessage(status.error)} onRetry={() => void status.refetch()} />;
  if (status.data.setupRequired) return <Navigate to="/setup" replace />;
  if (!status.data.user) {
    const here = location.pathname + location.search;
    const target = here === '/' || here === '/home' ? '/signin' : `/signin?redirect=${encodeURIComponent(here)}`;
    return <Navigate to={target} replace />;
  }
  return children(status.data.user);
}

/** Setup and sign-in screens: only reachable when they make sense. */
export function PublicOnly({ page, children }: { page: 'setup' | 'signin'; children: ReactElement }) {
  const status = useAuthStatus();
  const [params] = useSearchParams();
  if (status.isPending) return <FullScreenLoader />;
  if (status.isError) return <FullScreenError message={errorMessage(status.error)} onRetry={() => void status.refetch()} />;
  if (status.data.user) return <Navigate to={safeRedirect(params.get('redirect'))} replace />;
  if (page === 'signin' && status.data.setupRequired) return <Navigate to="/setup" replace />;
  if (page === 'setup' && !status.data.setupRequired) return <Navigate to="/signin" replace />;
  return children;
}

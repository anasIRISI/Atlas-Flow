import { lazy, Suspense } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import type { AuthStatus } from '@flowforge/shared';
import { FullScreenLoader } from '../components/FullScreen';
import { Toaster } from '../components/Toaster';
import { AppLayout } from '../layout/AppLayout';
import { ApiError } from '../lib/api';
import { AUTH_STATUS_KEY } from '../lib/auth';
import { CredentialsPage } from '../pages/CredentialsPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { DashboardPage } from '../pages/DashboardPage';
import { GuidePage } from '../pages/GuidePage';
import { ExecutionDetailPage } from '../pages/ExecutionDetailPage';
import { ExecutionsPage } from '../pages/ExecutionsPage';
import { TemplatesPage } from '../pages/TemplatesPage';
import { VariablesPage } from '../pages/VariablesPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SetupPage } from '../pages/SetupPage';
import { SignInPage } from '../pages/SignInPage';
import { WorkflowsPage } from '../pages/WorkflowsPage';
import { PublicOnly, RequireAuth } from './guards';

/** A 401 "unauthorized" anywhere means the session expired: drop the user so the guard shows sign-in. */
function handleSessionExpired(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && error.code === 'unauthorized') {
    queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, (s) => (s ? { ...s, user: null } : s));
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleSessionExpired }),
  mutationCache: new MutationCache({ onError: handleSessionExpired }),
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// The editor (canvas, CodeMirror, all node icons) is loaded only when a workflow is opened.
const EditorPage = lazy(() => import('../editor/EditorPage').then((m) => ({ default: m.EditorPage })));

// A data router is needed for useBlocker (unsaved-changes warning in the editor).
const router = createBrowserRouter([
  {
    path: '/setup',
    element: (
      <PublicOnly page="setup">
        <SetupPage />
      </PublicOnly>
    ),
  },
  {
    path: '/signin',
    element: (
      <PublicOnly page="signin">
        <SignInPage />
      </PublicOnly>
    ),
  },
  {
    path: '/workflow/:id',
    element: (
      <RequireAuth>
        {() => (
          <Suspense fallback={<FullScreenLoader />}>
            <EditorPage />
          </Suspense>
        )}
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: <RequireAuth>{(user) => <AppLayout user={user} />}</RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'home', element: <DashboardPage /> },
      { path: 'guide', element: <GuidePage /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'executions', element: <ExecutionsPage /> },
      { path: 'executions/:id', element: <ExecutionDetailPage /> },
      { path: 'credentials', element: <CredentialsPage /> },
      { path: 'variables', element: <VariablesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

function Root() {
  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}


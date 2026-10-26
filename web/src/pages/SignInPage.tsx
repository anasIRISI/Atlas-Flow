import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { errorMessage } from '../lib/api';
import { useLogin } from '../lib/auth';
import { useTitle } from '../lib/useTitle';
import { AuthLayout } from './AuthLayout';

/** Only allow redirects to paths inside this app (no open redirects). */
export function safeRedirect(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/home';
}

export function SignInPage() {
  useTitle('Connexion');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email, password },
      { onSuccess: () => navigate(safeRedirect(params.get('redirect')), { replace: true }) },
    );
  };

  return (
    <AuthLayout title="Heureux de te revoir." subtitle="Connecte-toi à ton espace Atlas Flow.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {login.isError && <Alert>{errorMessage(login.error)}</Alert>}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <Field
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" size="lg" loading={login.isPending} className="mt-2">
          Se connecter
        </Button>
        <p className="text-center text-[12px] text-subtle">
          Mot de passe oublié ? Lance <code className="font-mono text-muted">npm run user:reset</code> dans le terminal du projet.
        </p>
      </form>
    </AuthLayout>
  );
}

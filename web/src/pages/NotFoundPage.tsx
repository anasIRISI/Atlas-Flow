import { Link } from 'react-router';
import { useTitle } from '../lib/useTitle';

export function NotFoundPage() {
  useTitle('Page not found');
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <p className="font-mono text-5xl font-semibold text-accent">404</p>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <Link to="/home" className="text-accent-hover hover:underline">
          Back to Overview
        </Link>
      </div>
    </div>
  );
}

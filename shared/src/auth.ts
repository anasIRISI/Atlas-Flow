export type UserRole = 'owner' | 'member';

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthStatus {
  /** True until the owner account has been created (first run). */
  setupRequired: boolean;
  user: PublicUser | null;
}

export interface SetupRequest {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

export interface PasswordRule {
  id: 'length' | 'number' | 'uppercase';
  label: string;
  test: (password: string) => boolean;
}

/** Same policy as n8n: 8+ characters, at least one number and one capital letter. */
export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: 'length',
    label: `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH && p.length <= PASSWORD_MAX_LENGTH,
  },
  { id: 'number', label: 'At least 1 number', test: (p) => /\d/.test(p) },
  { id: 'uppercase', label: 'At least 1 capital letter', test: (p) => /[A-Z]/.test(p) },
];

/** Returns the labels of the rules the password breaks (empty array = valid). */
export function passwordProblems(password: string): string[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

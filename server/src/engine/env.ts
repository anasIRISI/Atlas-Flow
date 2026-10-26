/** Environment variables that look like secrets are never visible to `$env`. */
const SECRET = /(SECRET|PASS|TOKEN|KEY|PRIVATE|CREDENTIAL|SESSION|COOKIE|AUTH|WEBHOOK_URL|SMTP_USER)/i;

export function publicEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SECRET.test(key) || key.startsWith('npm_')) continue;
    out[key] = value;
  }
  return out;
}

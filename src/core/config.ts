import path from 'path';
import fs from 'fs';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const root = path.resolve(__dirname, '..', '..');

function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

export const config = {
  root,
  port: envInt('PORT', 8088),
  host: process.env.HOST ?? '0.0.0.0',

  /** Where the SQLite file lives. `:memory:` is supported for tests. */
  dbFile: process.env.APALEO_DB ?? path.join(root, 'data', 'apaleo.db'),

  specDir: path.join(root, 'specs'),
  /**
   * Static assets for the docs UI. The compiled output carries its own copy,
   * so a `dist`-only deployment still serves them; running from source falls
   * back to `src/web`.
   */
  webDir: firstExisting([
    path.join(root, 'dist', 'web'),
    path.join(root, 'src', 'web'),
  ]),

  /** Signing key for the tokens our fake identity server issues. */
  jwtSecret: process.env.APALEO_JWT_SECRET ?? 'apaleo-clone-development-secret',
  tokenTtlSeconds: envInt('APALEO_TOKEN_TTL', 3600),

  /**
   * When true every request is treated as a fully authorized admin, which makes
   * the clone convenient to poke at with curl. Turn it off to exercise the real
   * OAuth2 client-credentials flow and scope checks.
   */
  allowAnonymous: envBool('APALEO_ALLOW_ANONYMOUS', true),

  /** Max page size the real API enforces. */
  maxPageSize: envInt('APALEO_MAX_PAGE_SIZE', 500),
  defaultPageSize: envInt('APALEO_DEFAULT_PAGE_SIZE', 100),

  /** Validate request bodies against the downloaded Swagger definitions. */
  validateRequests: envBool('APALEO_VALIDATE', true),
};

export type Config = typeof config;

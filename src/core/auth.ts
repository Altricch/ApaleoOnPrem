import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { forbidden, unauthorized } from './errors';

/**
 * The real apaleo sits behind `identity.apaleo.com`, an IdentityServer that
 * issues JWTs via the OAuth2 client-credentials and authorization-code flows.
 * We run a small stand-in on the same route shapes (`/connect/token`,
 * `/connect/authorize`, `/.well-known/openid-configuration`) so SDKs and
 * Postman collections configured against apaleo authenticate unchanged.
 */

export interface Principal {
  subject: string;
  clientId: string;
  accountCode: string;
  scopes: Set<string>;
  /** Property codes this principal may touch; empty set means "all". */
  properties: Set<string>;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  accountCode: string;
}

/**
 * Registered clients. The default one mirrors apaleo's own sandbox ergonomics:
 * full access, so a fresh checkout is usable immediately.
 */
const clients = new Map<string, OAuthClient>();

export function registerClient(c: OAuthClient): void {
  clients.set(c.clientId, c);
}

export function listClients(): OAuthClient[] {
  return [...clients.values()];
}

registerClient({
  clientId: process.env.APALEO_CLIENT_ID ?? 'apaleo-clone',
  clientSecret: process.env.APALEO_CLIENT_SECRET ?? 'secret',
  name: 'Default local client',
  scopes: ['admin'],
  accountCode: 'LOCAL',
});

/** Everything a scope string can be. `admin` implies all of them. */
export const KNOWN_SCOPES = [
  'admin',
  'accounting.read',
  'availability.read', 'availability.manage',
  'blocks.read', 'blocks.create', 'blocks.manage',
  'companies.read', 'companies.manage',
  'folios.read', 'folios.manage', 'folios.payments',
  'groups.read', 'groups.create', 'groups.manage',
  'invoices.read', 'invoices.manage',
  'maintenances.read', 'maintenances.manage',
  'nightaudit.manage',
  'offers.read',
  'operations.change-unit-condition',
  'operations.read',
  'payments.read', 'payments.create', 'payments.manage',
  'properties.read', 'properties.create', 'properties.manage',
  'rateplans.read', 'rateplans.create', 'rateplans.manage',
  'rates.read', 'rates.manage',
  'reports.read',
  'reservations.read', 'reservations.create', 'reservations.manage', 'reservations.import',
  'reservations.force-cancel', 'reservations.force-checkin',
  'routings.read', 'routings.manage',
  'services.read', 'services.manage',
  'setup.read', 'setup.manage',
  'unitattributes.read', 'unitattributes.manage',
] as const;

function tokenPayload(client: OAuthClient, scopes: string[]) {
  return {
    sub: client.clientId,
    client_id: client.clientId,
    account_code: client.accountCode,
    scope: scopes.join(' '),
    iss: 'apaleo-clone',
    aud: 'apaleo-clone-api',
  };
}

export function issueToken(client: OAuthClient, requested?: string[]): { access_token: string; expires_in: number; token_type: string; scope: string } {
  const granted = resolveScopes(client, requested);
  const access_token = jwt.sign(tokenPayload(client, granted), config.jwtSecret, {
    expiresIn: config.tokenTtlSeconds,
  });
  return {
    access_token,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    scope: granted.join(' '),
  };
}

function resolveScopes(client: OAuthClient, requested?: string[]): string[] {
  if (client.scopes.includes('admin')) {
    return requested?.length ? requested : ['admin'];
  }
  if (!requested?.length) return client.scopes;
  const granted = requested.filter((s) => client.scopes.includes(s));
  if (granted.length === 0) throw new Error('invalid_scope');
  return granted;
}

export function authenticateClient(clientId: string, clientSecret: string): OAuthClient | undefined {
  const c = clients.get(clientId);
  if (!c) return undefined;
  const a = Buffer.from(c.clientSecret);
  const b = Buffer.from(clientSecret ?? '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  return c;
}

const ANONYMOUS: Principal = {
  subject: 'anonymous',
  clientId: 'anonymous',
  accountCode: 'LOCAL',
  scopes: new Set(['admin']),
  properties: new Set(),
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

/** Populate `req.principal` from the bearer token, if any. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization');
  if (!header) {
    if (config.allowAnonymous) {
      req.principal = ANONYMOUS;
      return next();
    }
    return next(unauthorized('No authorization header was provided.'));
  }
  const [scheme, value] = header.split(' ');
  if (!/^bearer$/i.test(scheme ?? '') || !value) {
    return next(unauthorized('Expected an `Authorization: Bearer <token>` header.'));
  }
  try {
    const decoded = jwt.verify(value, config.jwtSecret) as Record<string, any>;
    req.principal = {
      subject: String(decoded.sub ?? 'unknown'),
      clientId: String(decoded.client_id ?? decoded.sub ?? 'unknown'),
      accountCode: String(decoded.account_code ?? 'LOCAL'),
      scopes: new Set(String(decoded.scope ?? '').split(' ').filter(Boolean)),
      properties: new Set(
        Array.isArray(decoded.properties) ? decoded.properties.map(String) : [],
      ),
    };
    return next();
  } catch (err) {
    const reason = err instanceof jwt.TokenExpiredError ? 'The access token has expired.' : 'The access token is invalid.';
    return next(unauthorized(reason));
  }
}

export function hasScope(principal: Principal | undefined, scopes: readonly string[]): boolean {
  if (!principal) return false;
  if (principal.scopes.has('admin')) return true;
  if (scopes.length === 0) return true;
  return scopes.some((s) => principal.scopes.has(s));
}

/**
 * Guard for a route. apaleo documents each operation as "you must have at
 * least one of these scopes", so this is an OR.
 */
export function requireScope(...scopes: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.principal) return next(unauthorized());
    if (hasScope(req.principal, scopes)) return next();
    next(forbidden(`Missing scope. One of the following is required: ${scopes.join(', ')}.`));
  };
}

/** Guard that only requires a valid token, with no particular scope. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.principal) return next(unauthorized());
  next();
}

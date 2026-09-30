import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { config } from './config';
import { requireScope, requireAuth } from './auth';
import { handler } from './http';
import { unprocessable } from './errors';
import { listOperations, validateDefinition, type OperationInfo } from './spec';

/**
 * Routes are declared by `operationId` rather than by verb and path.
 *
 * The path template, the HTTP method, the required scopes and the request body
 * schema all come from the downloaded apaleo spec, so a handler cannot drift
 * from the documentation: bind the wrong id and boot fails, and `coverage()`
 * reports any documented operation nobody implemented.
 */

export type OpHandler = (req: Request, res: Response) => unknown | Promise<unknown>;

const byId = new Map<string, OperationInfo>();
const implemented = new Set<string>();

function index(): Map<string, OperationInfo> {
  if (byId.size === 0) {
    for (const op of listOperations()) byId.set(op.operationId, op);
  }
  return byId;
}

/** `/inventory/v1/properties/{id}` -> `/inventory/v1/properties/:id` */
export function toExpressPath(swaggerPath: string): string {
  return swaggerPath.replace(/\{([^}]+)\}/g, (_m, name) => `:${name}`);
}

/**
 * apaleo uses OData-style `$count` and `$force` segments. Express 4's path
 * matcher does not escape `$`, so it ends up anchoring the regex and the
 * route silently never matches. For those paths we build the RegExp
 * ourselves and re-attach the named parameters.
 */
function needsRegexRoute(swaggerPath: string): boolean {
  return swaggerPath.includes('$');
}

export interface RegexRoute {
  pattern: RegExp;
  paramNames: string[];
}

export function toRegexRoute(swaggerPath: string): RegexRoute {
  const paramNames: string[] = [];
  const source = swaggerPath
    .split('/')
    .map((segment) => {
      const param = /^\{([^}]+)\}$/.exec(segment);
      if (param) {
        paramNames.push(param[1]!);
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), paramNames };
}

/** Copy positional regex captures onto `req.params` under their real names. */
function nameParams(paramNames: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    const params = req.params as unknown as Record<string, string>;
    paramNames.forEach((name, index) => {
      const value = params[String(index)];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    });
    next();
  };
}

/**
 * Specificity score used to order registrations. Express matches in insertion
 * order, so a literal segment like `/$bulk` has to be registered before the
 * `/{id}` template that would otherwise swallow it.
 */
function specificity(p: string): number {
  const segments = p.split('/').filter(Boolean);
  let score = segments.length * 100;
  for (const s of segments) score += s.startsWith('{') ? 0 : 10;
  return -score;
}

interface Registration {
  op: OperationInfo;
  handlers: RequestHandler[];
}

export class ApiBuilder {
  private readonly registrations: Registration[] = [];

  constructor(private readonly specKey: string) {}

  /**
   * Bind a handler to a documented operation.
   *
   * @param operationId  the `operationId` from the apaleo spec
   * @param fn           the handler
   * @param extra        middleware to run after auth but before the handler
   */
  op(operationId: string, fn: OpHandler, ...extra: RequestHandler[]): this {
    const op = index().get(operationId);
    if (!op) {
      throw new Error(
        `Unknown operationId '${operationId}'. It is not declared in any v1 apaleo spec.`,
      );
    }
    if (op.spec !== this.specKey) {
      throw new Error(
        `Operation '${operationId}' belongs to spec '${op.spec}', not '${this.specKey}'.`,
      );
    }
    if (implemented.has(operationId)) {
      throw new Error(`Operation '${operationId}' is already implemented.`);
    }
    implemented.add(operationId);

    const chain: RequestHandler[] = [requireAuth];
    if (op.scopes.length) chain.push(requireScope(...op.scopes));
    if (op.bodyDefinition) chain.push(this.bodyValidator(op));
    chain.push(...extra, handler(fn));

    this.registrations.push({ op, handlers: chain });
    return this;
  }

  private bodyValidator(op: OperationInfo): RequestHandler {
    const specKey = this.specKey;
    return (req, _res, next) => {
      if (!config.validateRequests) return next();
      const body = req.body;
      const missing = body === undefined || body === null
        || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
      if (missing) {
        if (op.bodyRequired) return next(unprocessable('A request body is required.'));
        return next();
      }
      const errors = validateDefinition(specKey, op.bodyDefinition!, body);
      if (errors.length) return next(unprocessable(errors));
      next();
    };
  }

  /** Build the express router, ordering routes so literals beat templates. */
  build(): Router {
    const router = Router({ mergeParams: true });
    const sorted = [...this.registrations].sort(
      (a, b) => specificity(a.op.path) - specificity(b.op.path),
    );
    for (const { op, handlers } of sorted) {
      const method = op.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
      // Bind so express keeps its `this`; the method is looked up dynamically.
      const register = (router[method] as (p: string | RegExp, ...h: RequestHandler[]) => void).bind(router);
      if (needsRegexRoute(op.path)) {
        const { pattern, paramNames } = toRegexRoute(op.path);
        register(pattern, nameParams(paramNames), ...handlers);
      } else {
        register(toExpressPath(op.path), ...handlers);
      }
    }
    return router;
  }
}

export interface Coverage {
  total: number;
  implemented: number;
  missing: OperationInfo[];
  bySpec: Record<string, { total: number; implemented: number }>;
}

/** Which documented v1 operations are wired up, and which are not. */
export function coverage(): Coverage {
  const all = listOperations();
  const bySpec: Coverage['bySpec'] = {};
  const missing: OperationInfo[] = [];
  for (const op of all) {
    bySpec[op.spec] ??= { total: 0, implemented: 0 };
    bySpec[op.spec]!.total += 1;
    if (implemented.has(op.operationId)) bySpec[op.spec]!.implemented += 1;
    else missing.push(op);
  }
  return { total: all.length, implemented: implemented.size, missing, bySpec };
}

/** Test helper: forget registrations so routers can be rebuilt. */
export function resetRegistry(): void {
  implemented.clear();
}

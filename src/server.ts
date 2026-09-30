import express, { type Express } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './core/config';
import { authenticate } from './core/auth';
import { errorMiddleware, notFoundMiddleware } from './core/http';
import { identityRouter } from './core/identity';
import { coverage } from './core/router';
import { getSpec, loadSpecs, specKeys } from './core/spec';
import { getDb } from './core/db';

import { inventoryRouter } from './api/inventory';
import { ratePlanRouter } from './api/rateplan';
import { settingsRouter } from './api/settings';
import { bookingRouter } from './api/booking';
import { availabilityRouter } from './api/availability';
import { operationsRouter } from './api/operations';
import { logsRouter } from './api/logs';
import { accountRouter } from './api/account';
import { reportsRouter } from './api/reports';
import { financeRouter } from './api/finance';
import { chatRouter } from './chat/router';

/**
 * Assembles the clone: the fake identity server, the ten v1 API surfaces, the
 * spec documents and a Swagger UI pointed at them.
 */
export function createServer(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(cors({ exposedHeaders: ['Location'] }));
  app.use(express.json({ limit: '5mb' }));

  // Open endpoints: health, docs, specs, token.
  app.get('/health', (_req, res) => {
    const c = coverage();
    res.json({
      status: 'ok',
      service: 'apaleo-clone',
      time: new Date().toISOString(),
      operations: { implemented: c.implemented, documented: c.total },
    });
  });

  app.get('/coverage', (_req, res) => {
    const c = coverage();
    res.json({
      total: c.total,
      implemented: c.implemented,
      bySpec: c.bySpec,
      missing: c.missing.map((o) => `${o.method} ${o.path} (${o.operationId})`),
    });
  });

  app.use(identityRouter());
  app.use('/swagger', specRouter());
  mountWeb(app);

  // Everything below needs a principal.
  app.use(authenticate);

  app.use(inventoryRouter);
  app.use(ratePlanRouter);
  app.use(settingsRouter);
  app.use(bookingRouter);
  app.use(availabilityRouter);
  app.use(operationsRouter);
  app.use(logsRouter);
  app.use(accountRouter);
  app.use(reportsRouter);
  app.use(financeRouter);

  // The console's own chat, not part of the apaleo surface. It sits behind the
  // same principal check because it can cancel reservations and run an audit.
  app.use(chatRouter());

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}

/** Serves the downloaded OpenAPI documents, rewritten to point at this host. */
function specRouter(): express.Router {
  const router = express.Router();

  router.get('/index.json', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      urls: specKeys().map((key) => ({
        name: getSpec(key)?.title ?? key,
        url: `${base}/swagger/${key}/swagger.json`,
      })),
    });
  });

  router.get('/:key/swagger.json', (req, res) => {
    const doc = getSpec(req.params.key!);
    if (!doc) {
      res.status(404).json({ messages: [`No spec named '${req.params.key}'.`] });
      return;
    }
    const host = req.get('host') ?? `localhost:${config.port}`;
    // Swagger 2.0 locates the server with host/basePath/schemes.
    const { key, title, version, ...rest } = doc;
    res.json({
      ...rest,
      host,
      basePath: '/',
      schemes: [req.protocol],
      securityDefinitions: {
        oauth2: {
          type: 'oauth2',
          flow: 'application',
          tokenUrl: `${req.protocol}://${host}/connect/token`,
          scopes: { admin: 'Full access' },
        },
      },
    });
  });

  return router;
}

/**
 * Two front ends share the server: the PMS application at `/app` and the API
 * explorer at `/docs`. Both are plain static files.
 */
function mountWeb(app: Express): void {
  for (const name of ['app', 'docs']) {
    const dir = path.join(config.webDir, name);
    if (fs.existsSync(dir)) app.use(`/${name}`, express.static(dir));
  }
  app.get('/', (_req, res) => res.redirect('/app/'));
}

export function start(): void {
  getDb();
  const app = createServer();
  const c = coverage();
  app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `apaleo-clone listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`
      + `  app       /app/\n`
      + `  docs      /docs/\n`
      + `  token     POST /connect/token (client_credentials)\n`
      + `  coverage  ${c.implemented}/${c.total} documented v1 operations`,
    );
  });
}

export { loadSpecs };

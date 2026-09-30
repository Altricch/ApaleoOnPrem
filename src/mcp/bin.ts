#!/usr/bin/env node
/**
 * Entry point for the apaleo MCP servers.
 *
 *   apaleo-mcp                       every domain, over stdio
 *   apaleo-mcp --domain booking      one domain, over stdio
 *   apaleo-mcp --domain booking,finance
 *   apaleo-mcp --http --port 8090    streamable HTTP, one endpoint per domain
 *   apaleo-mcp --list                what is available
 *
 * stdio is the default because that is how desktop clients launch a server.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { buildServer, DOMAINS, DOMAIN_NAMES, type DomainName } from './server';
import { getDb } from '../core/db';

interface Options {
  domains: DomainName[];
  http: boolean;
  port: number;
  list: boolean;
}

function parse(argv: string[]): Options {
  const options: Options = { domains: [], http: false, port: 8090, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') options.list = true;
    else if (a === '--http') options.http = true;
    else if (a === '--port') options.port = Number(argv[++i]);
    else if (a === '--domain' || a === '--domains') {
      const value = argv[++i] ?? '';
      for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (raw === 'all') {
          options.domains.push(...DOMAIN_NAMES);
        } else if ((DOMAIN_NAMES as string[]).includes(raw)) {
          options.domains.push(raw as DomainName);
        } else {
          fail(`Unknown domain '${raw}'. Available: ${DOMAIN_NAMES.join(', ')}, all.`);
        }
      }
    } else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`Unknown argument '${a}'. Try --help.`);
    }
  }
  options.domains = [...new Set(options.domains)];
  return options;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(): void {
  process.stderr.write(
    [
      'apaleo MCP server',
      '',
      'Usage: apaleo-mcp [--domain <name[,name]>] [--http [--port N]]',
      '',
      'Domains:',
      ...DOMAIN_NAMES.map((n) => `  ${n.padEnd(11)} ${DOMAINS[n].blurb.split('. ')[0]}.`),
      '  all         every domain on one server',
      '',
      'Transports:',
      '  (default)   stdio - how desktop clients launch a server',
      '  --http      streamable HTTP; each domain is served at /mcp/<domain>',
      '',
      'Environment:',
      '  APALEO_DB               SQLite file (default data/apaleo.db)',
      '  APALEO_TOKEN            bearer token, when the API requires auth',
      '  APALEO_MCP_CACHE_TTL    config cache lifetime in ms (default 30000)',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));

  if (options.list) {
    for (const name of DOMAIN_NAMES) {
      const server = buildServer({ domains: [name] });
      // Reach into the registry only to count what was registered.
      const tools = Object.keys((server as unknown as { _registeredTools: object })._registeredTools ?? {});
      process.stdout.write(
        `${name.padEnd(11)} ${String(tools.length).padStart(2)} tools  ${DOMAINS[name].blurb}\n`
        + `${' '.repeat(12)}${tools.join(', ')}\n\n`,
      );
    }
    return;
  }

  // Open the database up front so a misconfiguration fails at start, not on
  // the first tool call.
  getDb();

  if (options.http) {
    await serveHttp(options);
    return;
  }

  const server = buildServer({ domains: options.domains });
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol; anything human goes to stderr.
  process.stderr.write(
    `apaleo MCP ready over stdio (${(options.domains.length ? options.domains : DOMAIN_NAMES).join(', ')}).\n`,
  );
}

/**
 * HTTP mode mounts one endpoint per domain plus a combined one, so a single
 * process can serve several clients that each want a different slice.
 *
 * Each request gets its own transport and server instance: the Streamable
 * HTTP transport is per-session, and sharing one across concurrent stateless
 * requests cross-wires their responses.
 */
async function serveHttp(options: Options): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const mounted: [string, DomainName[]][] = [
    ['all', [...DOMAIN_NAMES]],
    ...DOMAIN_NAMES.map((n) => [n, [n]] as [string, DomainName[]]),
  ];

  for (const [route, domains] of mounted) {
    app.post(`/mcp/${route}`, async (req, res) => {
      const server = buildServer({ domains });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
            id: null,
          });
        }
      }
    });

    // Stateless mode: there is no stream to resume and no session to delete.
    for (const method of ['get', 'delete'] as const) {
      app[method](`/mcp/${route}`, (_req, res) => {
        res.status(405).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'This endpoint is stateless; use POST.' },
          id: null,
        });
      });
    }
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'streamable-http', endpoints: mounted.map(([r]) => `/mcp/${r}`) });
  });

  const server = app.listen(options.port, () => {
    process.stderr.write(
      `apaleo MCP over HTTP on :${options.port}\n`
      + mounted.map(([route, domains]) =>
        `  POST /mcp/${route.padEnd(11)} ${domains.length === 1 ? DOMAINS[domains[0]!].title : 'every domain'}\n`).join(''),
    );
  });

  // Without this, a port clash exits on an unhandled 'error' event and prints a
  // stack trace at someone who only needs to be told to pick another port.
  server.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      err.code === 'EADDRINUSE'
        ? `Port ${options.port} is already in use. Start with --port <other>.\n`
        : `apaleo MCP HTTP server failed: ${err.message}\n`,
    );
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`apaleo MCP failed to start: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

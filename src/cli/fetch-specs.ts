/**
 * Re-download the apaleo OpenAPI documents this clone is built against.
 *
 * The spec list lives inside apaleo's Swagger UI page rather than in a
 * machine-readable index, so we scrape the `urls` array out of it and then
 * pull each document. Run with `npm run specs:refresh`.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../core/config';

const INDEX_URL = 'https://api.apaleo.com/swagger/index.html';
const ORIGIN = 'https://api.apaleo.com';

interface SpecRef {
  name: string;
  url: string;
}

async function discover(): Promise<SpecRef[]> {
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`Could not load ${INDEX_URL}: ${res.status}`);
  const html = await res.text();

  const refs: SpecRef[] = [];
  const pattern = /"url"\s*:\s*"([^"]*\/swagger\/[^"]+\/swagger\.json)"\s*,\s*"name"\s*:\s*"([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    refs.push({ url: match[1]!, name: match[2]! });
  }
  if (!refs.length) {
    throw new Error('No spec URLs found in the Swagger UI page; its markup may have changed.');
  }
  return refs;
}

async function main(): Promise<void> {
  fs.mkdirSync(config.specDir, { recursive: true });
  const refs = await discover();
  // eslint-disable-next-line no-console
  console.log(`Found ${refs.length} specs.`);

  for (const ref of refs) {
    const url = ref.url.startsWith('http') ? ref.url : `${ORIGIN}${ref.url}`;
    const key = /\/swagger\/([^/]+)\/swagger\.json$/.exec(ref.url)?.[1];
    if (!key) continue;
    const res = await fetch(url);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`  ${key}: ${res.status}, skipped`);
      continue;
    }
    const body = await res.text();
    const file = path.join(config.specDir, `${key}.json`);
    fs.writeFileSync(file, `${JSON.stringify(JSON.parse(body), null, 1)}\n`);
    // eslint-disable-next-line no-console
    console.log(`  ${key.padEnd(24)} ${(body.length / 1024).toFixed(0)} KiB  ${ref.name}`);
  }

  writeOperationIndex();
}

/** A flat operation list, handy for diffing the surface between refreshes. */
function writeOperationIndex(): void {
  const v1 = fs.readdirSync(config.specDir)
    .filter((f) => f.endsWith('-v1.json'))
    .sort();
  const ops: Record<string, unknown>[] = [];
  for (const file of v1) {
    const spec = JSON.parse(fs.readFileSync(path.join(config.specDir, file), 'utf8'));
    for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
        ops.push({
          spec: file.replace('.json', ''),
          method: method.toUpperCase(),
          path: p,
          operationId: op.operationId,
          tag: (op.tags ?? [])[0],
          summary: op.summary,
        });
      }
    }
  }
  fs.writeFileSync(
    path.join(config.specDir, '_operations-v1.json'),
    `${JSON.stringify(ops, null, 1)}\n`,
  );
  // eslint-disable-next-line no-console
  console.log(`\nWrote _operations-v1.json with ${ops.length} v1 operations.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

/**
 * Copy the docs UI into the build output so `dist` is self-contained.
 * Run as part of `npm run build`.
 */
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'src', 'web');
const to = path.join(__dirname, '..', 'dist', 'web');

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`copied ${path.relative(process.cwd(), from)} -> ${path.relative(process.cwd(), to)}`);

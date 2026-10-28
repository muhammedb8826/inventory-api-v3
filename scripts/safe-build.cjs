'use strict';

/**
 * Build into .dist-staging, then swap over dist/.
 * A failed compile leaves the previous dist/ intact (avoids cPanel 503).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const staging = path.join(root, '.dist-staging');
const backup = path.join(root, '.dist-backup');
const nestCli = path.join(root, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

if (!fs.existsSync(nestCli)) {
  console.error(
    'Missing @nestjs/cli. Run npm install — build tools ship in dependencies for server deploys.',
  );
  process.exit(1);
}

rm(staging);

const result = spawnSync(
  process.execPath,
  [nestCli, 'build', '-p', 'tsconfig.build.staging.json'],
  { cwd: root, stdio: 'inherit', env: process.env },
);

if ((result.status ?? 1) !== 0) {
  rm(staging);
  console.error(
    'Build failed; existing dist/ was left unchanged.',
  );
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(staging, 'main.js'))) {
  rm(staging);
  console.error('Build finished without .dist-staging/main.js; dist/ unchanged.');
  process.exit(1);
}

rm(backup);
if (fs.existsSync(dist)) {
  fs.renameSync(dist, backup);
}
try {
  fs.renameSync(staging, dist);
} catch (err) {
  if (fs.existsSync(backup)) {
    fs.renameSync(backup, dist);
  }
  rm(staging);
  console.error('Failed to swap dist/; previous build restored if possible.');
  throw err;
}
rm(backup);
console.log('Build complete: dist/ updated.');

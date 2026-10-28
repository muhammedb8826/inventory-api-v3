'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainJs = path.join(root, 'dist', 'main.js');
const buildTsconfig = path.join(root, 'tsconfig.build.json');

if (!fs.existsSync(buildTsconfig)) {
  console.error(
    'Missing tsconfig.build.json next to package.json — upload it before building.',
  );
  process.exit(1);
}

if (!fs.existsSync(mainJs)) {
  console.error(
    'BUILD INCOMPLETE: dist/main.js is missing. Passenger will return 503.',
  );
  console.error(
    'Remove dist/ and rebuild:  rm -rf dist && npm run build && ls -la dist/main.js',
  );
  process.exit(1);
}

console.log('dist/main.js OK');

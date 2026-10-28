'use strict';

/** Writes tsconfig.build.json when FTP/sync omitted it (Nest needs this file). */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'tsconfig.build.json');
if (fs.existsSync(target)) process.exit(0);

const contents = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "incremental": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "test", "dist", "scripts", "**/*spec.ts"]
}
`;

fs.writeFileSync(target, contents);
console.log('Wrote missing tsconfig.build.json');

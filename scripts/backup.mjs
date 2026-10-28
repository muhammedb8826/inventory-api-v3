import 'dotenv/config';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const directory = resolve(process.env.BACKUP_DIR ?? 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
function run(command, args, env = process.env) { return new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
}); }
const dump = join(directory, 'database.dump');
await run(process.env.PG_DUMP ?? 'pg_dump', ['--format=custom', '--no-owner', '--file', dump,
  '--host', process.env.DB_HOST ?? 'localhost', '--port', process.env.DB_PORT ?? '5432',
  '--username', process.env.DB_USERNAME ?? 'postgres', process.env.DB_DATABASE],
  { ...process.env, PGPASSWORD: process.env.DB_PASSWORD ?? '' });
await chmod(dump, 0o600);
await run('tar', ['-czf', join(directory, 'uploads.tar.gz'), '-C', resolve('uploads'), '.']);
const files = {};
for (const name of ['database.dump', 'uploads.tar.gz']) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  files[name] = hash.digest('hex');
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2), { mode: 0o600 });
console.log(`Backup complete: ${directory}`);

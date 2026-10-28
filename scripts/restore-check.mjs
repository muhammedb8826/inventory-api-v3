import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
const backup = resolve(process.env.BACKUP_PATH ?? '');
const database = process.env.RESTORE_DB_NAME;
if (!database || !/^inventory_restore_[a-z0-9_]+$/.test(database) || database === process.env.DB_DATABASE) throw new Error('RESTORE_DB_NAME must be a new inventory_restore_* database');
const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
for (const name of ['database.dump', 'uploads.tar.gz']) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(join(backup,name))) hash.update(chunk);
  if (hash.digest('hex') !== manifest.files[name]) throw new Error(`Checksum mismatch: ${name}`);
}
const client = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD ?? '', database: 'postgres' });
await client.connect();
try { await client.query(`CREATE DATABASE "${database}"`); } finally { await client.end(); }
const started = Date.now();
await new Promise((resolve, reject) => {
  const child = spawn(process.env.PG_RESTORE ?? 'pg_restore', ['--exit-on-error','--no-owner','--host',process.env.DB_HOST ?? 'localhost', '--port',process.env.DB_PORT ?? '5432','--username',process.env.DB_USERNAME ?? 'postgres','--dbname',database,join(backup,'database.dump')], { env:{ ...process.env, PGPASSWORD:process.env.DB_PASSWORD ?? '' }, stdio:'inherit', windowsHide:true });
  child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new Error(`Restore failed: ${code}`)));
});
console.log(`Verified backup restored to ${database} in ${((Date.now()-started)/1000).toFixed(1)}s. Original backup and live database were preserved.`);
console.log('Run reconciliation and application smoke checks against the restored database before declaring the drill successful.');

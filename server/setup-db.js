import pg from 'pg';
import { PgStore } from './store.js';

if (!process.env.DATABASE_URL) {
  console.error('Copy .env.example to .env and configure DATABASE_URL first.');
  process.exitCode = 1;
} else {
  let admin;
  const store = new PgStore(process.env.DATABASE_URL);
  try {
    const target = new URL(process.env.DATABASE_URL);
    const database = decodeURIComponent(target.pathname.slice(1));
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database)) throw new Error('Choose a simple database name such as evoworld.');
    const adminUrl = new URL(target); adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
    if (!existing.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
    await store.ready();
    console.log('EvoWorld database and experiment table are ready. Run npm start.');
  } catch (error) {
    console.error(`Database setup failed (${error.code || 'configuration'}). Check PostgreSQL, DATABASE_URL, and database-creation permissions. No credentials are printed.`);
    process.exitCode = 1;
  } finally { await admin?.end(); await store.close(); }
}


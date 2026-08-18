import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { limits } from './contracts.js';
import { closeServer, createHttpServer, listen } from './http.js';
import { initializeDatabase, NearbyRepository } from './repository.js';
import { NearbyService } from './service.js';

const { Pool } = pg;

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function serve(environment = process.env) {
  const pool = new Pool({
    connectionString: required(environment, 'DATABASE_URL'),
    application_name: 'nearby-presence-api',
    max: 24,
    statement_timeout: 5_000,
    query_timeout: 8_000,
  });
  await initializeDatabase(pool);
  const repository = new NearbyRepository(pool, {
    sessionTtlMs: limits.sessionTtlMs,
    eventRetention: limits.eventRetention,
    fanoutLimit: limits.fanoutSessions,
    outboxLeaseMs: limits.outboxLeaseMs,
  });
  const service = new NearbyService(repository, {
    cursorSecret: required(environment, 'CURSOR_SECRET'),
    wakeChannelSecret: required(environment, 'WAKE_CHANNEL_SECRET'),
  });
  const server = createHttpServer({
    service,
    authSecret: required(environment, 'AUTH_FINGERPRINT_SECRET'),
    crashAfterLocationCommit: environment.CRASH_AFTER_LOCATION_COMMIT === '1',
  });
  const address = await listen(server, {
    host: environment.HOST ?? '127.0.0.1',
    port: environment.PORT ? Number.parseInt(environment.PORT, 10) : 3000,
  });
  process.stdout.write(`${JSON.stringify({
    operation: 'server_ready', status: 200, port: address.port,
  })}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await closeServer(server);
    await pool.end();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { pool, server, address, shutdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'serve') throw new Error('usage: node src/main.js serve');
  serve().catch(() => {
    process.stderr.write('{"operation":"server_fatal","status":500}\n');
    process.exitCode = 1;
  });
}

import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { limits } from './contracts.js';
import { initializeDatabase, NearbyRepository } from './repository.js';
import { WakeWorker } from './wake-worker.js';

const { Pool } = pg;

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeLog(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export async function createWorkerRuntime(environment = process.env) {
  const pool = new Pool({
    connectionString: required(environment, 'DATABASE_URL'),
    application_name: 'nearby-presence-wake-worker',
    max: 8,
    statement_timeout: 5_000,
    query_timeout: 8_000,
  });
  await initializeDatabase(pool);
  const repository = new NearbyRepository(pool, {
    eventRetention: limits.eventRetention,
    fanoutLimit: limits.fanoutSessions,
    outboxLeaseMs: environment.OUTBOX_LEASE_MS
      ? Number.parseInt(environment.OUTBOX_LEASE_MS, 10)
      : limits.outboxLeaseMs,
  });
  const redis = createClient({ url: required(environment, 'REDIS_URL') });
  redis.on('error', () => safeLog({
    operation: 'redis_connection', status: 503, evidence: 'dependency_error',
  }));
  await redis.connect();
  const worker = new WakeWorker({
    repository,
    redis,
    logger: (line) => process.stdout.write(`${line}\n`),
    afterPublish: environment.CRASH_AFTER_WAKE_PUBLISH === '1'
      ? async ({ sequence, subscriberCount }) => {
        safeLog({
          operation: 'publish_wake',
          status: 200,
          evidence: 'redis_publish_returned',
          sequence,
          subscriberCount,
        });
        process.kill(process.pid, 'SIGKILL');
      }
      : async () => {},
  });
  const close = async () => {
    if (redis.isOpen) await redis.quit();
    await pool.end();
  };
  return { pool, redis, repository, worker, close };
}

export async function runOnce(environment = process.env) {
  const runtime = await createWorkerRuntime(environment);
  try {
    const result = await runtime.worker.runOne();
    safeLog({ operation: 'worker_once', status: 200, kind: result.kind });
    return result;
  } finally {
    await runtime.close();
  }
}

export async function serveWorker(environment = process.env) {
  const runtime = await createWorkerRuntime(environment);
  let closing = false;
  const shutdown = () => { closing = true; };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  safeLog({ operation: 'worker_ready', status: 200 });
  try {
    while (!closing) {
      const batch = await runtime.worker.runBatch();
      if (!batch.length) await delay(50);
    }
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const action = command === 'once' ? runOnce : command === 'serve' ? serveWorker : null;
  if (!action) throw new Error('usage: node src/worker-main.js <once|serve>');
  action().catch(() => {
    process.stderr.write('{"operation":"worker_fatal","status":500}\n');
    process.exitCode = 1;
  });
}

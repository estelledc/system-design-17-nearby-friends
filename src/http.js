import { createServer } from 'node:http';
import { limits } from './contracts.js';
import { ownerFingerprint } from './crypto.js';
import { AppError, asAppError, invalid, unauthorized } from './errors.js';

function bearerToken(header) {
  if (typeof header !== 'string') throw unauthorized();
  const match = /^Bearer ([\x21-\x7e]{8,256})$/.exec(header);
  if (!match) throw unauthorized();
  return match[1];
}

async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string'
    || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw invalid('Content-Type must be application/json');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limits.bodyBytes) {
    throw invalid('request body is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limits.bodyBytes) throw invalid('request body is too large');
    chunks.push(chunk);
  }
  if (!size) throw invalid('request body must contain JSON');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalid('request body must contain valid JSON');
  }
}

function assertNoQuery(url) {
  if ([...url.searchParams].length) throw invalid('query parameters are not accepted on this route');
}

function cursorParameter(url) {
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0][0] !== 'cursor' || !entries[0][1]) {
    throw invalid('exactly one cursor query parameter is required');
  }
  if (entries[0][1].length > limits.cursorChars) throw invalid('cursor is invalid');
  return entries[0][1];
}

function sendJson(response, status, body, headers, onWritten) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(bytes, onWritten);
}

function safeLog(logger, entry) {
  logger(JSON.stringify(entry));
}

function publicError(error) {
  const details = error.details && typeof error.details === 'object'
    ? Object.fromEntries(Object.entries(error.details).filter(([key]) => key !== 'etag'))
    : undefined;
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  };
}

export function createHttpServer({
  service,
  authSecret,
  logger = (line) => process.stdout.write(`${line}\n`),
  crashAfterLocationCommit = false,
  killProcess = () => process.kill(process.pid, 'SIGKILL'),
}) {
  if (typeof authSecret !== 'string' || Buffer.byteLength(authSecret) < 32) {
    throw new Error('authSecret must contain at least 32 bytes');
  }

  const server = createServer(async (request, response) => {
    const started = performance.now();
    let operation = 'unknown_route';
    try {
      const url = new URL(request.url, 'http://service.invalid');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        operation = 'health';
        assertNoQuery(url);
        sendJson(response, 200, { status: 'ok' }, {}, () => safeLog(logger, {
          operation,
          status: 200,
          evidence: 'server_bytes_written',
          elapsedMs: Math.round(performance.now() - started),
        }));
        return;
      }

      const owner = ownerFingerprint(bearerToken(request.headers.authorization), authSecret);
      const relationshipMatch = /^\/v1\/relationships\/([0-9a-f-]{36})$/.exec(url.pathname);
      const eventsMatch = /^\/v1\/nearby-sessions\/([0-9a-f-]{36})\/events$/.exec(url.pathname);
      let result;
      let status;
      let headers = {};

      if (request.method === 'POST' && url.pathname === '/v1/accounts') {
        operation = 'create_account';
        assertNoQuery(url);
        result = await service.createAccount({
          owner,
          requestKey: request.headers['idempotency-key'],
          body: await readJson(request),
        });
        status = result.created ? 201 : 200;
        headers = { ETag: result.etag };
      } else if (request.method === 'PUT' && relationshipMatch) {
        operation = 'set_relationship';
        assertNoQuery(url);
        result = await service.setRelationship({
          owner,
          requestKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          otherAccountId: relationshipMatch[1],
          body: await readJson(request),
        });
        status = 200;
        headers = { ETag: result.etag };
      } else if (request.method === 'PUT' && url.pathname === '/v1/sharing-policy') {
        operation = 'set_sharing_policy';
        assertNoQuery(url);
        result = await service.setSharingPolicy({
          owner,
          requestKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          body: await readJson(request),
        });
        status = 200;
        headers = { ETag: result.etag };
      } else if (request.method === 'POST' && url.pathname === '/v1/device-generations') {
        operation = 'rotate_device_generation';
        assertNoQuery(url);
        result = await service.rotateDeviceGeneration({
          owner,
          requestKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          body: await readJson(request),
        });
        status = 200;
        headers = { ETag: result.etag };
      } else if (request.method === 'PUT' && url.pathname === '/v1/location') {
        operation = 'update_location';
        assertNoQuery(url);
        result = await service.updateLocation({
          owner,
          requestKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          body: await readJson(request),
        });
        status = 200;
        headers = { ETag: result.etag };
        if (crashAfterLocationCommit && !result.body.replayed) {
          safeLog(logger, {
            operation,
            status,
            evidence: 'location_update_accepted',
            elapsedMs: Math.round(performance.now() - started),
          });
          killProcess();
          return;
        }
      } else if (request.method === 'POST' && url.pathname === '/v1/nearby-sessions') {
        operation = 'create_nearby_session';
        assertNoQuery(url);
        result = await service.createNearbySession({
          owner,
          requestKey: request.headers['idempotency-key'],
          body: await readJson(request),
        });
        status = result.created ? 201 : 200;
      } else if (request.method === 'GET' && eventsMatch) {
        operation = 'drain_nearby_session';
        result = await service.drainNearbySession({
          owner,
          sessionId: eventsMatch[1],
          cursor: cursorParameter(url),
        });
        status = 200;
      } else {
        throw new AppError('not_found', 404, 'resource not found');
      }

      sendJson(response, status, result.body, headers, () => safeLog(logger, {
        operation,
        status,
        evidence: 'server_bytes_written',
        ...(Array.isArray(result.body.items) ? { resultCount: result.body.items.length } : {}),
        elapsedMs: Math.round(performance.now() - started),
      }));
    } catch (error) {
      const safe = asAppError(error);
      const headers = safe.details?.etag ? { ETag: safe.details.etag } : {};
      sendJson(response, safe.status, publicError(safe), headers, () => safeLog(logger, {
        operation,
        status: safe.status,
        evidence: safe.code === 'precondition_failed' ? 'precondition_failed' : 'request_rejected',
        elapsedMs: Math.round(performance.now() - started),
      }));
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 11_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return { host, port: address.port, origin: `http://${host}:${address.port}` };
}

export async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { invalid } from './errors.js';
import { parseUuid } from './contracts.js';

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function intentDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function ownerFingerprint(authToken, secret) {
  return createHmac('sha256', secret).update(authToken).digest('hex');
}

export function wakeChannel(sessionId, secret) {
  parseUuid(sessionId, 'session ID');
  return `nearby:wake:${createHmac('sha256', secret).update(sessionId).digest('base64url')}`;
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

export function encodeCursor({ owner, session, after }, secret) {
  const payload = Buffer.from(stableJson({ after, owner, session, v: 1 })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

export function decodeCursor(token, expectedOwner, secret) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 1_024) throw invalid('cursor is invalid');
  const parts = token.split('.');
  if (parts.length !== 2) throw invalid('cursor is invalid');
  const [payload, encodedSignature] = parts;
  let supplied;
  let parsed;
  let text;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
    text = Buffer.from(payload, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== payload) throw new Error('non-canonical base64url');
    parsed = JSON.parse(text);
  } catch {
    throw invalid('cursor is invalid');
  }
  const expected = sign(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid('cursor is invalid');
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || text !== stableJson(parsed)
    || Object.keys(parsed).sort().join(',') !== 'after,owner,session,v'
    || parsed.v !== 1
    || parsed.owner !== expectedOwner
    || typeof parsed.owner !== 'string'
    || !/^[0-9a-f]{64}$/.test(parsed.owner)
    || !Number.isSafeInteger(parsed.after)
    || parsed.after < 0
  ) {
    throw invalid('cursor is invalid');
  }
  parseUuid(parsed.session, 'cursor session');
  return { session: parsed.session, after: parsed.after };
}

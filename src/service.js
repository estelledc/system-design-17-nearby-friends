import { randomUUID } from 'node:crypto';
import {
  formatEtag,
  parseEmptyBody,
  parseIfMatch,
  parseLocation,
  parseNearbySession,
  parsePolicy,
  parseRelationship,
  parseRequestKey,
  parseUuid,
} from './contracts.js';
import {
  decodeCursor,
  encodeCursor,
  intentDigest,
  wakeChannel,
} from './crypto.js';
import { AppError, invalid } from './errors.js';

function secret(value, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32) {
    throw new Error(`${label} must contain at least 32 bytes`);
  }
  return value;
}

function itemBody(item) {
  return {
    accountId: item.accountId,
    locationEpoch: item.locationEpoch,
    latitude: item.latitude,
    longitude: item.longitude,
    distanceMillimeters: item.distanceMillimeters,
    acceptedAt: item.acceptedAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
  };
}

function receiptFailure(receipt) {
  if (receipt.outcome === 'applied') return;
  const { code = 'precondition_failed', message = 'mutation precondition failed', ...details } = receipt.result;
  let etag;
  if (typeof details.currentVersionId === 'string') {
    const prefix = receipt.operation === 'relationship_set' ? 're' : 'sp';
    etag = formatEtag(prefix, details.currentVersionId);
  } else if (typeof details.currentGenerationId === 'string') {
    etag = formatEtag('dg', details.currentGenerationId);
  }
  throw new AppError(code, receipt.status, message, { ...details, ...(etag ? { etag } : {}) });
}

function replayedResult(receipt) {
  return { ...receipt.result, replayed: receipt.replayed };
}

export class NearbyService {
  constructor(repository, {
    cursorSecret,
    wakeChannelSecret,
    uuid = randomUUID,
  }) {
    this.repository = repository;
    this.cursorSecret = secret(cursorSecret, 'cursorSecret');
    this.wakeChannelSecret = secret(wakeChannelSecret, 'wakeChannelSecret');
    this.uuid = uuid;
  }

  async createAccount({ owner, requestKey, body }) {
    parseEmptyBody(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'account_create', owner });
    const receipt = await this.repository.createAccount({ owner, requestKey: key, digest });
    receiptFailure(receipt);
    const result = replayedResult(receipt);
    return {
      created: !receipt.replayed,
      etag: formatEtag('ac', result.accountVersionId),
      body: {
        accountId: result.accountId,
        accountVersionId: result.accountVersionId,
        policy: {
          enabled: result.policyEnabled,
          versionId: result.policyVersionId,
          versionNumber: result.policyVersionNumber,
          etag: formatEtag('sp', result.policyVersionId),
        },
        committedRevision: result.committedRevision,
        replayed: result.replayed,
      },
    };
  }

  async setRelationship({ owner, requestKey, ifMatch, otherAccountId, body }) {
    const other = parseUuid(otherAccountId, 'other account ID');
    const baseVersion = parseIfMatch(ifMatch, 're', { allowStar: true });
    const input = parseRelationship(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({
      operation: 'relationship_set', owner, otherAccountId: other, baseVersion, input,
    });
    const receipt = await this.repository.setRelationship({
      owner,
      requestKey: key,
      digest,
      otherAccountId: other,
      baseVersion,
      state: input.state,
    });
    receiptFailure(receipt);
    const result = replayedResult(receipt);
    return {
      etag: formatEtag('re', result.versionId),
      body: result,
    };
  }

  async setSharingPolicy({ owner, requestKey, ifMatch, body }) {
    const baseVersionId = parseIfMatch(ifMatch, 'sp');
    const input = parsePolicy(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'policy_set', owner, baseVersionId, input });
    const receipt = await this.repository.setSharingPolicy({
      owner, requestKey: key, digest, baseVersionId, enabled: input.enabled,
    });
    receiptFailure(receipt);
    const result = replayedResult(receipt);
    return { etag: formatEtag('sp', result.versionId), body: result };
  }

  async rotateDeviceGeneration({ owner, requestKey, ifMatch, body }) {
    parseEmptyBody(body);
    const baseGeneration = parseIfMatch(ifMatch, 'dg', { allowStar: true });
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'device_rotate', owner, baseGeneration });
    const receipt = await this.repository.rotateDeviceGeneration({
      owner, requestKey: key, digest, baseGeneration,
    });
    receiptFailure(receipt);
    const result = replayedResult(receipt);
    return { etag: formatEtag('dg', result.generationId), body: result };
  }

  async updateLocation({ owner, requestKey, ifMatch, body }) {
    const generationId = parseIfMatch(ifMatch, 'dg');
    const input = parseLocation(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'location_update', owner, generationId, input });
    const receipt = await this.repository.updateLocation({
      owner, requestKey: key, digest, generationId, input,
    });
    receiptFailure(receipt);
    return {
      etag: formatEtag('dg', generationId),
      body: replayedResult(receipt),
    };
  }

  async createNearbySession({ owner, requestKey, body }) {
    const query = parseNearbySession(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'nearby_session_create', owner, query });
    const sessionId = this.uuid();
    parseUuid(sessionId, 'generated session ID');
    const result = await this.repository.createNearbySession({
      owner,
      requestKey: key,
      digest,
      query,
      sessionId,
      channel: wakeChannel(sessionId, this.wakeChannelSecret),
    });
    return {
      created: !result.session.replayed,
      body: {
        sessionId: result.session.sessionId,
        initialRevision: result.session.initialRevision,
        viewRevision: result.viewRevision,
        radiusMeters: result.session.radiusMeters,
        maxResults: result.session.maxResults,
        expiresAt: result.session.expiresAt.toISOString(),
        eventCursor: encodeCursor({
          owner,
          session: result.session.sessionId,
          after: result.session.lastEventSequence,
        }, this.cursorSecret),
        items: result.items.map(itemBody),
        replayed: result.session.replayed,
      },
    };
  }

  async drainNearbySession({ owner, sessionId, cursor }) {
    const id = parseUuid(sessionId, 'session ID');
    const continuation = decodeCursor(cursor, owner, this.cursorSecret);
    if (continuation.session !== id) throw invalid('cursor does not belong to this nearby session');
    const result = await this.repository.drainNearbySession({
      owner, sessionId: id, after: continuation.after,
    });
    return {
      body: {
        sessionId: id,
        viewRevision: result.viewRevision,
        replaceWholeView: true,
        events: result.events.map((event) => ({
          sequence: event.sequence,
          committedRevision: event.committedRevision,
          type: event.type,
          createdAt: event.createdAt.toISOString(),
        })),
        items: result.items.map(itemBody),
        refreshBy: result.refreshBy.toISOString(),
        eventCursor: encodeCursor({
          owner, session: id, after: result.cursorSequence,
        }, this.cursorSecret),
      },
    };
  }
}

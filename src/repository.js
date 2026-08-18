import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  conflict,
  densityLimit,
  fanoutLimit,
  gone,
  invalid,
  notFound,
  resyncRequired,
} from './errors.js';

const schemaUrl = new URL('../sql/schema.sql', import.meta.url);

const integer = (value) => Number.parseInt(value, 10);

async function rollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

function receiptFromRow(row, replayed) {
  return {
    operation: row.operation,
    outcome: row.outcome,
    status: row.http_status,
    revision: row.result_revision === null ? null : integer(row.result_revision),
    result: row.result_json,
    replayed,
  };
}

function sessionFromRow(row, replayed) {
  return {
    sessionId: row.session_id,
    viewerAccountId: row.viewer_account_id,
    initialRevision: integer(row.initial_revision),
    lastEventSequence: integer(row.last_event_sequence),
    retainedFromSequence: integer(row.retained_from_sequence),
    radiusMeters: row.radius_meters,
    maxResults: row.max_results,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    replayed,
  };
}

function resultItem(row) {
  return {
    accountId: row.account_id,
    locationEpoch: row.location_epoch,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    distanceMillimeters: integer(row.distance_mm),
    acceptedAt: new Date(row.accepted_at),
    expiresAt: new Date(row.expires_at),
  };
}

export async function initializeDatabase(pool) {
  await pool.query(await readFile(fileURLToPath(schemaUrl), 'utf8'));
}

export async function resetDatabase(pool, confirmation) {
  if (confirmation !== 'nearby-presence-lab-reset') {
    throw new Error('refusing to reset without the explicit lab confirmation');
  }
  await pool.query(`
    TRUNCATE wake_outbox, nearby_session_events,
      nearby_sessions, mutation_requests, presences, device_generations,
      relationship_edges, sharing_policies, accounts CASCADE;
    UPDATE system_state SET committed_revision = 0 WHERE singleton = true;
  `);
}

export class NearbyRepository {
  constructor(pool, {
    sessionTtlMs = 30 * 60 * 1_000,
    eventRetention = 32,
    fanoutLimit: maximumFanout = 1_000,
    outboxLeaseMs = 5_000,
  } = {}) {
    this.pool = pool;
    this.sessionTtlMs = sessionTtlMs;
    this.eventRetention = eventRetention;
    this.maximumFanout = maximumFanout;
    this.outboxLeaseMs = outboxLeaseMs;
  }

  async #databaseNow(client) {
    const result = await client.query(`SELECT clock_timestamp() AS now`);
    return new Date(result.rows[0].now);
  }

  async #lockSystem(client) {
    const result = await client.query(
      `SELECT committed_revision FROM system_state WHERE singleton = true FOR UPDATE`,
    );
    return integer(result.rows[0].committed_revision);
  }

  async #nextRevision(client) {
    const result = await client.query(`
      UPDATE system_state
      SET committed_revision = committed_revision + 1
      WHERE singleton = true
      RETURNING committed_revision
    `);
    return integer(result.rows[0].committed_revision);
  }

  async #existingReceipt(client, owner, requestKey, digest) {
    const found = await client.query(
      `SELECT * FROM mutation_requests WHERE owner_fingerprint = $1 AND request_key = $2`,
      [owner, requestKey],
    );
    if (!found.rowCount) return null;
    if (found.rows[0].intent_digest !== digest) {
      throw conflict('this idempotency key is already bound to a different mutation intent');
    }
    return receiptFromRow(found.rows[0], true);
  }

  async #recordReceipt(client, {
    owner, requestKey, digest, operation, outcome = 'applied', status = 200,
    revision = null, result, now,
  }) {
    await client.query(`
      INSERT INTO mutation_requests (
        owner_fingerprint, request_key, intent_digest, operation, outcome,
        http_status, result_revision, result_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
    `, [owner, requestKey, digest, operation, outcome, status, revision, JSON.stringify(result), now]);
    return { operation, outcome, status, revision, result, replayed: false };
  }

  async #accountByOwner(client, owner, { lock = false } = {}) {
    const found = await client.query(
      `SELECT * FROM accounts WHERE owner_fingerprint = $1${lock ? ' FOR UPDATE' : ''}`,
      [owner],
    );
    if (!found.rowCount) throw notFound();
    return found.rows[0];
  }

  async #activeSessionsForViewers(client, viewerAccountIds, now) {
    if (!viewerAccountIds.length) return [];
    const found = await client.query(`
      SELECT session_id
      FROM nearby_sessions
      WHERE viewer_account_id = ANY($1::uuid[]) AND expires_at > $2
      ORDER BY session_id
      LIMIT $3
    `, [viewerAccountIds, now, this.maximumFanout + 1]);
    if (found.rowCount > this.maximumFanout) throw fanoutLimit();
    return found.rows.map((row) => row.session_id);
  }

  async #mutualFriendSessions(client, sharerAccountId, now, { requireEnabled = true } = {}) {
    const found = await client.query(`
      SELECT s.session_id
      FROM nearby_sessions AS s
      JOIN relationship_edges AS viewer_edge
        ON viewer_edge.owner_account_id = s.viewer_account_id
       AND viewer_edge.other_account_id = $1
       AND viewer_edge.state = 'accepted'
      JOIN relationship_edges AS sharer_edge
        ON sharer_edge.owner_account_id = $1
       AND sharer_edge.other_account_id = s.viewer_account_id
       AND sharer_edge.state = 'accepted'
      JOIN sharing_policies AS policy ON policy.account_id = $1
      WHERE s.expires_at > $2 AND ($3::boolean = false OR policy.enabled = true)
      ORDER BY s.session_id
      LIMIT $4
    `, [sharerAccountId, now, requireEnabled, this.maximumFanout + 1]);
    if (found.rowCount > this.maximumFanout) throw fanoutLimit();
    return found.rows.map((row) => row.session_id);
  }

  async #appendRefreshEvents(client, sessionIds, revision, now) {
    const uniqueIds = [...new Set(sessionIds)].sort();
    if (uniqueIds.length > this.maximumFanout) throw fanoutLimit();
    if (!uniqueIds.length) return 0;
    const locked = await client.query(`
      SELECT session_id, last_event_sequence, event_retention
      FROM nearby_sessions
      WHERE session_id = ANY($1::uuid[]) AND expires_at > $2
      ORDER BY session_id
      FOR UPDATE
    `, [uniqueIds, now]);
    if (locked.rowCount > this.maximumFanout) throw fanoutLimit();
    if (!locked.rowCount) return 0;

    const sessionValues = [];
    const sequenceValues = [];
    const retainedValues = [];
    const outboxValues = [];
    for (const row of locked.rows) {
      const sequence = integer(row.last_event_sequence) + 1;
      sessionValues.push(row.session_id);
      sequenceValues.push(sequence);
      retainedValues.push(Math.max(1, sequence - row.event_retention + 1));
      outboxValues.push(randomUUID());
    }
    await client.query(`
      UPDATE nearby_sessions AS session SET
        last_event_sequence = value.sequence,
        retained_from_sequence = value.retained
      FROM unnest($1::uuid[], $2::bigint[], $3::bigint[])
        AS value(session_id, sequence, retained)
      WHERE session.session_id = value.session_id
    `, [sessionValues, sequenceValues, retainedValues]);
    await client.query(`
      INSERT INTO nearby_session_events (
        session_id, sequence, committed_revision, event_type, created_at
      )
      SELECT session_id, sequence, $3, 'refresh_required', $4
      FROM unnest($1::uuid[], $2::bigint[]) AS value(session_id, sequence)
    `, [sessionValues, sequenceValues, revision, now]);
    await client.query(`
      INSERT INTO wake_outbox (
        outbox_id, session_id, sequence, state, created_at
      )
      SELECT outbox_id, session_id, sequence, 'pending', $4
      FROM unnest($1::uuid[], $2::uuid[], $3::bigint[])
        AS value(outbox_id, session_id, sequence)
    `, [outboxValues, sessionValues, sequenceValues, now]);
    await client.query(`
      DELETE FROM nearby_session_events AS event
      USING nearby_sessions AS session
      WHERE event.session_id = session.session_id
        AND event.session_id = ANY($1::uuid[])
        AND event.sequence < session.retained_from_sequence
    `, [sessionValues]);
    await client.query(`
      DELETE FROM wake_outbox AS outbox
      USING nearby_sessions AS session
      WHERE outbox.session_id = session.session_id
        AND outbox.session_id = ANY($1::uuid[])
        AND outbox.sequence < session.retained_from_sequence
        AND outbox.state <> 'claimed'
    `, [sessionValues]);
    return locked.rowCount;
  }

  async createAccount({ owner, requestKey, digest }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockSystem(client);
      existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const prior = await client.query(`SELECT account_id FROM accounts WHERE owner_fingerprint = $1`, [owner]);
      if (prior.rowCount) throw conflict('this authenticated owner already has an account');
      const now = await this.#databaseNow(client);
      const accountId = randomUUID();
      const accountVersionId = randomUUID();
      const policyVersionId = randomUUID();
      const revision = await this.#nextRevision(client);
      await client.query(`
        INSERT INTO accounts (
          account_id, owner_fingerprint, version_id, committed_revision, created_at
        ) VALUES ($1, $2, $3, $4, $5)
      `, [accountId, owner, accountVersionId, revision, now]);
      await client.query(`
        INSERT INTO sharing_policies (
          account_id, enabled, version_id, version_number, committed_revision, updated_at
        ) VALUES ($1, false, $2, 1, $3, $4)
      `, [accountId, policyVersionId, revision, now]);
      const receipt = await this.#recordReceipt(client, {
        owner, requestKey, digest, operation: 'account_create', status: 201, revision, now,
        result: {
          accountId, accountVersionId, policyVersionId, policyVersionNumber: 1,
          policyEnabled: false, committedRevision: revision,
        },
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async setRelationship({ owner, requestKey, digest, otherAccountId, baseVersion, state }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockSystem(client);
      existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const account = await this.#accountByOwner(client, owner, { lock: true });
      if (account.account_id === otherAccountId) throw invalid('an account cannot relate to itself');
      const other = await client.query(`SELECT account_id FROM accounts WHERE account_id = $1`, [otherAccountId]);
      if (!other.rowCount) throw notFound();
      const currentResult = await client.query(`
        SELECT * FROM relationship_edges
        WHERE owner_account_id = $1 AND other_account_id = $2
        FOR UPDATE
      `, [account.account_id, otherAccountId]);
      const current = currentResult.rows[0] ?? null;
      const now = await this.#databaseNow(client);
      const preconditionFailed = (!current && baseVersion !== '*')
        || (current && (baseVersion === '*' || baseVersion !== current.version_id));
      if (preconditionFailed) {
        const receipt = await this.#recordReceipt(client, {
          owner, requestKey, digest, operation: 'relationship_set',
          outcome: 'precondition_failed', status: 412, now,
          result: {
            code: 'precondition_failed',
            message: 'the supplied relationship version is stale',
            ...(current ? { currentVersionId: current.version_id } : { currentVersionMissing: true }),
          },
        });
        await client.query('COMMIT');
        return receipt;
      }
      const targetSessions = await this.#activeSessionsForViewers(
        client,
        [account.account_id, otherAccountId],
        now,
      );
      const versionId = randomUUID();
      const versionNumber = current ? current.version_number + 1 : 1;
      const revision = await this.#nextRevision(client);
      await client.query(`
        INSERT INTO relationship_edges (
          owner_account_id, other_account_id, state, version_id,
          version_number, committed_revision, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (owner_account_id, other_account_id) DO UPDATE SET
          state = EXCLUDED.state,
          version_id = EXCLUDED.version_id,
          version_number = EXCLUDED.version_number,
          committed_revision = EXCLUDED.committed_revision,
          updated_at = EXCLUDED.updated_at
      `, [account.account_id, otherAccountId, state, versionId, versionNumber, revision, now]);
      const eventCount = await this.#appendRefreshEvents(client, targetSessions, revision, now);
      const receipt = await this.#recordReceipt(client, {
        owner, requestKey, digest, operation: 'relationship_set', revision, now,
        result: {
          otherAccountId, state, versionId, versionNumber,
          committedRevision: revision, sessionEventsCommitted: eventCount,
        },
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async setSharingPolicy({ owner, requestKey, digest, baseVersionId, enabled }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockSystem(client);
      existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const account = await this.#accountByOwner(client, owner, { lock: true });
      const policyResult = await client.query(
        `SELECT * FROM sharing_policies WHERE account_id = $1 FOR UPDATE`,
        [account.account_id],
      );
      const policy = policyResult.rows[0];
      const now = await this.#databaseNow(client);
      if (policy.version_id !== baseVersionId) {
        const receipt = await this.#recordReceipt(client, {
          owner, requestKey, digest, operation: 'policy_set',
          outcome: 'precondition_failed', status: 412, now,
          result: {
            code: 'precondition_failed',
            message: 'the supplied sharing-policy version is stale',
            currentVersionId: policy.version_id,
          },
        });
        await client.query('COMMIT');
        return receipt;
      }
      const targetSessions = await this.#mutualFriendSessions(
        client,
        account.account_id,
        now,
        { requireEnabled: false },
      );
      const versionId = randomUUID();
      const versionNumber = policy.version_number + 1;
      const revision = await this.#nextRevision(client);
      await client.query(`
        UPDATE sharing_policies SET
          enabled = $2, version_id = $3, version_number = $4,
          committed_revision = $5, updated_at = $6
        WHERE account_id = $1
      `, [account.account_id, enabled, versionId, versionNumber, revision, now]);
      if (!enabled) await client.query(`DELETE FROM presences WHERE account_id = $1`, [account.account_id]);
      const eventCount = await this.#appendRefreshEvents(client, targetSessions, revision, now);
      const receipt = await this.#recordReceipt(client, {
        owner, requestKey, digest, operation: 'policy_set', revision, now,
        result: {
          enabled, versionId, versionNumber,
          committedRevision: revision, sessionEventsCommitted: eventCount,
        },
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateDeviceGeneration({ owner, requestKey, digest, baseGeneration }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockSystem(client);
      existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const account = await this.#accountByOwner(client, owner, { lock: true });
      const currentResult = await client.query(
        `SELECT * FROM device_generations WHERE account_id = $1 FOR UPDATE`,
        [account.account_id],
      );
      const current = currentResult.rows[0] ?? null;
      const now = await this.#databaseNow(client);
      const stale = (!current && baseGeneration !== '*')
        || (current && (baseGeneration === '*' || baseGeneration !== current.generation_id));
      if (stale) {
        const receipt = await this.#recordReceipt(client, {
          owner, requestKey, digest, operation: 'device_rotate',
          outcome: 'precondition_failed', status: 412, now,
          result: {
            code: 'precondition_failed',
            message: 'the supplied device generation is stale',
            ...(current ? { currentGenerationId: current.generation_id } : { currentGenerationMissing: true }),
          },
        });
        await client.query('COMMIT');
        return receipt;
      }
      const targetSessions = await this.#mutualFriendSessions(client, account.account_id, now);
      const generationId = randomUUID();
      const generationNumber = current ? current.generation_number + 1 : 1;
      const revision = await this.#nextRevision(client);
      await client.query(`DELETE FROM presences WHERE account_id = $1`, [account.account_id]);
      await client.query(`
        INSERT INTO device_generations (
          account_id, generation_id, generation_number, last_sequence,
          committed_revision, updated_at
        ) VALUES ($1, $2, $3, 0, $4, $5)
        ON CONFLICT (account_id) DO UPDATE SET
          generation_id = EXCLUDED.generation_id,
          generation_number = EXCLUDED.generation_number,
          last_sequence = 0,
          committed_revision = EXCLUDED.committed_revision,
          updated_at = EXCLUDED.updated_at
      `, [account.account_id, generationId, generationNumber, revision, now]);
      const eventCount = await this.#appendRefreshEvents(client, targetSessions, revision, now);
      const receipt = await this.#recordReceipt(client, {
        owner, requestKey, digest, operation: 'device_rotate', revision, now,
        result: {
          generationId, generationNumber, nextSequence: 1,
          committedRevision: revision, sessionEventsCommitted: eventCount,
        },
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateLocation({ owner, requestKey, digest, generationId, input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockSystem(client);
      existing = await this.#existingReceipt(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const account = await this.#accountByOwner(client, owner, { lock: true });
      const generationResult = await client.query(
        `SELECT * FROM device_generations WHERE account_id = $1 FOR UPDATE`,
        [account.account_id],
      );
      const generation = generationResult.rows[0] ?? null;
      const policyResult = await client.query(
        `SELECT * FROM sharing_policies WHERE account_id = $1 FOR UPDATE`,
        [account.account_id],
      );
      const policy = policyResult.rows[0];
      const now = await this.#databaseNow(client);
      let rejection = null;
      if (!generation || generation.generation_id !== generationId) {
        rejection = {
          code: 'stale_device_generation',
          message: 'the supplied device generation is not current',
          ...(generation ? { currentGenerationId: generation.generation_id } : { currentGenerationMissing: true }),
        };
      } else if (!policy.enabled) {
        rejection = {
          code: 'sharing_disabled',
          message: 'location updates require an enabled sharing policy',
          currentPolicyVersionId: policy.version_id,
        };
      } else if (input.sequence !== integer(generation.last_sequence) + 1) {
        rejection = {
          code: 'sequence_conflict',
          message: 'location sequence must be exactly the next device sequence',
          expectedSequence: integer(generation.last_sequence) + 1,
        };
      }
      if (rejection) {
        const receipt = await this.#recordReceipt(client, {
          owner, requestKey, digest, operation: 'location_update',
          outcome: 'precondition_failed', status: 409, now, result: rejection,
        });
        await client.query('COMMIT');
        return receipt;
      }

      const targetSessions = await this.#mutualFriendSessions(client, account.account_id, now);
      const revision = await this.#nextRevision(client);
      const locationEpoch = randomUUID();
      const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
      await client.query(`
        UPDATE device_generations SET
          last_sequence = $2, committed_revision = $3, updated_at = $4
        WHERE account_id = $1
      `, [account.account_id, input.sequence, revision, now]);
      await client.query(`
        INSERT INTO presences (
          account_id, generation_id, sequence, location_epoch,
          latitude, longitude, location, accepted_at, expires_at, committed_revision
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          ST_SetSRID(ST_Point($6, $5), 4326)::geography,
          $7, $8, $9
        )
        ON CONFLICT (account_id) DO UPDATE SET
          generation_id = EXCLUDED.generation_id,
          sequence = EXCLUDED.sequence,
          location_epoch = EXCLUDED.location_epoch,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          location = EXCLUDED.location,
          accepted_at = EXCLUDED.accepted_at,
          expires_at = EXCLUDED.expires_at,
          committed_revision = EXCLUDED.committed_revision
      `, [
        account.account_id, generationId, input.sequence, locationEpoch,
        input.latitude, input.longitude, now, expiresAt, revision,
      ]);
      const eventCount = await this.#appendRefreshEvents(client, targetSessions, revision, now);
      const receipt = await this.#recordReceipt(client, {
        owner, requestKey, digest, operation: 'location_update', revision, now,
        result: {
          generationId, sequence: input.sequence, locationEpoch,
          acceptedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
          committedRevision: revision, sessionEventsCommitted: eventCount,
        },
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #queryAuthorizedView(client, session, now) {
    const found = await client.query(`
      WITH query_center AS (
        SELECT ST_SetSRID(ST_Point($2, $1), 4326)::geography AS location
      )
      SELECT
        presence.account_id,
        presence.location_epoch,
        presence.latitude,
        presence.longitude,
        presence.accepted_at,
        presence.expires_at,
        round(ST_Distance(presence.location, center.location, true) * 1000)::bigint AS distance_mm
      FROM relationship_edges AS viewer_edge
      JOIN relationship_edges AS friend_edge
        ON friend_edge.owner_account_id = viewer_edge.other_account_id
       AND friend_edge.other_account_id = viewer_edge.owner_account_id
       AND friend_edge.state = 'accepted'
      JOIN sharing_policies AS policy
        ON policy.account_id = viewer_edge.other_account_id
       AND policy.enabled = true
      JOIN device_generations AS generation
        ON generation.account_id = viewer_edge.other_account_id
      JOIN presences AS presence
        ON presence.account_id = viewer_edge.other_account_id
       AND presence.generation_id = generation.generation_id
      CROSS JOIN query_center AS center
      WHERE viewer_edge.owner_account_id = $3
        AND viewer_edge.state = 'accepted'
        AND presence.expires_at > $4
        AND ST_DWithin(presence.location, center.location, $5, true)
      ORDER BY distance_mm ASC, presence.account_id ASC
      LIMIT $6
    `, [
      Number(session.latitude),
      Number(session.longitude),
      session.viewer_account_id,
      now,
      session.radius_meters,
      session.max_results + 1,
    ]);
    if (found.rowCount > session.max_results) throw densityLimit();
    return found.rows.map(resultItem);
  }

  async createNearbySession({ owner, requestKey, digest, query, sessionId, channel }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockSystem(client);
      const account = await this.#accountByOwner(client, owner, { lock: true });
      const existingResult = await client.query(`
        SELECT * FROM nearby_sessions
        WHERE viewer_account_id = $1 AND request_key = $2
        FOR UPDATE
      `, [account.account_id, requestKey]);
      if (existingResult.rowCount) {
        const existing = existingResult.rows[0];
        if (existing.intent_digest !== digest) {
          throw conflict('this idempotency key is already bound to a different nearby-session intent');
        }
        const now = await this.#databaseNow(client);
        if (new Date(existing.expires_at) <= now) throw gone('nearby session has expired');
        const items = await this.#queryAuthorizedView(client, existing, now);
        const revisionResult = await client.query(
          `SELECT committed_revision FROM system_state WHERE singleton = true`,
        );
        await client.query('COMMIT');
        return {
          session: sessionFromRow(existing, true),
          viewRevision: integer(revisionResult.rows[0].committed_revision),
          items,
        };
      }
      const now = await this.#databaseNow(client);
      const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
      const revisionResult = await client.query(
        `SELECT committed_revision FROM system_state WHERE singleton = true`,
      );
      const session = {
        session_id: sessionId,
        viewer_account_id: account.account_id,
        latitude: query.latitude,
        longitude: query.longitude,
        radius_meters: query.radiusMeters,
        max_results: query.maxResults,
      };
      const items = await this.#queryAuthorizedView(client, session, now);
      const initialRevision = integer(revisionResult.rows[0].committed_revision);
      await client.query(`
        INSERT INTO nearby_sessions (
          session_id, viewer_account_id, owner_fingerprint, request_key, intent_digest,
          latitude, longitude, center, radius_meters, max_results, initial_revision,
          event_retention, wake_channel, created_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          ST_SetSRID(ST_Point($7, $6), 4326)::geography,
          $8, $9, $10, $11, $12, $13, $14
        )
      `, [
        sessionId, account.account_id, owner, requestKey, digest,
        query.latitude, query.longitude, query.radiusMeters, query.maxResults,
        initialRevision, this.eventRetention, channel, now, expiresAt,
      ]);
      await client.query('COMMIT');
      return {
        session: {
          sessionId,
          viewerAccountId: account.account_id,
          initialRevision,
          lastEventSequence: 0,
          retainedFromSequence: 1,
          radiusMeters: query.radiusMeters,
          maxResults: query.maxResults,
          createdAt: now,
          expiresAt,
          replayed: false,
        },
        viewRevision: initialRevision,
        items,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async drainNearbySession({ owner, sessionId, after }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const account = await this.#accountByOwner(client, owner);
      const found = await client.query(`
        SELECT * FROM nearby_sessions
        WHERE session_id = $1 AND viewer_account_id = $2 AND owner_fingerprint = $3
      `, [sessionId, account.account_id, owner]);
      if (!found.rowCount) throw notFound();
      const row = found.rows[0];
      const now = await this.#databaseNow(client);
      if (new Date(row.expires_at) <= now) throw gone('nearby session has expired');
      const last = integer(row.last_event_sequence);
      const retainedFrom = integer(row.retained_from_sequence);
      if (after < retainedFrom - 1) throw resyncRequired();
      if (after > last) throw invalid('cursor is ahead of the durable session sequence');
      const eventsResult = await client.query(`
        SELECT sequence, committed_revision, event_type, created_at
        FROM nearby_session_events
        WHERE session_id = $1 AND sequence > $2
        ORDER BY sequence
      `, [sessionId, after]);
      const items = await this.#queryAuthorizedView(client, row, now);
      const revisionResult = await client.query(
        `SELECT committed_revision FROM system_state WHERE singleton = true`,
      );
      await client.query('COMMIT');
      return {
        session: sessionFromRow(row, false),
        cursorSequence: last,
        viewRevision: integer(revisionResult.rows[0].committed_revision),
        events: eventsResult.rows.map((event) => ({
          sequence: integer(event.sequence),
          committedRevision: integer(event.committed_revision),
          type: event.event_type,
          createdAt: new Date(event.created_at),
        })),
        items,
        refreshBy: items.length
          ? new Date(Math.min(...items.map((item) => item.expiresAt.getTime())))
          : new Date(row.expires_at),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimWake() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = await this.#databaseNow(client);
      const found = await client.query(`
        SELECT outbox.outbox_id, outbox.session_id, outbox.sequence, session.wake_channel
        FROM wake_outbox AS outbox
        JOIN nearby_sessions AS session USING (session_id)
        WHERE (
          outbox.state = 'pending'
          OR (outbox.state = 'claimed' AND outbox.lease_until <= $1)
        )
          AND session.expires_at > $1
          AND outbox.sequence >= session.retained_from_sequence
        ORDER BY outbox.created_at, outbox.outbox_id
        LIMIT 1
        FOR UPDATE OF outbox SKIP LOCKED
      `, [now]);
      if (!found.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const row = found.rows[0];
      const claimToken = randomUUID();
      const leaseUntil = new Date(now.getTime() + this.outboxLeaseMs);
      await client.query(`
        UPDATE wake_outbox SET
          state = 'claimed', claim_token = $2, lease_until = $3,
          publish_attempts = publish_attempts + 1
        WHERE outbox_id = $1
      `, [row.outbox_id, claimToken, leaseUntil]);
      await client.query('COMMIT');
      return {
        outboxId: row.outbox_id,
        sessionId: row.session_id,
        sequence: integer(row.sequence),
        channel: row.wake_channel,
        claimToken,
        leaseUntil,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markWakeSent({ outboxId, claimToken }) {
    const result = await this.pool.query(`
      UPDATE wake_outbox SET
        state = 'sent', claim_token = NULL, lease_until = NULL,
        sent_at = clock_timestamp()
      WHERE outbox_id = $1 AND state = 'claimed' AND claim_token = $2
      RETURNING publish_attempts
    `, [outboxId, claimToken]);
    if (!result.rowCount) throw conflict('wake claim is stale or already completed');
    return { publishAttempts: result.rows[0].publish_attempts };
  }

  async releaseWake({ outboxId, claimToken }) {
    await this.pool.query(`
      UPDATE wake_outbox SET state = 'pending', claim_token = NULL, lease_until = NULL
      WHERE outbox_id = $1 AND state = 'claimed' AND claim_token = $2
    `, [outboxId, claimToken]);
  }

  async outboxStats() {
    const result = await this.pool.query(`
      SELECT state, count(*)::int AS count, coalesce(max(publish_attempts), 0)::int AS max_attempts
      FROM wake_outbox
      GROUP BY state
      ORDER BY state
    `);
    return result.rows;
  }
}

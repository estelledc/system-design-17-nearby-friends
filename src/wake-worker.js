import { limits } from './contracts.js';

export class WakeWorker {
  constructor({
    repository,
    redis,
    logger = () => {},
    afterPublish = async () => {},
  }) {
    this.repository = repository;
    this.redis = redis;
    this.logger = logger;
    this.afterPublish = afterPublish;
  }

  async runOne() {
    const claim = await this.repository.claimWake();
    if (!claim) return { kind: 'idle' };
    try {
      const payload = JSON.stringify({ version: 1, upperSequence: claim.sequence });
      const subscriberCount = await this.redis.publish(claim.channel, payload);
      await this.afterPublish({
        sequence: claim.sequence,
        subscriberCount,
      });
      const marked = await this.repository.markWakeSent(claim);
      const result = {
        kind: 'published',
        sequence: claim.sequence,
        subscriberCount,
        publishAttempts: marked.publishAttempts,
      };
      this.logger(JSON.stringify({
        operation: 'publish_wake',
        status: 200,
        evidence: 'redis_wake_published',
        sequence: claim.sequence,
        subscriberCount,
        publishAttempts: marked.publishAttempts,
      }));
      return result;
    } catch (error) {
      await this.repository.releaseWake(claim);
      throw error;
    }
  }

  async runBatch(limit = limits.workerBatch) {
    const results = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.runOne();
      if (result.kind === 'idle') break;
      results.push(result);
    }
    return results;
  }
}

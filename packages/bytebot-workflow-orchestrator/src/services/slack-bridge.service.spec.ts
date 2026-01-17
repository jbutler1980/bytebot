import { SlackBridgeService } from './slack-bridge.service';
import { createHmac } from 'crypto';

describe('SlackBridgeService', () => {
  function makeService(options: {
    signingSecret: string;
    botToken?: string;
    enabled?: string;
  }): SlackBridgeService {
    const configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'SLACK_SIGNING_SECRET':
            return options.signingSecret;
          case 'SLACK_BOT_TOKEN':
            return options.botToken || '';
          case 'SLACK_REPLY_IN_SLACK_ENABLED':
            return options.enabled ?? 'true';
          default:
            return '';
        }
      }),
    } as any;

    const userPromptResolutionService = {
      resolvePrompt: jest.fn(),
    } as any;

    return new SlackBridgeService(configService, userPromptResolutionService);
  }

  it('verifies Slack signatures for valid requests', () => {
    const signingSecret = 'test_signing_secret';
    const service = makeService({ signingSecret });

    const rawBody = 'payload=%7B%22hello%22%3A%22world%22%7D';
    const timestamp = '1700000000';
    const base = `v0:${timestamp}:${rawBody}`;
    const digest = createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
    const signature = `v0=${digest}`;

    expect(
      service.verifySlackRequest({
        rawBody,
        signature,
        timestamp,
        nowMs: parseInt(timestamp, 10) * 1000,
      }),
    ).toBe(true);
  });

  it('rejects stale Slack timestamps (replay protection)', () => {
    const signingSecret = 'test_signing_secret';
    const service = makeService({ signingSecret });

    const rawBody = 'payload=test';
    const timestamp = '1700000000';
    const base = `v0:${timestamp}:${rawBody}`;
    const digest = createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
    const signature = `v0=${digest}`;

    expect(
      service.verifySlackRequest({
        rawBody,
        signature,
        timestamp,
        nowMs: (parseInt(timestamp, 10) + 60 * 10) * 1000,
      }),
    ).toBe(false);
  });
});


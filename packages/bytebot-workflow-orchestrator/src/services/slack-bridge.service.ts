import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { UserPromptResolutionService } from './user-prompt-resolution.service';
import { ActorType } from '@prisma/client';

type SlackInteractivePayload =
  | {
      type: 'block_actions';
      user?: { id?: string; username?: string };
      team?: { id?: string; domain?: string };
      trigger_id?: string;
      actions?: Array<{ action_id?: string; value?: string }>;
    }
  | {
      type: 'view_submission';
      user?: { id?: string; username?: string };
      team?: { id?: string; domain?: string };
      view?: {
        id?: string;
        private_metadata?: string;
        state?: {
          values?: Record<string, Record<string, { type?: string; value?: string }>>;
        };
      };
    }
  | { type: string; [key: string]: any };

type SlackPromptMetadata = {
  promptId: string;
  tenantId: string;
  kind?: string;
  goalRunId?: string;
};

@Injectable()
export class SlackBridgeService {
  private readonly logger = new Logger(SlackBridgeService.name);
  private readonly signingSecret: string;
  private readonly botToken: string;
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly userPromptResolutionService: UserPromptResolutionService,
  ) {
    this.signingSecret = (this.configService.get<string>('SLACK_SIGNING_SECRET') || '').trim();
    this.botToken = (this.configService.get<string>('SLACK_BOT_TOKEN') || '').trim();
    this.enabled =
      (this.configService.get<string>('SLACK_REPLY_IN_SLACK_ENABLED') || '').trim().toLowerCase() ===
      'true';
  }

  isEnabled(): boolean {
    return this.enabled && this.signingSecret.length > 0;
  }

  verifySlackRequest(args: {
    rawBody: Buffer | string | undefined;
    signature: string | undefined;
    timestamp: string | undefined;
    nowMs?: number;
  }): boolean {
    if (!this.signingSecret) return false;
    if (!args.rawBody) return false;
    if (!args.signature) return false;
    if (!args.timestamp) return false;

    const timestamp = parseInt(args.timestamp, 10);
    if (!Number.isFinite(timestamp)) return false;

    const nowMs = args.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const ageSec = Math.abs(nowSec - timestamp);
    if (ageSec > 60 * 5) {
      // Replay protection (Slack recommends 5 minutes).
      return false;
    }

    const bodyString = Buffer.isBuffer(args.rawBody) ? args.rawBody.toString('utf8') : String(args.rawBody);
    const base = `v0:${timestamp}:${bodyString}`;
    const digest = createHmac('sha256', this.signingSecret).update(base, 'utf8').digest('hex');
    const expected = `v0=${digest}`;

    const sigBuf = Buffer.from(args.signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  async handleInteractivity(payload: SlackInteractivePayload, headers?: Record<string, any>): Promise<any> {
    if (!this.isEnabled()) {
      return {
        text: 'Reply-in-Slack is not enabled. Use the "Open Prompt" button instead.',
        response_type: 'ephemeral',
        replace_original: false,
      };
    }

    if (payload?.type === 'block_actions') {
      return await this.handleBlockActions(
        payload as Extract<SlackInteractivePayload, { type: 'block_actions' }>,
      );
    }

    if (payload?.type === 'view_submission') {
      return await this.handleViewSubmission(
        payload as Extract<SlackInteractivePayload, { type: 'view_submission' }>,
        headers,
      );
    }

    return { text: 'Unsupported Slack payload type', response_type: 'ephemeral', replace_original: false };
  }

  private async handleBlockActions(payload: Extract<SlackInteractivePayload, { type: 'block_actions' }>): Promise<any> {
    const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
    const actionId = typeof action?.action_id === 'string' ? action.action_id : '';
    const value = typeof action?.value === 'string' ? action.value : '';

    if (actionId !== 'bytebot_user_prompt_reply') {
      return { text: 'Unsupported action', response_type: 'ephemeral', replace_original: false };
    }

    const triggerId = typeof payload.trigger_id === 'string' ? payload.trigger_id : '';
    const metadata = this.parseMetadata(value);

    if (!triggerId || !metadata) {
      return {
        text: 'Missing prompt metadata. Use the "Open Prompt" button instead.',
        response_type: 'ephemeral',
        replace_original: false,
      };
    }

    if (!this.botToken) {
      return {
        text: 'Slack bot token is not configured. Use the "Open Prompt" button instead.',
        response_type: 'ephemeral',
        replace_original: false,
      };
    }

    await this.openResolveModal(triggerId, metadata);
    return '';
  }

  private async handleViewSubmission(
    payload: Extract<SlackInteractivePayload, { type: 'view_submission' }>,
    headers?: Record<string, any>,
  ): Promise<any> {
    const metaRaw = typeof payload.view?.private_metadata === 'string' ? payload.view.private_metadata : '';
    const metadata = this.parseMetadata(metaRaw);
    if (!metadata) {
      return { response_action: 'errors', errors: { answer: 'Missing prompt metadata.' } };
    }

    const answer = this.extractAnswer(payload.view?.state?.values);
    if (!answer) {
      return { response_action: 'errors', errors: { answer: 'Answer is required.' } };
    }

    const slackUserId = typeof payload.user?.id === 'string' ? payload.user.id : undefined;
    const slackTeamId = typeof payload.team?.id === 'string' ? payload.team.id : undefined;

    const viewId = typeof payload.view?.id === 'string' ? payload.view.id : 'unknown';
    const idempotencyKey = `slack:view_submission:${viewId}`;

    await this.userPromptResolutionService.resolvePrompt({
      promptId: metadata.promptId,
      tenantId: metadata.tenantId,
      actor: {
        type: ActorType.HUMAN,
        id: slackUserId,
        authContext: {
          source: 'slack',
          slackTeamId,
        },
      },
      answers: { text: answer },
      idempotencyKey,
      requestId: typeof headers?.['x-request-id'] === 'string' ? headers['x-request-id'] : undefined,
      clientRequestId: undefined,
      ipAddress: undefined,
      userAgent: undefined,
    });

    return { response_action: 'clear' };
  }

  private parseMetadata(value: string): SlackPromptMetadata | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return null;

      const promptId = typeof (parsed as any).promptId === 'string' ? (parsed as any).promptId : '';
      const tenantId = typeof (parsed as any).tenantId === 'string' ? (parsed as any).tenantId : '';
      if (!promptId || !tenantId) return null;

      return {
        promptId,
        tenantId,
        kind: typeof (parsed as any).kind === 'string' ? (parsed as any).kind : undefined,
        goalRunId: typeof (parsed as any).goalRunId === 'string' ? (parsed as any).goalRunId : undefined,
      };
    } catch {
      return null;
    }
  }

  private extractAnswer(
    values: Record<string, Record<string, { type?: string; value?: string }>> | undefined,
  ): string | null {
    if (!values || typeof values !== 'object') return null;
    for (const blockId of Object.keys(values)) {
      const block = values[blockId];
      if (!block || typeof block !== 'object') continue;
      for (const actionId of Object.keys(block)) {
        const entry = block[actionId];
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.value === 'string' && entry.value.trim() !== '') {
          return entry.value.trim();
        }
      }
    }
    return null;
  }

  private async openResolveModal(triggerId: string, metadata: SlackPromptMetadata): Promise<void> {
    const view = {
      type: 'modal',
      callback_id: 'bytebot_user_prompt_resolve',
      private_metadata: JSON.stringify(metadata),
      title: { type: 'plain_text', text: 'ByteBot Prompt' },
      submit: { type: 'plain_text', text: 'Resolve' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Prompt:* \`${metadata.promptId}\`` +
              (metadata.goalRunId ? `\n*Goal Run:* \`${metadata.goalRunId}\`` : '') +
              (metadata.kind ? `\n*Kind:* ${metadata.kind}` : ''),
          },
        },
        {
          type: 'input',
          block_id: 'answer_block',
          label: { type: 'plain_text', text: 'Answer' },
          element: {
            type: 'plain_text_input',
            action_id: 'answer',
            multiline: true,
          },
        },
      ],
    };

    const response = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok !== true) {
      this.logger.warn(`Slack views.open failed: ${response.status} ${JSON.stringify(json)}`);
    }
  }
}

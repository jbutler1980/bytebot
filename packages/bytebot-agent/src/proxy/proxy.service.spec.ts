import { ProxyService } from './proxy.service';
import { LLMResilienceService } from '../llm-resilience/llm-resilience.service';
import { MessageContentType } from '@bytebot/shared';
import { Role } from '@prisma/client';

describe('ProxyService endpoint failover', () => {
  const makeResilience = (eventEmitter: { emit: jest.Mock }) => {
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        const map: Record<string, string> = {
          LLM_MAX_RETRIES: '0',
          LLM_BASE_DELAY_MS: '1',
          LLM_MAX_DELAY_MS: '1',
          LLM_JITTER_FACTOR: '0',
          LLM_CIRCUIT_BREAKER_THRESHOLD: '5',
          LLM_CIRCUIT_BREAKER_RESET_MS: '60000',
        };
        return map[key] ?? fallback;
      }),
    } as any;

    return new LLMResilienceService(configService, eventEmitter as any);
  };

  it('fails over to the next endpoint on NETWORK errors', async () => {
    const eventEmitter = { emit: jest.fn() };
    const llmResilienceService = makeResilience(eventEmitter);

    const configService = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          BYTEBOT_LLM_PROXY_URL: 'http://local-proxy:4000',
          BYTEBOT_LLM_PROXY_ENDPOINTS:
            'http://local-proxy:4000,http://global-proxy:4000',
          BYTEBOT_LLM_PROXY_DESKTOP_VISION_ENDPOINTS:
            'http://local-proxy:4000,http://global-proxy:4000',
          BYTEBOT_LLM_PROXY_API_KEY: 'dummy',
        };
        return map[key] ?? '';
      }),
    } as any;

    const localCreate = jest.fn(async () => {
      const error = new Error('connect ECONNREFUSED 10.0.0.1:4000');
      (error as any).code = 'ECONNREFUSED';
      throw error;
    });
    const globalCreate = jest.fn(async () => {
      return {
        model: 'desktop-vision',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    class TestProxyService extends ProxyService {
      protected override createOpenAIClient(baseURL: string): any {
        if (baseURL.includes('local-proxy')) {
          return { chat: { completions: { create: localCreate } } };
        }
        return { chat: { completions: { create: globalCreate } } };
      }
    }

    const service = new TestProxyService(
      configService,
      llmResilienceService,
      eventEmitter as any,
    );

    const messages = [
      {
        id: 'm1',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: 't1',
        summaryId: null,
        role: Role.USER,
        content: [{ type: MessageContentType.Text, text: 'hello' }],
      },
    ] as any;

    const response = await service.generateMessage('system', messages, 'desktop-vision', false);
    expect(response.contentBlocks[0]).toEqual({ type: MessageContentType.Text, text: 'ok' });

    expect(localCreate).toHaveBeenCalledTimes(1);
    expect(globalCreate).toHaveBeenCalledTimes(1);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'llm.endpoint.failover',
      expect.objectContaining({
        reason: 'NETWORK',
        requestedModel: 'desktop-vision',
      }),
    );
  });

  it('treats openai/qwen3-vl-32b as desktop-vision for endpoint ordering', async () => {
    const eventEmitter = { emit: jest.fn() };
    const llmResilienceService = makeResilience(eventEmitter);

    const configService = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          BYTEBOT_LLM_PROXY_URL: 'http://local-proxy:4000',
          BYTEBOT_LLM_PROXY_ENDPOINTS:
            'http://local-proxy:4000,http://global-proxy:4000',
          // Desktop-vision ordering is global-first
          BYTEBOT_LLM_PROXY_DESKTOP_VISION_ENDPOINTS:
            'http://global-proxy:4000,http://local-proxy:4000',
          BYTEBOT_LLM_PROXY_API_KEY: 'dummy',
        };
        return map[key] ?? '';
      }),
    } as any;

    const localCreate = jest.fn(async () => {
      const error = new Error('connect ECONNREFUSED 10.0.0.1:4000');
      (error as any).code = 'ECONNREFUSED';
      throw error;
    });
    const globalCreate = jest.fn(async () => {
      return {
        model: 'qwen3-vl-32b',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    class TestProxyService extends ProxyService {
      protected override createOpenAIClient(baseURL: string): any {
        if (baseURL.includes('local-proxy')) {
          return { chat: { completions: { create: localCreate } } };
        }
        return { chat: { completions: { create: globalCreate } } };
      }
    }

    const service = new TestProxyService(
      configService,
      llmResilienceService,
      eventEmitter as any,
    );

    const messages = [
      {
        id: 'm1',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: 't1',
        summaryId: null,
        role: Role.USER,
        content: [{ type: MessageContentType.Text, text: 'hello' }],
      },
    ] as any;

    await service.generateMessage(
      'system',
      messages,
      'openai/qwen3-vl-32b',
      false,
    );

    expect(globalCreate).toHaveBeenCalledTimes(1);
    expect(localCreate).toHaveBeenCalledTimes(0);
  });

  it('limits historical screenshots sent to the model (desktop-vision)', async () => {
    const eventEmitter = { emit: jest.fn() };
    const llmResilienceService = makeResilience(eventEmitter);

    const configService = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          BYTEBOT_LLM_PROXY_URL: 'http://global-proxy:4000',
          BYTEBOT_LLM_PROXY_ENDPOINTS: 'http://global-proxy:4000',
          BYTEBOT_LLM_PROXY_DESKTOP_VISION_ENDPOINTS: 'http://global-proxy:4000',
          BYTEBOT_LLM_PROXY_API_KEY: 'dummy',
          BYTEBOT_LLM_MAX_IMAGE_BLOCKS: '10',
          BYTEBOT_LLM_MAX_IMAGE_BLOCKS_DESKTOP_VISION: '1',
        };
        return map[key] ?? '';
      }),
    } as any;

    let capturedRequest: any | undefined;
    const globalCreate = jest.fn(async (req: any) => {
      capturedRequest = req;
      return {
        model: 'qwen3-vl-32b',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    class TestProxyService extends ProxyService {
      protected override createOpenAIClient(): any {
        return { chat: { completions: { create: globalCreate } } };
      }
    }

    const service = new TestProxyService(
      configService,
      llmResilienceService,
      eventEmitter as any,
    );

    const screenshot1 = {
      type: MessageContentType.ToolResult,
      tool_use_id: 'tool-1',
      content: [
        {
          type: MessageContentType.Image,
          source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
        },
      ],
    };

    const screenshot2 = {
      type: MessageContentType.ToolResult,
      tool_use_id: 'tool-2',
      content: [
        {
          type: MessageContentType.Image,
          source: { type: 'base64', media_type: 'image/png', data: 'BBB' },
        },
      ],
    };

    const messages = [
      {
        id: 'm1',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: 't1',
        summaryId: null,
        role: Role.USER,
        content: [screenshot1],
      },
      {
        id: 'm2',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: 't1',
        summaryId: null,
        role: Role.USER,
        content: [screenshot2],
      },
    ] as any;

    await service.generateMessage('system', messages, 'desktop-vision', false);

    const msgJson = JSON.stringify(capturedRequest?.messages || []);
    expect(msgJson).toContain('BBB');
    expect(msgJson).not.toContain('AAA');
  });
});

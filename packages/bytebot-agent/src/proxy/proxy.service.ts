/**
 * Proxy Service
 * v2.5.0: Added LLM resilience with retry logic and circuit breaker
 *
 * This service proxies LLM requests through LiteLLM and now includes:
 * - Exponential backoff with jitter for transient failures
 * - Circuit breaker to prevent cascading failures
 * - Error classification (retryable vs. permanent)
 * - Retry-after header support for rate limits
 *
 * @see LLMResilienceService for retry implementation details
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import OpenAI, { APIUserAbortError } from 'openai';
import { LLMResilienceService } from '../llm-resilience/llm-resilience.service';
import { LLMErrorType } from '../llm-resilience/llm-resilience.service';
import {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  isUserActionContentBlock,
  isComputerToolUseContentBlock,
  isImageContentBlock,
  ThinkingContentBlock,
} from '@bytebot/shared';
import { Message, Role } from '@prisma/client';
import { proxyTools } from './proxy.tools';
import {
  BytebotAgentService,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';

@Injectable()
export class ProxyService implements BytebotAgentService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly proxyApiKey: string;
  private readonly defaultProxyEndpoints: string[];
  private readonly desktopVisionProxyEndpoints: string[];
  private readonly defaultMaxImageBlocks: number;
  private readonly desktopVisionMaxImageBlocks: number;
  private readonly openaiClientsByBaseUrl = new Map<string, OpenAI>();

  constructor(
    private readonly configService: ConfigService,
    private readonly llmResilienceService: LLMResilienceService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const primaryProxyUrl = (this.configService.get<string>('BYTEBOT_LLM_PROXY_URL') || '').trim();
    this.proxyApiKey = (this.configService.get<string>('BYTEBOT_LLM_PROXY_API_KEY') || '').trim();

    const endpointsRaw = (this.configService.get<string>('BYTEBOT_LLM_PROXY_ENDPOINTS') || '').trim();
    const desktopVisionEndpointsRaw = (this.configService.get<string>('BYTEBOT_LLM_PROXY_DESKTOP_VISION_ENDPOINTS') || '').trim();

    this.defaultProxyEndpoints = this.parseProxyEndpoints(endpointsRaw) ||
      (primaryProxyUrl ? [this.normalizeBaseUrl(primaryProxyUrl)] : []);
    this.desktopVisionProxyEndpoints = this.parseProxyEndpoints(desktopVisionEndpointsRaw) ||
      this.defaultProxyEndpoints;

    this.defaultMaxImageBlocks = Math.max(
      0,
      parseInt(
        (this.configService.get<string>('BYTEBOT_LLM_MAX_IMAGE_BLOCKS') || '8').trim(),
        10,
      ) || 0,
    );
    this.desktopVisionMaxImageBlocks = Math.max(
      0,
      parseInt(
        (this.configService.get<string>('BYTEBOT_LLM_MAX_IMAGE_BLOCKS_DESKTOP_VISION') || '2').trim(),
        10,
      ) || 0,
    );

    if (this.defaultProxyEndpoints.length === 0) {
      this.logger.warn(
        'BYTEBOT_LLM_PROXY_URL is not set. ProxyService will not work properly.',
      );
    }

    const primaryForLog = this.defaultProxyEndpoints[0] ?? primaryProxyUrl ?? '';
    this.logger.log(
      `ProxyService initialized with LLM resilience (primary proxy: ${primaryForLog || 'unset'})`,
    );
  }

  private parseProxyEndpoints(raw: string): string[] | null {
    if (!raw) return null;
    const endpoints = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => this.normalizeBaseUrl(s));
    const unique = Array.from(new Set(endpoints));
    return unique.length > 0 ? unique : null;
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private isDesktopVisionRequestedModel(model: string): boolean {
    const trimmed = (model || '').trim();
    return (
      trimmed === 'desktop-vision' ||
      trimmed === 'qwen3-vl-32b' ||
      trimmed.endsWith('/qwen3-vl-32b')
    );
  }

  private getProxyEndpointsForModel(model: string): string[] {
    // Scoped stop-the-bleed: desktop-vision can use a different endpoint ordering (e.g., global-first).
    if (this.isDesktopVisionRequestedModel(model)) return this.desktopVisionProxyEndpoints;
    return this.defaultProxyEndpoints;
  }

  private endpointKey(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return `litellm:${url.host}`;
    } catch {
      return `litellm:${baseUrl}`;
    }
  }

  protected createOpenAIClient(baseURL: string): OpenAI {
    // Use proxy auth key when required (e.g., LiteLLM master_key enabled).
    // Keep dummy fallback for backwards compatibility with unauthenticated proxies.
    return new OpenAI({
      apiKey: this.proxyApiKey || 'dummy-key-for-proxy',
      baseURL,
      // v2.5.0: Increase default timeout to allow for retry logic
      timeout: 120000, // 2 minutes (increased from default 10 minutes)
    });
  }

  private getOpenAIClient(baseUrl: string): OpenAI {
    const normalized = this.normalizeBaseUrl(baseUrl);
    const existing = this.openaiClientsByBaseUrl.get(normalized);
    if (existing) return existing;
    const client = this.createOpenAIClient(normalized);
    this.openaiClientsByBaseUrl.set(normalized, client);
    return client;
  }

  /**
   * Check if a model is an OpenAI o-series reasoning model
   * These models support the reasoning_effort parameter
   */
  private isReasoningModel(model: string): boolean {
    // Extract model name from potential namespace (e.g., "openai/o3-..." -> "o3-...")
    const modelName = model.includes('/') ? model.split('/').pop() || model : model;
    // O-series models start with 'o' followed by a digit (o1, o3, etc.)
    return /^o\d/.test(modelName);
  }

  /**
   * Main method to generate messages using the Chat Completions API
   *
   * v2.5.0: Now includes retry logic with exponential backoff
   * - 5 retries for transient failures (timeout, rate limit, server errors)
   * - Circuit breaker to prevent cascading failures
   * - Abort signal still respected for user-initiated cancellation
   */
  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string,
    useTools: boolean = true,
    signal?: AbortSignal,
  ): Promise<BytebotAgentResponse> {
    // Convert messages to Chat Completion format
    const chatMessages = this.formatMessagesForChatCompletion(
      systemPrompt,
      messages,
      model,
    );

    // Determine if model supports reasoning_effort parameter
    // Only OpenAI o-series models (o1, o3, etc.) support this
    // Anthropic models use 'thinking' parameter instead (disabled via anthropic.service.ts)
    const isReasoning = this.isReasoningModel(model);

    // Prepare the Chat Completion request
    const completionRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: chatMessages,
      max_tokens: 8192,
      ...(useTools && { tools: proxyTools }),
      // Only include reasoning_effort for o-series models
      // Non-reasoning models (Claude, GPT-4, etc.) don't support this parameter
      ...(isReasoning && { reasoning_effort: 'high' }),
    };

    const endpoints = this.getProxyEndpointsForModel(model);
    const attemptedEndpointKeys: string[] = [];
    let lastFailure: { errorType: string; errorMessage: string; attempts: number; durationMs: number } | null = null;

    for (let i = 0; i < endpoints.length; i++) {
      const baseUrl = endpoints[i];
      const key = this.endpointKey(baseUrl);
      attemptedEndpointKeys.push(key);

      const openai = this.getOpenAIClient(baseUrl);
      const callStart = Date.now();

      // v2.5.0+: Wrap API call with retry logic (maxRetries=0 per-endpoint; failover happens at the endpoint layer).
      const result = await this.llmResilienceService.executeWithRetry(
        async () => {
          // Check if aborted before making the call
          if (signal?.aborted) {
            throw new APIUserAbortError();
          }

          return await openai.chat.completions.create(completionRequest, { signal });
        },
        key,
        // Connection errors are INFRA: fail fast and fail over to next endpoint when configured.
        { maxRetries: 0 },
      );

      // Handle abort separately (not a retryable error)
      if (!result.success && result.error?.originalError instanceof APIUserAbortError) {
        this.logger.log('Chat Completion API call aborted by user');
        throw new BytebotAgentInterrupt();
      }

      if (result.success) {
        const completion = result.result!;
        this.eventEmitter.emit('llm.endpoint.call', {
          endpoint: key,
          requestedModel: model,
          durationMs: Date.now() - callStart,
        });

        // Emit failover event when LiteLLM routed to a different underlying model.
        // This is expected when model-group fallbacks are configured.
        if (completion.model && completion.model !== model) {
          this.eventEmitter.emit('llm.failover', {
            endpoint: key,
            requestedModel: model,
            usedModel: completion.model,
          });
        }

        // Process the response
        const choice = completion.choices[0];
        if (!choice || !choice.message) {
          throw new Error('No valid response from Chat Completion API');
        }

        // Convert response to MessageContentBlocks
        const contentBlocks = this.formatChatCompletionResponse(choice.message);

        return {
          contentBlocks,
          tokenUsage: {
            inputTokens: completion.usage?.prompt_tokens || 0,
            outputTokens: completion.usage?.completion_tokens || 0,
            totalTokens: completion.usage?.total_tokens || 0,
          },
        };
      }

      const errorType = result.error?.type || 'UNKNOWN';
      const errorMessage = result.error?.message || 'Unknown error';

      lastFailure = {
        errorType,
        errorMessage,
        attempts: result.attempts,
        durationMs: result.totalDurationMs,
      };

      // Endpoint-level failover decision: only for infrastructure failures.
      const isInfra =
        errorType === LLMErrorType.NETWORK ||
        errorType === LLMErrorType.TIMEOUT ||
        errorType === LLMErrorType.SERVER_ERROR ||
        errorType === LLMErrorType.OVERLOADED ||
        errorType === LLMErrorType.RATE_LIMIT;

      const hasNextEndpoint = i < endpoints.length - 1;
      if (isInfra && hasNextEndpoint) {
        // Open circuit immediately to prevent hammering a broken gateway.
        this.llmResilienceService.openCircuit(key, result.error || undefined);

        const nextKey = this.endpointKey(endpoints[i + 1]);
        this.eventEmitter.emit('llm.endpoint.failover', {
          fromEndpoint: key,
          toEndpoint: nextKey,
          reason: errorType,
          requestedModel: model,
        });

        this.logger.warn(
          `LLM endpoint failed [${errorType}] (${key}); failing over to ${nextKey}`,
        );
        continue;
      }

      // Non-infra failure (or no fallback endpoint): stop here.
      break;
    }

    const errorType = lastFailure?.errorType || 'UNKNOWN';
    const errorMessage = lastFailure?.errorMessage || 'Unknown error';
    const attempts = lastFailure?.attempts || 0;
    const durationMs = lastFailure?.durationMs || 0;

    this.logger.error(
      `LLM call failed after ${attempts} attempts: [${errorType}] ${errorMessage}`,
    );

    const error = new Error(`LLM API error after ${attempts} attempts: ${errorMessage}`);
    (error as any).llmErrorType = errorType;
    (error as any).attempts = attempts;
    (error as any).durationMs = durationMs;
    (error as any).attemptedEndpoints = attemptedEndpointKeys;
    throw error;
  }

  /**
   * Convert Bytebot messages to Chat Completion format
   */
  private formatMessagesForChatCompletion(
    systemPrompt: string,
    messages: Message[],
    requestedModel: string,
  ): ChatCompletionMessageParam[] {
    const chatMessages: ChatCompletionMessageParam[] = [];

    const maxImages = this.isDesktopVisionRequestedModel(requestedModel)
      ? this.desktopVisionMaxImageBlocks
      : this.defaultMaxImageBlocks;
    const includedImageRefs = this.getIncludedImageRefs(messages, maxImages);

    // Add system message
    chatMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Process each message
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      // Handle user actions specially
      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );

        for (const block of userActionBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            chatMessages.push({
              role: 'user',
              content: `User performed action: ${block.name}\n${JSON.stringify(
                block.input,
                null,
                2,
              )}`,
            });
          } else if (isImageContentBlock(block)) {
            if (!includedImageRefs.has(block)) continue;
            chatMessages.push({
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                    detail: 'high',
                  },
                },
              ],
            });
          }
        }
      } else {
        for (const block of messageContentBlocks) {
          switch (block.type) {
            case MessageContentType.Text: {
              chatMessages.push({
                role: message.role === Role.USER ? 'user' : 'assistant',
                content: block.text,
              });
              break;
            }
            case MessageContentType.Image: {
              const imageBlock = block as ImageContentBlock;
              if (!includedImageRefs.has(imageBlock)) break;
              chatMessages.push({
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                      detail: 'high',
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.ToolUse: {
              const toolBlock = block as ToolUseContentBlock;
              chatMessages.push({
                role: 'assistant',
                tool_calls: [
                  {
                    id: toolBlock.id,
                    type: 'function',
                    function: {
                      name: toolBlock.name,
                      arguments: JSON.stringify(toolBlock.input),
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.Thinking: {
              const thinkingBlock = block as ThinkingContentBlock;
              const message: ChatCompletionMessageParam = {
                role: 'assistant',
                content: null,
              };
              message['reasoning_content'] = thinkingBlock.thinking;
              chatMessages.push(message);
              break;
            }
            case MessageContentType.ToolResult: {
              const toolResultBlock = block as ToolResultContentBlock;

              if (
                toolResultBlock.content.every(
                  (content) => content.type === MessageContentType.Image,
                )
              ) {
                chatMessages.push({
                  role: 'tool',
                  tool_call_id: toolResultBlock.tool_use_id,
                  content: 'screenshot',
                });
              }

              toolResultBlock.content.forEach((content) => {
                if (content.type === MessageContentType.Text) {
                  chatMessages.push({
                    role: 'tool',
                    tool_call_id: toolResultBlock.tool_use_id,
                    content: content.text,
                  });
                }

                if (content.type === MessageContentType.Image) {
                  if (!includedImageRefs.has(content)) return;
                  chatMessages.push({
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'Screenshot',
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: `data:${content.source.media_type};base64,${content.source.data}`,
                          detail: 'high',
                        },
                      },
                    ],
                  });
                }
              });
              break;
            }
          }
        }
      }
    }

    return chatMessages;
  }

  private getIncludedImageRefs(messages: Message[], maxImages: number): Set<unknown> {
    if (maxImages <= 0) return new Set();

    const imageRefs: unknown[] = [];
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      if (messageContentBlocks.every((block) => isUserActionContentBlock(block))) {
        const userActionBlocks = messageContentBlocks.flatMap((block) => block.content);
        for (const block of userActionBlocks) {
          if (isImageContentBlock(block)) {
            imageRefs.push(block);
          }
        }
        continue;
      }

      for (const block of messageContentBlocks) {
        if (block.type === MessageContentType.Image) {
          imageRefs.push(block);
          continue;
        }

        if (block.type === MessageContentType.ToolResult) {
          const toolResultBlock = block as ToolResultContentBlock;
          for (const content of toolResultBlock.content) {
            if (content.type === MessageContentType.Image) {
              imageRefs.push(content);
            }
          }
        }
      }
    }

    const include = new Set<unknown>();
    for (let i = imageRefs.length - 1; i >= 0 && include.size < maxImages; i--) {
      include.add(imageRefs[i]);
    }
    return include;
  }

  /**
   * Convert Chat Completion response to MessageContentBlocks
   */
  private formatChatCompletionResponse(
    message: OpenAI.Chat.ChatCompletionMessage,
  ): MessageContentBlock[] {
    const contentBlocks: MessageContentBlock[] = [];

    // Handle text content
    if (message.content) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: message.content,
      } as TextContentBlock);
    }

    if (message['reasoning_content']) {
      contentBlocks.push({
        type: MessageContentType.Thinking,
        thinking: message['reasoning_content'],
        signature: message['reasoning_content'],
      } as ThinkingContentBlock);
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            this.logger.warn(
              `Failed to parse tool call arguments: ${toolCall.function.arguments}`,
            );
            parsedInput = {};
          }

          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          } as ToolUseContentBlock);
        }
      }
    }

    // Handle refusal
    if (message.refusal) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: `Refusal: ${message.refusal}`,
      } as TextContentBlock);
    }

    return contentBlocks;
  }
}

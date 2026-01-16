export type NeedsHelpErrorCode =
  | 'DISPATCHED_USER_PROMPT_STEP'
  | 'DESKTOP_NOT_ALLOWED'
  | 'LLM_EMPTY_RESPONSE'
  | 'AGENT_REQUESTED_HELP';

export type NeedsHelpResult = {
  errorCode: NeedsHelpErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

const DEFAULT_MESSAGES: Record<NeedsHelpErrorCode, string> = {
  DISPATCHED_USER_PROMPT_STEP:
    'This task requires user input and must not be executed by the agent.',
  DESKTOP_NOT_ALLOWED:
    'Desktop tools were requested, but this task is configured for TEXT_ONLY execution.',
  LLM_EMPTY_RESPONSE: 'LLM returned an empty response.',
  AGENT_REQUESTED_HELP: 'Agent requested help.',
};

export function buildNeedsHelpResult(input: {
  errorCode: NeedsHelpErrorCode;
  message?: string | null;
  details?: Record<string, unknown> | null;
}): NeedsHelpResult {
  const message =
    typeof input.message === 'string' && input.message.trim().length > 0
      ? input.message.trim()
      : DEFAULT_MESSAGES[input.errorCode];

  const details =
    input.details && typeof input.details === 'object' ? input.details : undefined;

  return {
    errorCode: input.errorCode,
    message,
    ...(details ? { details } : {}),
  };
}


import { buildNeedsHelpResult } from './needs-help';

describe('needs-help helpers', () => {
  it('uses default message when message is empty', () => {
    const result = buildNeedsHelpResult({
      errorCode: 'LLM_EMPTY_RESPONSE',
      message: '   ',
    });

    expect(result.errorCode).toBe('LLM_EMPTY_RESPONSE');
    expect(result.message).toBe('LLM returned an empty response.');
  });

  it('passes through details when provided', () => {
    const result = buildNeedsHelpResult({
      errorCode: 'DESKTOP_NOT_ALLOWED',
      message: 'Custom',
      details: { executionSurface: 'TEXT_ONLY' },
    });

    expect(result).toEqual({
      errorCode: 'DESKTOP_NOT_ALLOWED',
      message: 'Custom',
      details: { executionSurface: 'TEXT_ONLY' },
    });
  });
});


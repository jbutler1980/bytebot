import { PlannerService } from './planner.service';
import { StepType } from '@prisma/client';
import { PlannerFirstStepUserInputError } from './planner.errors';

describe('PlannerService no USER_INPUT_REQUIRED first step', () => {
  const makeService = () => {
    const prisma = {} as any;
    const goalRunService = {} as any;
    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;
    return new PlannerService(prisma, goalRunService, configService);
  };

  it('rejects prompt-first output when the LLM returns USER_INPUT_REQUIRED as step 1', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Ask the user for the fire-drill codeword',
            type: StepType.USER_INPUT_REQUIRED,
            expectedOutcome: 'User provides codeword',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Validate codeword',
            type: StepType.EXECUTE,
            expectedOutcome: 'Codeword validated',
            suggestedTools: ['Shell'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect((service as any).callLLMForPlan('Fire drill', {})).rejects.toBeInstanceOf(
      PlannerFirstStepUserInputError,
    );
  });

  it('rejects prompt-first output when step 1 is EXECUTE but has suggestedTools=["ASK_USER"]', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Clarify target URL with the user',
            type: StepType.EXECUTE,
            expectedOutcome: 'URL clarified',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Proceed with task',
            type: StepType.EXECUTE,
            expectedOutcome: 'Task progressed',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const promise = (service as any).callLLMForPlan('Do the thing', {});
    await expect(promise).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);

    await promise.catch((error: PlannerFirstStepUserInputError) => {
      expect(error.reason).toBe('ASK_USER_TOOL');
    });
  });

  it('rejects likely prompt-first output when description suggests asking the user but tools are missing', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Ask the user for required details',
            type: StepType.EXECUTE,
            suggestedTools: [],
            requiresDesktop: false,
          },
          ...Array.from({ length: 2 }).map((_, i) => ({
            description: `Execute step ${i + 2}`,
            type: StepType.EXECUTE,
            suggestedTools: [],
            requiresDesktop: false,
          })),
        ],
        confidence: 0.9,
      }),
    );

    const promise = (service as any).callLLMForPlan('Do stuff', {});
    await expect(promise).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);

    await promise.catch((error: PlannerFirstStepUserInputError) => {
      expect(error.reason).toBe('LIKELY_USER_INPUT_DESCRIPTION');
    });
  });

  it('rejects prompt-first replans (so the orchestrator can convert to GOAL_INTAKE)', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Ask the user for missing required details',
            type: StepType.USER_INPUT_REQUIRED,
            expectedOutcome: 'User provides details',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Proceed with task',
            type: StepType.EXECUTE,
            expectedOutcome: 'Task progressed',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect(
      (service as any).callLLMForReplan(
        'Do stuff',
        {},
        { checklistItems: [] },
        'Need more info',
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);
  });
});

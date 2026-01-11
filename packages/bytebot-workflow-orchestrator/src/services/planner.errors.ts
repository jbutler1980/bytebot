import { StepType } from '@prisma/client';

export type PlannerChecklistItem = {
  description: string;
  type: StepType;
  expectedOutcome?: string;
  suggestedTools?: string[];
  requiresDesktop?: boolean;
};

export type PlannerFirstStepUserInputReason =
  | 'USER_INPUT_REQUIRED_TYPE'
  | 'ASK_USER_TOOL'
  | 'LIKELY_USER_INPUT_DESCRIPTION';

/**
 * Raised when the planner attempts to start a plan with a user-interaction step.
 *
 * We treat this as a GoalSpec intake requirement rather than saving a prompt-first plan.
 * This prevents runs that immediately enter WAITING_USER_INPUT with no progress.
 */
export class PlannerFirstStepUserInputError extends Error {
  readonly firstStep: PlannerChecklistItem;
  readonly mode: 'initial' | 'replan';
  readonly reason: PlannerFirstStepUserInputReason;

  constructor(params: {
    mode: 'initial' | 'replan';
    firstStep: PlannerChecklistItem;
    reason: PlannerFirstStepUserInputReason;
  }) {
    super(
      `Planner produced a prompt-first plan (${params.reason}) in ${params.mode} mode: ${params.firstStep.description}`,
    );
    this.name = 'PlannerFirstStepUserInputError';
    this.mode = params.mode;
    this.firstStep = params.firstStep;
    this.reason = params.reason;
  }
}

export function detectPlannerFirstStepUserInputReason(
  firstStep: PlannerChecklistItem,
): PlannerFirstStepUserInputReason | null {
  if (firstStep.type === StepType.USER_INPUT_REQUIRED) return 'USER_INPUT_REQUIRED_TYPE';
  if ((firstStep.suggestedTools ?? []).includes('ASK_USER')) return 'ASK_USER_TOOL';

  // Last-resort safety net: some models misclassify an ask-user step as EXECUTE without tagging tools.
  // Keep this narrow to avoid false positives.
  const description = firstStep.description.toLowerCase();
  if (description.includes('ask the user') || description.includes('ask user')) {
    return 'LIKELY_USER_INPUT_DESCRIPTION';
  }
  if (description.includes('confirm with the user') || description.includes('clarify with the user')) {
    return 'LIKELY_USER_INPUT_DESCRIPTION';
  }

  return null;
}


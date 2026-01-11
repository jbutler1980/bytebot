import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createId } from '@paralleldrive/cuid2';
import {
  ActorType,
  ChecklistItemStatus,
  GoalRunPhase,
  GoalSpecStatus,
  StepType,
  UserPromptKind,
  UserPromptStatus,
} from '@prisma/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Histogram } from 'prom-client';
import { PrismaService } from './prisma.service';
import { AuditService, AuditEventType } from './audit.service';

@Injectable()
export class UserPromptResolutionService {
  private readonly logger = new Logger(UserPromptResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @InjectMetric('user_prompt_time_to_resolve_seconds')
    private readonly userPromptTimeToResolveSeconds: Histogram<string>,
    @InjectMetric('prompt_resolved_total')
    private readonly promptResolvedTotal: Counter<string>,
    @InjectMetric('goal_intake_completed_total')
    private readonly goalIntakeCompletedTotal: Counter<string>,
    @InjectMetric('resume_outbox_enqueued_total')
    private readonly resumeOutboxEnqueuedTotal: Counter<string>,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private evaluateResolutionAuthz(params: {
    promptKind: UserPromptKind;
    actorType: ActorType;
  }): { allowed: true; policy: string; ruleId: string; reason: string } | { allowed: false; policy: string; ruleId: string; reason: string } {
    const policy = 'prompt_resolution.v1';

    // Approvals are governance objects: human-only unless explicitly expanded by policy (not yet).
    if (params.promptKind === UserPromptKind.APPROVAL) {
      if (params.actorType !== ActorType.HUMAN) {
        return {
          allowed: false,
          policy,
          ruleId: 'approval_human_only',
          reason: 'Only HUMAN actors may resolve approval prompts',
        };
      }
      return { allowed: true, policy, ruleId: 'approval_human_only', reason: 'HUMAN actor approved/denied approval prompt' };
    }

    // Desktop takeover prompts require a real human at the controls by default.
    if (params.promptKind === UserPromptKind.DESKTOP_TAKEOVER) {
      if (params.actorType !== ActorType.HUMAN) {
        return {
          allowed: false,
          policy,
          ruleId: 'desktop_takeover_human_only',
          reason: 'Only HUMAN actors may resolve desktop takeover prompts',
        };
      }
      return { allowed: true, policy, ruleId: 'desktop_takeover_human_only', reason: 'HUMAN actor resolved desktop takeover prompt' };
    }

    // Text-only prompts: parent agents may answer by policy (human fallback remains supported).
    if (
      params.actorType === ActorType.PARENT_AGENT ||
      params.actorType === ActorType.AGENT
    ) {
      return { allowed: true, policy, ruleId: 'parent_agent_text_only', reason: 'Agent actor allowed for text-only prompt kinds' };
    }

    // System automation: allowed for non-approval, non-takeover prompts.
    if (params.actorType === ActorType.SYSTEM) {
      return { allowed: true, policy, ruleId: 'system_text_only', reason: 'SYSTEM actor allowed for text-only prompt kinds' };
    }

    // Default allow for HUMAN.
    return { allowed: true, policy, ruleId: 'human_default', reason: 'HUMAN actor allowed' };
  }

  async resolvePrompt(request: {
    promptId: string;
    tenantId: string;
    actor: {
      type: ActorType;
      id?: string;
      email?: string;
      name?: string;
      authContext?: Record<string, any>;
    };
    answers: Record<string, any>;
    requestId?: string;
    clientRequestId?: string;
    idempotencyKey?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{
    promptId: string;
    goalRunId: string;
    checklistItemId?: string | null;
    goalSpecId?: string | null;
    didResolve: boolean;
    promptStatus: UserPromptStatus;
    promptKind: UserPromptKind;
  }> {
    if (!request.tenantId) throw new BadRequestException('tenantId is required');
    if (!request.actor?.type) throw new BadRequestException('actor.type is required');

    if (request.actor.type === ActorType.HUMAN) {
      if (!request.actor.id && !request.actor.email) {
        throw new BadRequestException('actor.id or actor.email is required for HUMAN');
      }
    } else if (request.actor.type === ActorType.AGENT || request.actor.type === ActorType.PARENT_AGENT) {
      if (!request.actor.id) throw new BadRequestException('actor.id is required for AGENT');
    } else if (request.actor.type === ActorType.SYSTEM) {
      if (!request.actor.id) throw new BadRequestException('actor.id is required for SYSTEM');
    }

    const { promptId } = request;
    const resolvedAt = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const prompt = await tx.userPrompt.findUnique({ where: { id: promptId } });

      if (!prompt) {
        throw new NotFoundException(`UserPrompt ${promptId} not found`);
      }

      // Enforce tenant boundary (RBAC baseline).
      const promptTenantId = prompt.tenantId || (
        await tx.goalRun.findUnique({ where: { id: prompt.goalRunId }, select: { tenantId: true } })
      )?.tenantId;

      if (!promptTenantId) {
        throw new BadRequestException(`Prompt ${promptId} is missing tenantId`);
      }
      if (promptTenantId !== request.tenantId) {
        throw new ForbiddenException('Prompt does not belong to tenant');
      }

      const authz = this.evaluateResolutionAuthz({ promptKind: prompt.kind, actorType: request.actor.type });
      if (!authz.allowed) {
        throw new ForbiddenException(authz.reason);
      }

      // Idempotent: resolving twice is a no-op.
      if (prompt.status === UserPromptStatus.RESOLVED) {
        return { prompt, didResolve: false, phaseChanged: false, previousPhase: null as GoalRunPhase | null };
      }
      if (prompt.status !== UserPromptStatus.OPEN) {
        throw new ConflictException(`Prompt ${promptId} is not OPEN (status=${prompt.status})`);
      }

      // Immutable resolution record (unique per promptId)
      try {
        await tx.userPromptResolution.create({
          data: {
            id: createId(),
            promptId,
            tenantId: promptTenantId,
            goalRunId: prompt.goalRunId,
            actorType: request.actor.type,
            actorId: request.actor.id,
            actorEmail: request.actor.email,
            actorName: request.actor.name,
            actorIpAddress: request.ipAddress,
            actorUserAgent: request.userAgent,
            requestId: request.requestId,
            authContext: request.actor.authContext ?? {},
            clientRequestId: request.clientRequestId,
            idempotencyKey: request.idempotencyKey,
            authzDecision: 'ALLOW',
            authzPolicy: authz.policy,
            authzRuleId: authz.ruleId,
            authzReason: authz.reason,
            answers: request.answers,
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }

      const updatedPrompt = await tx.userPrompt.update({
        where: { id: promptId },
        data: {
          status: UserPromptStatus.RESOLVED,
          answers: request.answers,
          resolvedAt,
        },
      });

      let checklistItemDescription: string | null = null;

      if (prompt.checklistItemId) {
        const checklistItem = await tx.checklistItem.findUnique({
          where: { id: prompt.checklistItemId },
          select: { type: true, description: true },
        });

        if (!checklistItem) {
          throw new NotFoundException(`ChecklistItem ${prompt.checklistItemId} not found`);
        }

        checklistItemDescription = checklistItem.description;

        // "Unblock step" semantics:
        // - USER_INPUT_REQUIRED: answering satisfies the step → mark COMPLETED.
        // - EXECUTE: user answers unblock execution → mark PENDING (executor decides how to resume).
        if (checklistItem.type === StepType.USER_INPUT_REQUIRED) {
          await tx.checklistItem.updateMany({
            where: {
              id: prompt.checklistItemId,
              status: ChecklistItemStatus.BLOCKED,
            },
            data: {
              status: ChecklistItemStatus.COMPLETED,
              completedAt: resolvedAt,
              actualOutcome: JSON.stringify(
                {
                  promptId,
                  answers: request.answers,
                },
                null,
                2,
              ),
            },
          });
        } else {
          await tx.checklistItem.updateMany({
            where: {
              id: prompt.checklistItemId,
              status: ChecklistItemStatus.BLOCKED,
            },
            data: {
              status: ChecklistItemStatus.PENDING,
              startedAt: null,
              completedAt: null,
            },
          });
        }
      }

      if (prompt.goalSpecId) {
        const goalSpec = await tx.goalSpec.findUnique({
          where: { id: prompt.goalSpecId },
          select: { values: true },
        });

        const mergedValues = {
          ...(goalSpec?.values as any),
          ...(request.answers as any),
        };

        // v1: treat resolution as completing intake; if validation finds missing fields later,
        // the system issues a follow-up prompt revision rather than mutating history.
        await tx.goalSpec.update({
          where: { id: prompt.goalSpecId },
          data: {
            values: mergedValues,
            status: GoalSpecStatus.COMPLETE,
            completedAt: resolvedAt,
          },
        });
      }

      const goalRun = await tx.goalRun.findUnique({
        where: { id: prompt.goalRunId },
        select: { phase: true, tenantId: true },
      });

      if (!goalRun) {
        throw new NotFoundException(`GoalRun ${prompt.goalRunId} not found`);
      }

      const nextPhase =
        prompt.goalSpecId || prompt.kind === UserPromptKind.GOAL_INTAKE
          ? GoalRunPhase.INITIALIZING
          : prompt.kind === UserPromptKind.APPROVAL
            ? GoalRunPhase.EXECUTING
            : GoalRunPhase.EXECUTING;

      const phaseUpdated = await tx.goalRun.updateMany({
        where: {
          id: prompt.goalRunId,
          phase: {
            in: [GoalRunPhase.WAITING_USER_INPUT, GoalRunPhase.WAITING_APPROVAL],
          },
        },
        data: {
          phase: nextPhase,
        },
      });

      // Outbox: emit once per prompt resolution
      const outboxDedupeKey = `user_prompt.resolved:${promptId}`;
      try {
        await tx.outbox.create({
          data: {
            id: createId(),
            dedupeKey: outboxDedupeKey,
            aggregateId: prompt.goalRunId,
            eventType: 'user_prompt.resolved',
            payload: {
              promptId,
              goalRunId: prompt.goalRunId,
              tenantId: goalRun.tenantId,
              checklistItemId: prompt.checklistItemId ?? null,
              goalSpecId: prompt.goalSpecId ?? null,
              kind: updatedPrompt.kind,
              stepDescription: checklistItemDescription,
              resolvedAt: resolvedAt.toISOString(),
            },
          },
        });
      } catch (error: any) {
        // Idempotent: ignore duplicate outbox emission
        if (error?.code !== 'P2002') {
          throw error;
        }
      }

      // Outbox: resume pipeline (DB commit -> outbox -> resumer -> Temporal Update)
      const resumeDedupeKey = `user_prompt.resume:${promptId}`;
      try {
        await tx.outbox.create({
          data: {
            id: createId(),
            dedupeKey: resumeDedupeKey,
            aggregateId: prompt.goalRunId,
            eventType: 'user_prompt.resume',
            payload: {
              promptId,
              goalRunId: prompt.goalRunId,
              tenantId: goalRun.tenantId,
              updateId: resumeDedupeKey,
            },
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') {
          throw error;
        }
      }

      return {
        prompt: updatedPrompt,
        didResolve: true,
        phaseChanged: phaseUpdated.count > 0,
        previousPhase: goalRun.phase,
        nextPhase,
      };
    });

    if (result.didResolve && result.phaseChanged) {
      this.eventEmitter.emit('goal-run.phase-changed', {
        goalRunId: result.prompt.goalRunId,
        previousPhase: result.previousPhase,
        newPhase: result.nextPhase,
      });
    }

    if (result.didResolve) {
      try {
        this.promptResolvedTotal.labels(request.actor.type, result.prompt.kind).inc();
        if ((result.prompt as any).goalSpecId || result.prompt.kind === UserPromptKind.GOAL_INTAKE) {
          this.goalIntakeCompletedTotal.inc();
        }
        this.resumeOutboxEnqueuedTotal.labels('resolution').inc();
      } catch (error: any) {
        this.logger.debug(`Failed to record prompt resolution counters: ${error.message}`);
      }

      if (this.auditService) {
        try {
          await this.auditService.log({
            eventType: AuditEventType.USER_PROMPT_RESOLVED,
            actor: {
              type:
                request.actor.type === ActorType.HUMAN
                  ? 'user'
                  : request.actor.type === ActorType.AGENT || request.actor.type === ActorType.PARENT_AGENT
                    ? 'agent'
                    : 'system',
              id: request.actor.id,
              email: request.actor.email,
              name: request.actor.name,
              ipAddress: request.ipAddress,
              userAgent: request.userAgent,
            },
            resource: {
              type: 'prompt',
              id: request.promptId,
            },
            context: {
              tenantId: request.tenantId,
              workflowRunId: result.prompt.goalRunId,
              requestId: request.requestId,
            },
            action: {
              type: 'resolve',
              previousState: UserPromptStatus.OPEN,
              newState: UserPromptStatus.RESOLVED,
            },
            metadata: {
              goalRunId: result.prompt.goalRunId,
              checklistItemId: result.prompt.checklistItemId ?? null,
              goalSpecId: (result.prompt as any).goalSpecId ?? null,
              kind: result.prompt.kind,
            },
          });
        } catch (error: any) {
          this.logger.warn(`Failed to write audit log for prompt resolution: ${error.message}`);
        }
      }

      try {
        const durationSeconds = (resolvedAt.getTime() - result.prompt.createdAt.getTime()) / 1000;
        this.userPromptTimeToResolveSeconds.labels(result.prompt.kind).observe(durationSeconds);
      } catch (error: any) {
        this.logger.debug(`Failed to record prompt resolution metric: ${error.message}`);
      }
    }

    return {
      promptId: result.prompt.id,
      goalRunId: result.prompt.goalRunId,
      checklistItemId: result.prompt.checklistItemId ?? null,
      goalSpecId: (result.prompt as any).goalSpecId ?? null,
      didResolve: result.didResolve,
      promptStatus: result.prompt.status,
      promptKind: result.prompt.kind,
    };
  }
}

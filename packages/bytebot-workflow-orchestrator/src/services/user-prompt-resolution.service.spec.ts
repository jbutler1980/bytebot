import { UserPromptResolutionService } from './user-prompt-resolution.service';
import { ActorType, GoalRunPhase, StepType, UserPromptStatus } from '@prisma/client';

describe(UserPromptResolutionService.name, () => {
  it('resolves an OPEN prompt once and emits outbox + phase change', async () => {
    const tx: any = {
      userPrompt: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      userPromptResolution: {
        create: jest.fn(),
      },
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      outbox: {
        create: jest.fn(),
      },
    };

    tx.userPrompt.findUnique.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.OPEN,
      kind: 'TEXT_CLARIFICATION',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx.userPromptResolution.create.mockResolvedValue({ id: 'pr-1' });
    tx.userPrompt.update.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.RESOLVED,
      kind: 'TEXT_CLARIFICATION',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx.checklistItem.findUnique.mockResolvedValue({
      type: StepType.USER_INPUT_REQUIRED,
      description: 'Confirm details',
    });
    tx.checklistItem.updateMany.mockResolvedValue({ count: 1 });
    tx.goalRun.findUnique.mockResolvedValue({
      phase: GoalRunPhase.WAITING_USER_INPUT,
      tenantId: 't-1',
    });
    tx.goalRun.updateMany.mockResolvedValue({ count: 1 });
    tx.outbox.create.mockResolvedValue({ id: 'o-1' });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const eventEmitter: any = { emit: jest.fn() };
    const userPromptTimeToResolveSeconds: any = {
      labels: jest.fn(() => ({ observe: jest.fn() })),
    };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      undefined,
    );

    const result = await service.resolvePrompt({
      promptId: 'p-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { answer: 'yes' },
      requestId: 'req-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result).toEqual({
      promptId: 'p-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      didResolve: true,
      promptStatus: UserPromptStatus.RESOLVED,
      promptKind: 'TEXT_CLARIFICATION' as any,
    });

    expect(tx.outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: 'user_prompt.resolved:p-1',
          eventType: 'user_prompt.resolved',
        }),
      }),
    );
    expect(tx.outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: 'user_prompt.resume:p-1',
          eventType: 'user_prompt.resume',
        }),
      }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.phase-changed', expect.anything());
    expect(userPromptTimeToResolveSeconds.labels).toHaveBeenCalledWith('TEXT_CLARIFICATION');
    expect(promptResolvedTotal.labels).toHaveBeenCalledWith(ActorType.HUMAN, 'TEXT_CLARIFICATION');
    expect(resumeOutboxEnqueuedTotal.labels).toHaveBeenCalledWith('resolution');
  });

  it('is idempotent: resolving twice is a no-op second time', async () => {
    const tx1: any = {
      userPrompt: { findUnique: jest.fn(), update: jest.fn() },
      userPromptResolution: { create: jest.fn() },
      checklistItem: { findUnique: jest.fn(), updateMany: jest.fn() },
      goalRun: { findUnique: jest.fn(), updateMany: jest.fn() },
      outbox: { create: jest.fn() },
    };

    tx1.userPrompt.findUnique.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.OPEN,
      kind: 'TEXT_CLARIFICATION',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx1.userPromptResolution.create.mockResolvedValue({ id: 'pr-1' });
    tx1.userPrompt.update.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.RESOLVED,
      kind: 'TEXT_CLARIFICATION',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx1.checklistItem.findUnique.mockResolvedValue({
      type: StepType.USER_INPUT_REQUIRED,
      description: 'Confirm details',
    });
    tx1.checklistItem.updateMany.mockResolvedValue({ count: 1 });
    tx1.goalRun.findUnique.mockResolvedValue({
      phase: GoalRunPhase.WAITING_USER_INPUT,
      tenantId: 't-1',
    });
    tx1.goalRun.updateMany.mockResolvedValue({ count: 1 });
    tx1.outbox.create.mockResolvedValue({ id: 'o-1' });

    const tx2: any = {
      userPrompt: { findUnique: jest.fn(), update: jest.fn() },
      userPromptResolution: { create: jest.fn() },
      checklistItem: { findUnique: jest.fn(), updateMany: jest.fn() },
      goalRun: { findUnique: jest.fn(), updateMany: jest.fn() },
      outbox: { create: jest.fn() },
    };

    tx2.userPrompt.findUnique.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.RESOLVED,
      kind: 'TEXT_CLARIFICATION',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const prisma: any = {
      $transaction: jest
        .fn()
        .mockImplementationOnce(async (fn: any) => fn(tx1))
        .mockImplementationOnce(async (fn: any) => fn(tx2)),
    };

    const eventEmitter: any = { emit: jest.fn() };
    const userPromptTimeToResolveSeconds: any = {
      labels: jest.fn(() => ({ observe: jest.fn() })),
    };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      undefined,
    );

    const first = await service.resolvePrompt({
      promptId: 'p-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { answer: 'yes' },
    });
    const second = await service.resolvePrompt({
      promptId: 'p-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { answer: 'yes' },
    });

    expect(first.didResolve).toBe(true);
    expect(second.didResolve).toBe(false);

    expect(tx1.outbox.create).toHaveBeenCalledTimes(2);
    expect(tx2.outbox.create).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(userPromptTimeToResolveSeconds.labels).toHaveBeenCalledTimes(1);
  });

  it('resolving a GOAL_INTAKE prompt returns run to INITIALIZING (so planning can restart)', async () => {
    const tx: any = {
      userPrompt: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      userPromptResolution: {
        create: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      outbox: {
        create: jest.fn(),
      },
    };

    tx.userPrompt.findUnique.mockResolvedValue({
      id: 'p-gi-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: 'GOAL_INTAKE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx.userPromptResolution.create.mockResolvedValue({ id: 'pr-gi-1' });
    tx.userPrompt.update.mockResolvedValue({
      id: 'p-gi-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      status: UserPromptStatus.RESOLVED,
      kind: 'GOAL_INTAKE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    tx.goalSpec.findUnique.mockResolvedValue({ values: {} });
    tx.goalSpec.update.mockResolvedValue({ id: 'gs-1' });
    tx.goalRun.findUnique.mockResolvedValue({
      phase: GoalRunPhase.WAITING_USER_INPUT,
      tenantId: 't-1',
    });
    tx.goalRun.updateMany.mockResolvedValue({ count: 1 });
    tx.outbox.create.mockResolvedValue({ id: 'o-gi-1' });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const eventEmitter: any = { emit: jest.fn() };
    const userPromptTimeToResolveSeconds: any = {
      labels: jest.fn(() => ({ observe: jest.fn() })),
    };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      undefined,
    );

    const result = await service.resolvePrompt({
      promptId: 'p-gi-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { notes: 'Use account X, target URL Y' },
    });

    expect(result).toEqual({
      promptId: 'p-gi-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      didResolve: true,
      promptStatus: UserPromptStatus.RESOLVED,
      promptKind: 'GOAL_INTAKE' as any,
    });

    expect(tx.goalRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: GoalRunPhase.INITIALIZING }),
      }),
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'goal-run.phase-changed',
      expect.objectContaining({ newPhase: GoalRunPhase.INITIALIZING }),
    );

    expect(goalIntakeCompletedTotal.inc).toHaveBeenCalledTimes(1);
  });
});

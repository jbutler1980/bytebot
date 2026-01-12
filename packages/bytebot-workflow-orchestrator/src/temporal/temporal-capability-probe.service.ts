import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@temporalio/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import { TEMPORAL_CLIENT } from './constants';

@Injectable()
export class TemporalCapabilityProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporalCapabilityProbeService.name);

  private healthy = false;
  private lastError: string | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    @Optional() @Inject(TEMPORAL_CLIENT) private readonly client: Client | null,
    private readonly configService: ConfigService,
    @InjectMetric('temporal_capability_probe_ok') private readonly okGauge: Gauge<string>,
    @InjectMetric('temporal_capability_probe_failures_total')
    private readonly failuresCounter: Counter<string>,
  ) {}

  onModuleInit(): void {
    // Fire-and-forget initial probe so we have a signal quickly after startup.
    void this.probeOnce();

    // Use an unref'ed interval so tests and short-lived processes can exit cleanly.
    const intervalMs = parseInt(process.env.TEMPORAL_CAPABILITY_PROBE_INTERVAL_MS ?? '30000', 10);
    this.intervalHandle = setInterval(() => void this.probeOnce(), intervalMs);
    this.intervalHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isHealthyForTraffic(): boolean {
    return this.healthy;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async probeOnce(): Promise<void> {
    const enabled = this.configService.get<string>('TEMPORAL_WORKFLOW_ENABLED', 'false') === 'true';
    if (!enabled) {
      this.setDisabled();
      return;
    }

    if (!this.client) {
      this.setUnhealthy('TEMPORAL_CLIENT_UNAVAILABLE');
      return;
    }

    try {
      // "Server reachable" capability check. This is intentionally lightweight.
      // We rely on CI Update-contract tests + staged rollout ordering to cover handler registration correctness.
      await this.client.workflowService.getSystemInfo({});
      this.setHealthy();
    } catch (error: any) {
      this.setUnhealthy(String(error?.message ?? error));
    }
  }

  private setHealthy(): void {
    if (!this.healthy) {
      this.logger.log('Temporal capability probe recovered (allowing Temporal routing for new runs)');
    }
    this.healthy = true;
    this.lastError = null;
    this.okGauge.set(1);
  }

  private setUnhealthy(reason: string): void {
    const wasHealthy = this.healthy;
    this.healthy = false;
    this.lastError = reason;
    this.okGauge.set(0);

    // Count failures, but avoid spamming logs every interval.
    this.failuresCounter.inc();
    if (wasHealthy) {
      this.logger.error(`Temporal capability probe failed; gating Temporal routing. reason=${reason}`);
    }
  }

  private setDisabled(): void {
    this.healthy = false;
    this.lastError = 'TEMPORAL_DISABLED';
    this.okGauge.set(0);
  }
}

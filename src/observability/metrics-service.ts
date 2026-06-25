import { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { ServiceStatus } from './types';

export type WebhookOutcome = 'success' | 'failure' | 'dlq';

export interface MetricsServiceLike {
  contentType: string;
  trackHttpRequest: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => Promise<string>;
  recordHealthStatus: (status: ServiceStatus) => void;
  recordWebhookDelivery: (outcome: WebhookOutcome) => void;
  setWebhookDlqDepth: (depth: number) => void;
}

const HEALTH_STATUS_VALUE: Record<ServiceStatus, number> = {
  up: 2,
  degraded: 1,
  down: 0,
};

/**
 * Manages Prometheus metrics registration and request instrumentation.
 */
export class MetricsService implements MetricsServiceLike {
  readonly contentType: string;

  private readonly register: Registry;

  private readonly httpRequestsTotal: Counter;

  private readonly httpRequestDurationSeconds: Histogram;

  private readonly serviceHealthStatus: Gauge;

  private readonly webhookDeliveriesTotal: Counter;

  private readonly webhookDlqDepth: Gauge;

  constructor(private readonly serviceName: string, register?: Registry) {
    this.register = register ?? new Registry();
    collectDefaultMetrics({
      register: this.register,
      prefix: `${sanitizeMetricPrefix(serviceName)}_`,
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests.',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.serviceHealthStatus = new Gauge({
      name: 'service_health_status',
      help: 'Current service health status. up=2, degraded=1, down=0.',
      labelNames: ['service'],
      registers: [this.register],
    });

    this.serviceHealthStatus.set({ service: this.serviceName }, HEALTH_STATUS_VALUE.up);
    this.contentType = this.register.contentType;

    this.webhookDeliveriesTotal = new Counter({
      name: 'webhook_deliveries_total',
      help: 'Total webhook delivery attempts by outcome.',
      labelNames: ['outcome'],
      registers: [this.register],
    });

    this.webhookDlqDepth = new Gauge({
      name: 'webhook_dlq_depth',
      help: 'Current number of entries in the webhook dead-letter queue.',
      registers: [this.register],
    });
  }

  trackHttpRequest(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const route = extractRoute(req);
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };

      this.httpRequestsTotal.inc(labels);
      this.httpRequestDurationSeconds.observe(labels, duration);
    });

    next();
  }

  recordHealthStatus(status: ServiceStatus): void {
    this.serviceHealthStatus.set(
      { service: this.serviceName },
      HEALTH_STATUS_VALUE[status],
    );
  }

  recordWebhookDelivery(outcome: WebhookOutcome): void {
    this.webhookDeliveriesTotal.inc({ outcome });
  }

  setWebhookDlqDepth(depth: number): void {
    this.webhookDlqDepth.set(depth);
  }

  getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}

function sanitizeMetricPrefix(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_:]/g, '_');
  return sanitized.length > 0 ? sanitized : 'service';
}

function extractRoute(req: Request): string {
  if (req.route?.path) {
    return String(req.route.path);
  }

  return 'unmatched';
}



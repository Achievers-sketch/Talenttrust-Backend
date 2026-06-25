import { Registry } from 'prom-client';
import { MetricsService } from './metrics-service';

function makeService() {
  const register = new Registry();
  const service = new MetricsService('test', register);
  return { service, register };
}

describe('MetricsService — webhook metrics', () => {
  it('increments webhook_deliveries_total with outcome=success', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('success');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    expect(counter).toBeDefined();
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'success');
    expect(value?.value).toBe(1);
  });

  it('increments webhook_deliveries_total with outcome=failure', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('failure');
    service.recordWebhookDelivery('failure');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'failure');
    expect(value?.value).toBe(2);
  });

  it('increments webhook_deliveries_total with outcome=dlq', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('dlq');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'dlq');
    expect(value?.value).toBe(1);
  });

  it('sets webhook_dlq_depth gauge', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(3);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect(gauge).toBeDefined();
    expect((gauge!.values as any[])[0].value).toBe(3);
  });

  it('updates webhook_dlq_depth on subsequent calls', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(1);
    service.setWebhookDlqDepth(5);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect((gauge!.values as any[])[0].value).toBe(5);
  });
});

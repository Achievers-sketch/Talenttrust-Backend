import { WebhookService } from './webhook.service';
import axios from 'axios';
import { createWebhookSignature } from '../utils/webhook-signing.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../utils/webhook-signing.util');
const mockedCreateWebhookSignature = createWebhookSignature as jest.MockedFunction<typeof createWebhookSignature>;

describe('WebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('moves a repeatedly failing delivery to the DLQ after max retries (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      mockedAxios.post.mockRejectedValue(new Error('Network Error'));

      const service = new WebhookService();
      const payload = {
        id: '123',
        url: 'http://test.com',
        data: {},
        retryCount: 0,
      };

      const sendOp = service.send(payload);

      for (let i = 0; i < 20; i += 1) {
        await jest.runOnlyPendingTimersAsync();
      }

      await sendOp;

      expect(service.getDLQ().length).toBe(1);
      expect(service.getDLQ()[0].id).toBe('123');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends webhook without signature when no secret is provided', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  });

  it('sends webhook with HMAC signature when secret is provided', async () => {
    const mockSignature = 'sha256=abcdef1234567890';
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(mockedCreateWebhookSignature).toHaveBeenCalledWith(
      { event: 'test', data: {} },
      'test-secret'
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': mockSignature,
          'X-Timestamp': mockTimestamp.toString()
        }
      }
    );
  });

  it('handles webhook delivery failure with HMAC signing', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    jest.useFakeTimers();
    try {
      const sendOp = service.send(payload);

      // Run the first retry
      await jest.runOnlyPendingTimersAsync();

      await sendOp;

      expect(mockedCreateWebhookSignature).toHaveBeenCalledTimes(2); // Initial + 1 retry
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('moves webhook with HMAC signing to DLQ after max retries', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 4, // Start with 4 retries (will fail on 5th attempt)
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(service.getDLQ().length).toBe(1);
    expect(service.getDLQ()[0].id).toBe('123');
    expect(service.getDLQ()[0].webhookSecret).toBe('test-secret');
  });
});

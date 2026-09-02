// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { JaegerClient } from './client';

const validEnvelope = {
  result: {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [
          {
            scope: { name: 'scope' },
            spans: [
              {
                traceId: '0123456789abcdef0123456789abcdef',
                spanId: '0123456789abcdef',
                name: 'op',
                startTimeUnixNano: '1000000',
                endTimeUnixNano: '2000000',
                status: {},
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('JaegerClient.fetchTrace wire contract', () => {
  let client: JaegerClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    client = new JaegerClient();
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    (global as any).fetch = mockFetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    vi.useRealTimers();
  });

  it('validates and returns result.resourceSpans on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => validEnvelope });
    const promise = client.fetchTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    const data = await promise;
    expect(data.resourceSpans).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v3/traces/0123456789abcdef0123456789abcdef',
      expect.any(Object)
    );
  });

  it('also exposed as getTrace alias', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => validEnvelope });
    const promise = client.getTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    const data = await promise;
    expect(data.resourceSpans).toHaveLength(1);
  });

  it('rejects when request traceId is not 32-char hex', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => validEnvelope });
    const promise = client.fetchTrace('NOT_HEX' as any);
    vi.runAllTimers();
    await expect(promise).rejects.toThrow(z.ZodError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects when envelope is missing result', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ resourceSpans: [] }) });
    const promise = client.fetchTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    await expect(promise).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects when response contains base64 traceId', async () => {
    const bad = JSON.parse(JSON.stringify(validEnvelope));
    bad.result.resourceSpans[0].scopeSpans[0].spans[0].traceId = 'AQIDBA==';
    mockFetch.mockResolvedValue({ ok: true, json: async () => bad });
    const promise = client.fetchTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    await expect(promise).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects when timestamps are numeric instead of quoted strings', async () => {
    const bad = JSON.parse(JSON.stringify(validEnvelope));
    bad.result.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano = 1000000;
    mockFetch.mockResolvedValue({ ok: true, json: async () => bad });
    const promise = client.fetchTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    await expect(promise).rejects.toBeInstanceOf(z.ZodError);
  });

  it('throws on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) });
    const promise = client.fetchTrace('0123456789abcdef0123456789abcdef');
    vi.runAllTimers();
    await expect(promise).rejects.toThrow('Failed to fetch trace');
  });
});

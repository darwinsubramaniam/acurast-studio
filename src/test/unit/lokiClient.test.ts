import { describe, it, expect, vi, afterEach } from 'vitest';
import { LokiClient, parseFields, detectLevel } from '../../loki/lokiClient';
import type { ResolvedLokiConfig } from '../../loki/lokiConfig';

const cfg: ResolvedLokiConfig = {
  baseUrl: 'https://logs.example.com',
  configured: true,
  headers: { Accept: 'application/json' },
  jobLabel: 'job_id',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseFields', () => {
  it('parses JSON lines into string fields', () => {
    expect(parseFields('{"level":"info","msg":"hi","n":3}')).toEqual({
      level: 'info',
      msg: 'hi',
      n: '3',
    });
  });

  it('parses logfmt with at least two pairs', () => {
    expect(parseFields('level=error msg="boom happened"')).toEqual({
      level: 'error',
      msg: 'boom happened',
    });
  });

  it('returns undefined for plain prose', () => {
    expect(parseFields('just a normal log message')).toBeUndefined();
  });

  it('does not treat a single stray = as logfmt', () => {
    expect(parseFields('a=1')).toBeUndefined();
  });
});

describe('detectLevel', () => {
  it('prefers an explicit level label', () => {
    expect(detectLevel({ level: 'WARN' }, undefined, 'whatever')).toBe('warn');
  });

  it('reads the level from parsed fields', () => {
    expect(detectLevel({}, { severity: 'error' }, 'x')).toBe('error');
  });

  it('falls back to scanning the raw line', () => {
    expect(detectLevel({}, undefined, 'Fatal: cannot connect')).toBe('error');
    expect(detectLevel({}, undefined, 'a debug trace here')).toBe('debug');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectLevel({}, undefined, 'hello world')).toBe('unknown');
  });
});

describe('LokiClient.queryRange', () => {
  it('requests query_range with ns timestamps and decodes streams newest-first', async () => {
    let captured: URL | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      captured = url;
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { job_id: '42', level: 'info' },
                values: [
                  ['1700000000000000000', 'first'],
                  ['1700000000500000000', 'second'],
                ],
              },
            ],
          },
        }),
      } as unknown as Response;
    }));

    const client = new LokiClient(cfg);
    const { rows, capped } = await client.queryRange({
      query: '{job_id="42"}',
      startMs: 1700000000000,
      endMs: 1700000001000,
      limit: 100,
      direction: 'backward',
    });

    expect(rows).toHaveLength(2);
    // backward → newest first
    expect(rows[0].line).toBe('second');
    expect(rows[1].line).toBe('first');
    expect(rows[0].level).toBe('info');
    expect(rows[0].labels.job_id).toBe('42');
    expect(capped).toBe(false);
    expect(captured?.searchParams.get('start')).toBe('1700000000000000000');
    expect(captured?.searchParams.get('end')).toBe('1700000001000000000');
    expect(captured?.searchParams.get('direction')).toBe('backward');
  });

  it('flags capped results when the limit is reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [
            { stream: {}, values: [['1700000000000000000', 'only']] },
          ],
        },
      }),
    } as unknown as Response)));

    const { capped } = await new LokiClient(cfg).queryRange({
      query: '{}',
      startMs: 1,
      endMs: 2,
      limit: 1,
      direction: 'backward',
    });
    expect(capped).toBe(true);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'no token',
    } as unknown as Response)));

    await expect(
      new LokiClient(cfg).queryRange({ query: '{}', startMs: 1, endMs: 2, limit: 10, direction: 'backward' })
    ).rejects.toThrow(/401 Unauthorized: no token/);
  });

  it('rejects metric (non-stream) results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    } as unknown as Response)));

    await expect(
      new LokiClient(cfg).queryRange({ query: 'count_over_time({}[5m])', startMs: 1, endMs: 2, limit: 10, direction: 'backward' })
    ).rejects.toThrow(/matrix/);
  });
});

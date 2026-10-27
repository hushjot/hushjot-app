import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchShare, SharePausedError } from '../../src/adapters/firebase/shareRest.ts';

/**
 * A share read refused during a cost lockdown must not read as an expired
 * link (`shareRest.ts`, "Except a pause"), and asking whether it is one must
 * say nothing about the share: the probe names no id.
 */
describe('reading a share during a lockdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(share: number, sentinel: number | 'throws') {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/documents/status/lockdown')) {
          if (sentinel === 'throws') throw new TypeError('network');
          return new Response('{}', { status: sentinel });
        }
        return new Response('{}', { status: share });
      }),
    );
    return calls;
  }

  it('reports a pause when the sentinel is allowed', async () => {
    const calls = stub(403, 404);
    await expect(fetchShare('abc123')).rejects.toBeInstanceOf(SharePausedError);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('abc123');
  });

  it('is still gone when the sentinel is refused too', async () => {
    stub(403, 403);
    await expect(fetchShare('abc123')).resolves.toBeNull();
  });

  it('is still gone when the probe cannot get an answer', async () => {
    stub(403, 'throws');
    await expect(fetchShare('abc123')).resolves.toBeNull();
  });

  it('does not probe for a revoked share', async () => {
    const calls = stub(404, 404);
    await expect(fetchShare('abc123')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

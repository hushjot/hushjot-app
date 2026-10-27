import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPersisted, requestPersistence } from '../../src/core/repo/storage.ts';

function stubStorage(storage: Partial<StorageManager> | undefined): void {
  vi.stubGlobal('navigator', { storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkPersisted', () => {
  it('reports what the browser already decided', async () => {
    stubStorage({ persisted: async () => true });
    expect(await checkPersisted()).toBe('persistent');
    stubStorage({ persisted: async () => false });
    expect(await checkPersisted()).toBe('best-effort');
  });

  it('never asks, so it cannot put a prompt on screen', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => false, persist });
    await checkPersisted();
    expect(persist).not.toHaveBeenCalled();
  });

  it('treats a missing API as unavailable and a throwing one as best-effort', async () => {
    stubStorage(undefined);
    expect(await checkPersisted()).toBe('unavailable');
    stubStorage({});
    expect(await checkPersisted()).toBe('best-effort');
    stubStorage({
      persisted: async () => {
        throw new Error('denied');
      },
    });
    expect(await checkPersisted()).toBe('best-effort');
  });
});

describe('requestPersistence', () => {
  it('asks only when not already persistent', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => true, persist });
    expect(await requestPersistence()).toBe('persistent');
    expect(persist).not.toHaveBeenCalled();

    stubStorage({ persisted: async () => false, persist });
    expect(await requestPersistence()).toBe('persistent');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('reports a refusal as best-effort', async () => {
    stubStorage({ persisted: async () => false, persist: async () => false });
    expect(await requestPersistence()).toBe('best-effort');
  });
});

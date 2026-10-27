import { describe, expect, it } from 'vitest';

import { formatBytes, meterView } from '../../src/ui/storageMeter.ts';

const GiB = 1024 ** 3;
const usage = (bytes: number, quota = GiB) => ({
  bytes,
  quota,
  historyThisMonth: 0,
  sharesThisMonth: 0,
  windowStart: null,
  pushesInWindow: 0,
});

describe('the storage meter', () => {
  it('formats the way the pricing page talks', () => {
    expect(formatBytes(GiB)).toBe('1 GB');
    expect(formatBytes(11 * GiB)).toBe('11 GB');
    expect(formatBytes(312 * 1024 ** 2)).toBe('312 MB');
    expect(formatBytes(1.5 * 1024 ** 2)).toBe('1.5 MB');
    expect(formatBytes(900)).toBe('900 bytes');
  });

  it('speaks up at 80% and again at 95%', () => {
    expect(meterView(usage(0.5 * GiB)).level).toBe('ok');
    expect(meterView(usage(0.8 * GiB)).level).toBe('warn');
    expect(meterView(usage(0.95 * GiB)).level).toBe('full');
    expect(meterView(usage(312 * 1024 ** 2))).toEqual({ label: '312 MB of 1 GB', percent: 30, level: 'ok' });
  });

  it('keeps the bar in range when an account is over, after lowering its plan', () => {
    expect(meterView(usage(2 * GiB))).toMatchObject({ percent: 100, level: 'full' });
    expect(meterView(usage(-5))).toMatchObject({ percent: 0, label: '0 bytes of 1 GB' });
  });
});

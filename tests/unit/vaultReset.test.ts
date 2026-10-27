import { describe, it, expect } from 'vitest';
import {
  failureFromAuthError,
  failureFromResponse,
} from '../../src/adapters/firebase/vaultReset.ts';

/**
 * What the "start over" dialog tells a user, from what Firebase Auth and the
 * billing API said. The dialog's copy promises different things per answer —
 * "try again finishes the job" is only true of the ones that are safe to
 * repeat — so the mapping is pinned.
 */
describe('failureFromAuthError', () => {
  it('reads every wrong-password spelling as a wrong password', () => {
    for (const code of [
      'auth/wrong-password',
      'auth/invalid-credential',
      'auth/invalid-login-credentials',
      'auth/missing-password',
    ]) {
      expect(failureFromAuthError({ code })).toBe('wrong-password');
    }
  });

  it('separates throttling, network and a dead session', () => {
    expect(failureFromAuthError({ code: 'auth/too-many-requests' })).toBe('rate-limited');
    expect(failureFromAuthError({ code: 'auth/network-request-failed' })).toBe('unreachable');
    expect(failureFromAuthError({ code: 'auth/user-token-expired' })).toBe('signed-out');
    expect(failureFromAuthError({ code: 'auth/user-mismatch' })).toBe('signed-out');
  });

  it('calls anything else a failure', () => {
    expect(failureFromAuthError({ code: 'auth/internal-error' })).toBe('failed');
    expect(failureFromAuthError(new Error('boom'))).toBe('failed');
    expect(failureFromAuthError(null)).toBe('failed');
  });
});

describe('failureFromResponse', () => {
  it('is null for success', () => {
    expect(failureFromResponse(200, { ok: true, deleted: 12 })).toBeNull();
  });

  it('reads a stale sign-in by its code, whatever the status', () => {
    expect(failureFromResponse(409, { ok: false, error: 'reauth_required' })).toBe('reauth-required');
  });

  it('reads 401 as signed out', () => {
    expect(failureFromResponse(401, { ok: false, error: 'invalid_token' })).toBe('signed-out');
  });

  it('reads a part-way failure and a gateway as retryable', () => {
    expect(failureFromResponse(502, { ok: false, error: 'reset_incomplete' })).toBe('unreachable');
    expect(failureFromResponse(503, null)).toBe('unreachable');
    expect(failureFromResponse(504, null)).toBe('unreachable');
  });

  it('calls a refusal a failure', () => {
    expect(failureFromResponse(400, { ok: false, error: 'not_confirmed' })).toBe('failed');
    expect(failureFromResponse(500, null)).toBe('failed');
  });
});

import { describe, expect, it } from 'vitest';
import { INSTALL_STEPS, installHint, isIosLike, type InstallEnvironment } from '../../src/ui/install.ts';

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  iosFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

function env(overrides: Partial<InstallEnvironment>): InstallEnvironment {
  return { userAgent: UA.windowsChrome, maxTouchPoints: 0, canPrompt: false, installed: false, ...overrides };
}

describe('installHint', () => {
  it.each([
    ['a held install event', env({ canPrompt: true }), 'prompt'],
    ['an iPhone', env({ userAgent: UA.iphone, maxTouchPoints: 5 }), 'ios'],
    ['an iPad that claims to be a Mac', env({ userAgent: UA.macSafari, maxTouchPoints: 5 }), 'ios'],
    ['Safari on a Mac', env({ userAgent: UA.macSafari }), 'mac-safari'],
    ['Chrome on a Mac with no event yet', env({ userAgent: UA.macChrome }), null],
    // Firefox cannot install on any desktop, and prompts for durable storage
    // on all of them — a different action, which is why it is not null.
    ['Firefox on a Mac', env({ userAgent: UA.macFirefox }), 'firefox'],
    ['Firefox on Windows', env({ userAgent: UA.windowsFirefox }), 'firefox'],
    ['Firefox on Linux', env({ userAgent: UA.linuxFirefox }), 'firefox'],
    // Firefox on iOS is WebKit, so it has the share sheet and not the prompt.
    ['Firefox on an iPhone', env({ userAgent: UA.iosFirefox, maxTouchPoints: 5 }), 'ios'],
    ['Chrome on Windows with no event', env({}), null],
  ])('%s', (_, input, expected) => {
    expect(installHint(input)).toBe(expected);
  });

  it('offers nothing once installed, even with an event held', () => {
    expect(installHint(env({ canPrompt: true, installed: true }))).toBeNull();
    expect(installHint(env({ userAgent: UA.iphone, maxTouchPoints: 5, installed: true }))).toBeNull();
    // Firefox reports `display-mode: standalone` for a window opened from a
    // shortcut, and there is nothing left to offer it either way.
    expect(installHint(env({ userAgent: UA.macFirefox, installed: true }))).toBeNull();
  });

  it('has directions for every hint that is not the browser’s own dialog', () => {
    for (const hint of ['ios', 'mac-safari', 'firefox'] as const) {
      expect(INSTALL_STEPS[hint], hint).toBeTruthy();
    }
  });
});

// Quick capture asks the same question for a different reason, and unlike the
// hint it must still answer it once the app is installed.
describe('isIosLike', () => {
  it.each([
    ['an iPhone', UA.iphone, 5, true],
    ['an iPad claiming to be a Mac', UA.macSafari, 5, true],
    ['a real Mac', UA.macSafari, 0, false],
    ['Windows', UA.windowsChrome, 0, false],
  ])('%s', (_, ua, touch, expected) => {
    expect(isIosLike(ua, touch)).toBe(expected);
  });
});

/**
 * Light/dark mode, the top-bar toggle.
 *
 * The palette lives in `index.html` as custom properties, keyed by a
 * `data-theme` attribute on the root element, so every component and every
 * CodeMirror view — mounted or cached — switches with one attribute write and
 * no re-render, exactly as the text-size variable does.
 *
 * There is no inline script to set the attribute before first paint: the CSP
 * keeps `script-src` strict. The store applies at module init instead, which is
 * before the app mounts, so at worst the pre-hydration skeleton shows the
 * system palette for a frame.
 *
 * A per-device preference, not data: localStorage, not the encrypted repository.
 */
import { nextOverride, normalizeTheme, themeStatus, type Theme, type ThemeStatus } from '../theme.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const STORAGE_KEY = 'teksto:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Must match `--bg` in `index.html`, so the browser chrome matches the page. */
const THEME_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#16181a' };

function read(): Theme | null {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked: follow the system, and the choice lasts this session only.
    return null;
  }
}

function write(theme: Theme | null): void {
  try {
    if (theme === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // As above.
  }
}

/**
 * The `theme-color` metas carry `media` attributes that follow the OS. With an
 * override, both are pointed at the chosen colour; without one, each goes back
 * to its own palette.
 */
function apply(override: Theme | null): void {
  const root = document.documentElement;
  if (override === null) delete root.dataset.theme;
  else root.dataset.theme = override;

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Theme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = THEME_COLOR[override ?? own];
  }
}

class ThemeStore {
  #override = $state<Theme | null>(read());
  #system = $state<Theme>('light');

  constructor() {
    const mql = window.matchMedia(DARK_QUERY);
    this.#system = mql.matches ? 'dark' : 'light';
    // Module-level and never removed: the store lives as long as the page.
    mql.addEventListener('change', (event) => {
      this.#system = event.matches ? 'dark' : 'light';
    });
    apply(this.#override);
  }

  get effective(): Theme {
    return this.#override ?? this.#system;
  }

  /** A choice is stored for this device rather than the OS being followed. */
  get pinned(): boolean {
    return this.#override !== null;
  }

  /** The toggle's wording, so `App.svelte` holds none of it. */
  get status(): ThemeStatus {
    return themeStatus(this.#override, this.#system);
  }

  toggle(): void {
    this.#set(nextOverride(this.effective, this.#system));
  }

  /**
   * Go back to the OS, whatever it currently says.
   *
   * The toggle reaches this state too — one tap, whenever the OS and the
   * override agree on what a flip would show — but only from one side of it,
   * and never by name. This is the same state asked for rather than arrived
   * at, which is why `theme-system` is offered only while `pinned`.
   */
  followSystem(): void {
    this.#set(null);
  }

  #set(override: Theme | null): void {
    this.#override = override;
    apply(override);
    write(override);
  }
}

export const theme = new ThemeStore();

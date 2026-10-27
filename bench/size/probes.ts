/**
 * Keeps the deferred subsystems reachable at runtime so Rollup emits them as
 * real lazy chunks instead of tree-shaking them away. Without this the size
 * measurement would flatter the design by simply deleting the code it was
 * supposed to be splitting off.
 */
import type { EditorView } from '@codemirror/view';

export function registerLazyProbes(view: EditorView): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g.__loadCrypto = () => import('../../bench/lib/crypto.ts');
  g.__loadKdf = () => import('hash-wasm');
  g.__loadFirebase = async () => {
    // Stand-in for the Firebase adapter chunk: it must never be on the
    // critical path (§7). Kept as a comment rather than a real import until
    // Phase 4 installs the SDK.
    return null;
  };
  g.__view = view;
}

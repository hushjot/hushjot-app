/** Encryption worker — the debounced save path. Never touches the typing path. */
import { importDek, encryptEnvelope, type Bytes } from '../lib/crypto.ts';

let key: CryptoKey | undefined;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as
    | { type: 'init'; key: Bytes }
    | { type: 'encrypt'; id: number; text: string };

  if (msg.type === 'init') {
    key = await importDek(msg.key, false);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'encrypt') {
    if (!key) throw new Error('worker not initialised');
    const cipher = await encryptEnvelope(key, msg.text);
    // Transfer the buffer rather than copying it.
    self.postMessage({ type: 'encrypted', id: msg.id, cipher }, [cipher.buffer]);
  }
};

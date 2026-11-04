import { app } from 'electron';
import { describeSecretBackend, getSafeStorage, osDecryptSecrets, osEncryptSecrets } from '../src/config/keychain.js';

app.whenReady().then(() => {
  try {
    const backend = getSafeStorage();
    if (!backend) throw new Error('Electron safeStorage is unavailable.');
    const sample = 'BlackHole keychain integration check';
    if (osDecryptSecrets(osEncryptSecrets(sample, backend), backend) !== sample) {
      throw new Error('Electron safeStorage round-trip failed.');
    }
    console.log(JSON.stringify({ ok: true, backend: describeSecretBackend() }));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    app.exit(1);
  }
});

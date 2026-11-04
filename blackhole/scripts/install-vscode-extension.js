import { installVSCodeExtension } from '../src/ide/vscodeExtensionInstaller.js';

try {
  const result = await installVSCodeExtension({ ideExecutablePath: process.argv[2] || '' });
  console.log(JSON.stringify({
    ok: true,
    ...result
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}

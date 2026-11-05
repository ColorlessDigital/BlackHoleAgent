import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runTerminalCommand } from './terminalBroker.js';

describe('terminalBroker', () => {
  test('verification child environment overrides do not mutate the parent environment', async () => {
    const before = process.env.NODE_TEST_CONTEXT;
    const result = await runTerminalCommand(`"${process.execPath}" -p "String(process.env.BLACKHOLE_VERIFICATION_TEST) + ':' + String(process.env.NODE_TEST_CONTEXT)"`, {
      timeout: 5000, env: { BLACKHOLE_VERIFICATION_TEST: 'isolated', NODE_TEST_CONTEXT: undefined }
    });
    assert.strictEqual(result.code, 0);
    assert.match(result.output, /isolated:undefined/);
    assert.strictEqual(process.env.NODE_TEST_CONTEXT, before);
    assert.strictEqual(process.env.BLACKHOLE_VERIFICATION_TEST, undefined);
  });

  test('runTerminalCommand - stops a running process on cancellation', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const res = await runTerminalCommand(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, {
        abortSignal: controller.signal,
        timeout: 5000
      });
      assert.strictEqual(res.aborted, true);
      assert.strictEqual(res.code, -2);
      assert.match(res.output, /Stopped by user/);
    } finally {
      clearTimeout(timer);
    }
  });

  test('runTerminalCommand - should execute basic command successfully', async () => {
    const res = await runTerminalCommand('echo BlackHoleAgentTest', { timeout: 5000 });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.output.includes('BlackHoleAgentTest'), true);
  });

  test('runTerminalCommand - should trigger timeout safety mechanism', async () => {
    console.log('Testing terminal timeout (expect safety termination)...');
    const nodeBin = process.execPath;
    const res = await runTerminalCommand(`"${nodeBin}" -e "setInterval(() => {}, 1000)"`, { timeout: 400 });
    assert.strictEqual(res.code, -2); // -2 is killedDueToSafety exit code
    assert.strictEqual(res.output.includes('timed out'), true);
  });

  test('runTerminalCommand - should trigger buffer limit safety mechanism', async () => {
    // 100글자씩 출력하고 maxBuffer를 20바이트로 주어 한도 초과 트리거
    console.log('Testing terminal buffer limit (expect safety termination)...');
    const res = await runTerminalCommand('echo 123456789012345678901234567890', { maxBuffer: 20 });
    assert.strictEqual(res.code, -2);
    assert.strictEqual(res.output.includes('Buffer limit exceeded'), true);
  });
});

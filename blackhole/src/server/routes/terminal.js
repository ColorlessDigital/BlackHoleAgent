import express from 'express';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import { loadConfig } from '../../config/configStore.js';

export function createTerminalRouter() {
  const router = express.Router();
  const executor = new CapabilityExecutor({ getConfig: loadConfig });

  router.post('/terminal/run', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const result = await executor.execute(
      'run_command',
      { command: req.body.command || req.body.cmd, cwd: req.body.cwd },
      {
        actor: 'ui',
        onOutput: (log) => send({ type: 'output', log })
      }
    );
    send({ type: 'end', result });
    res.end();
  });

  return router;
}

import { randomInt } from 'node:crypto';

// Windows may allocate port 0 inside fetch's forbidden low-port range.
export async function listenLoopback(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.off('error', failed); server.off('listening', ready); };
        const failed = error => { cleanup(); reject(error); };
        const ready = () => { cleanup(); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        try { server.listen(randomInt(49152, 65536), '127.0.0.1'); }
        catch (error) { failed(error); }
      });
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === 19) throw error;
    }
  }
}

import { startApiServer } from './apiGateway.js';

const api = await startApiServer({ port: Number(process.env.BLACKHOLE_PORT || 3003) });
console.log(`BlackHole NEW API running at ${api.baseUrl}`);
console.log(`Bootstrap token endpoint: ${api.baseUrl}/api/bootstrap`);

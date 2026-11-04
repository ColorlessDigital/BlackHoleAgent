import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

export function emitLog(message, level = 'info', meta = {}) {
  eventBus.emit('log', {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    meta
  });
}

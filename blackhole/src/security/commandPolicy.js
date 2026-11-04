import { RiskLevel } from './riskLevels.js';

const BLOCK_PATTERNS = [
  /\bformat\b/i,
  /\brmdir\s+\/s\b/i,
  /\brd\s+\/s\b/i,
  /\bdel\s+\/s\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bshutdown\b/i,
  /\bnet\s+user\b/i,
  /\btaskkill\b.*\b(lsass|svchost|wininit|csrss|services)\.exe\b/i,
  /\brm\s+-rf\s+\/\b/i,
  /\bsudo\s+rm\s+-rf\s+\/\b/i
];

const WARNING_PATTERNS = [
  /\bnpm\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bgit\s+clone\b/i,
  /\bpowershell\b/i,
  /\bcmd(?:\.exe)?\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bcertutil\b/i,
  /\breg\s+add\b/i,
  /\bsc\s+(create|start|stop|config)\b/i,
  /\bnet\s+(start|stop)\b/i,
  /\bsetx\b/i,
  /\btaskkill\b/i
];

export function evaluateCommandPolicy(command) {
  if (!command || typeof command !== 'string') {
    return { level: RiskLevel.BLOCKED, reason: 'Command is empty.' };
  }

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(command)) {
      return {
        level: RiskLevel.BLOCKED,
        reason: `Command matched an explicit-approval OS-level pattern: ${pattern}`
      };
    }
  }

  for (const pattern of WARNING_PATTERNS) {
    if (pattern.test(command)) {
      return {
        level: RiskLevel.WARNING,
        reason: `Command matched a confirmation pattern: ${pattern}`
      };
    }
  }

  return { level: RiskLevel.SAFE, reason: '' };
}

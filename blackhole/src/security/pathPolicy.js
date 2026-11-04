import path from 'path';
import { normalizeForPolicy } from '../common/paths.js';
import { RiskLevel } from './riskLevels.js';

const CRITICAL_PATHS = [
  'c:/windows',
  'c:/windows/system32',
  'c:/recovery',
  'c:/$recycle.bin',
  'd:/$recycle.bin',
  'c:/system volume information',
  'd:/system volume information'
];

const WARNING_SEGMENTS = [
  '/appdata/',
  '/temp/',
  '/program files/',
  '/program files (x86)/',
  '/users/public/'
];

const EXECUTABLE_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.exe',
  '.dll',
  '.scr',
  '.msi',
  '.reg'
]);

export function evaluatePathPolicy(targetPath, config = {}, action = 'read_file') {
  if (!targetPath || typeof targetPath !== 'string') {
    return { level: RiskLevel.BLOCKED, reason: 'Target path is empty or invalid.' };
  }

  const normalized = normalizeForPolicy(targetPath);
  for (const blocked of CRITICAL_PATHS) {
    if (normalized === blocked || normalized.startsWith(`${blocked}/`)) {
      return {
        level: RiskLevel.BLOCKED,
        reason: `Target path requires explicit approval: ${targetPath}`
      };
    }
  }

  const driveMatch = normalized.match(/^([a-z]):\//);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const allowedDrives = config.allowedDrives || [];
    if (allowedDrives.length > 0 && !allowedDrives.includes(drive)) {
      return {
        level: RiskLevel.WARNING,
        reason: `Drive is not listed in allowedDrives: ${drive}:`
      };
    }
  }

  if (action !== 'read_file' && action !== 'list_dir') {
    const ext = path.extname(normalized);
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      return {
        level: RiskLevel.WARNING,
        reason: `Target file extension can affect executable behavior: ${ext}`
      };
    }
  }

  for (const segment of WARNING_SEGMENTS) {
    if (normalized.includes(segment)) {
      return {
        level: action === 'read_file' || action === 'list_dir' ? RiskLevel.SAFE : RiskLevel.WARNING,
        reason: `Target path is in a sensitive user/application directory: ${segment}`
      };
    }
  }

  return { level: RiskLevel.SAFE, reason: '' };
}

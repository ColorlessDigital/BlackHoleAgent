import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { evaluateCapability } from '../security/policyEngine.js';
import {
  buildMcpToolName,
  loadMcpConfig,
  parseMcpToolName,
  resolveMcpPermission
} from './mcpConfig.js';

test('mcpConfig should load .blackhole/mcp.json and resolve permissions', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-json-'));
  fs.mkdirSync(path.join(workspaceRoot, '.blackhole'));
  fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'mcp.json'), JSON.stringify({
    enabled: true,
    defaultPermission: 'ask',
    servers: {
      fake: {
        enabled: true,
        command: 'node',
        framing: 'content-length',
        args: ['fake.js']
      }
    },
    permissions: {
      'fake/read': 'allow',
      'fake/write': 'block'
    }
  }), 'utf8');

  const config = loadMcpConfig({ workspaceRoot });
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.servers.fake.enabled, true);
  assert.strictEqual(config.servers.fake.command, 'node');
  assert.strictEqual(config.servers.fake.framing, 'content-length');
  assert.strictEqual(resolveMcpPermission({ serverName: 'fake', toolName: 'read' }, config), 'allow');
  assert.strictEqual(resolveMcpPermission({ serverName: 'fake', toolName: 'write' }, config), 'block');
  assert.strictEqual(resolveMcpPermission({ serverName: 'fake', toolName: 'other' }, config), 'ask');
});

test('mcpConfig should keep default server command when workspace only enables template', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-template-'));
  fs.mkdirSync(path.join(workspaceRoot, '.blackhole'));
  fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'mcp.json'), JSON.stringify({
    servers: {
      context7: {
        enabled: true
      }
    }
  }), 'utf8');

  const config = loadMcpConfig({ workspaceRoot });
  assert.strictEqual(config.servers.context7.enabled, true);
  assert.strictEqual(config.servers.context7.command, 'npx');
  assert.deepStrictEqual(config.servers.context7.args, ['-y', '@upstash/context7-mcp']);
});

test('mcpConfig should load mcp block from .blackhole/config.yaml', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-yaml-'));
  fs.mkdirSync(path.join(workspaceRoot, '.blackhole'));
  fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'config.yaml'), [
    'mcp:',
    '  enabled: true',
    '  defaultPermission: allow',
    '  servers:',
    '    docs:',
    '      enabled: true',
    '      command: npx',
    '      args:',
    '        - -y',
    '        - "@upstash/context7-mcp"',
    '  permissions:',
    '    docs/*: allow'
  ].join('\n'), 'utf8');

  const config = loadMcpConfig({ workspaceRoot });
  assert.strictEqual(config.defaultPermission, 'allow');
  assert.strictEqual(config.servers.docs.enabled, true);
  assert.deepStrictEqual(config.servers.docs.args, ['-y', '@upstash/context7-mcp']);
  assert.strictEqual(resolveMcpPermission({ serverName: 'docs', toolName: 'lookup' }, config), 'allow');
});

test('mcp proxy names should parse and preserve tool suffix', () => {
  const proxy = buildMcpToolName('context7', 'resolve-library-id');
  assert.strictEqual(proxy, 'mcp__context7__resolve-library-id');
  assert.deepStrictEqual(parseMcpToolName(proxy), {
    serverName: 'context7',
    toolName: 'resolve-library-id'
  });
});

test('MCP ask permission should require approval even in autonomous mode', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-policy-'));
  fs.mkdirSync(path.join(workspaceRoot, '.blackhole'));
  fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'mcp.json'), JSON.stringify({
    enabled: true,
    permissions: {
      'fake/*': 'ask'
    }
  }), 'utf8');

  const policy = evaluateCapability({
    capability: 'mcp__fake__danger',
    params: {}
  }, {
    permissionMode: 'autonomous',
    workspaceRoot
  });

  assert.strictEqual(policy.level, 'WARNING');
  assert.strictEqual(policy.requiresApproval, true);
});

test('policy engine should downgrade former hard blocks to approval requests', () => {
  const commandPolicy = evaluateCapability({
    capability: 'run_command',
    params: { command: 'format C:' }
  }, {
    permissionMode: 'autonomous'
  });

  assert.strictEqual(commandPolicy.level, 'WARNING');
  assert.strictEqual(commandPolicy.requiresApproval, true);

  const pathPolicy = evaluateCapability({
    capability: 'write_file',
    params: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', content: '127.0.0.1 example.test' }
  }, {
    permissionMode: 'autonomous'
  });

  assert.strictEqual(pathPolicy.level, 'WARNING');
  assert.strictEqual(pathPolicy.requiresApproval, true);
});

test('MCP block permission should request approval instead of hard blocking', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-no-hard-block-'));
  fs.mkdirSync(path.join(workspaceRoot, '.blackhole'));
  fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'mcp.json'), JSON.stringify({
    enabled: true,
    permissions: {
      'fake/*': 'block'
    }
  }), 'utf8');

  const policy = evaluateCapability({
    capability: 'mcp__fake__danger',
    params: {}
  }, {
    permissionMode: 'autonomous',
    workspaceRoot
  });

  assert.strictEqual(policy.level, 'WARNING');
  assert.strictEqual(policy.requiresApproval, true);
});

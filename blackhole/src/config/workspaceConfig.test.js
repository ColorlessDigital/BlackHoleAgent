import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyWorkspaceStandardToConfig,
  loadWorkspaceStandardConfig,
  parseRuleDirectives,
  stripWorkspaceDerivedConfig
} from './workspaceConfig.js';

test('workspaceConfig should load config, models, prompts, and rules', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-workspace-standard-'));
  try {
    writeWorkspaceStandard(workspaceRoot);
    const standard = loadWorkspaceStandardConfig({ workspaceRoot });

    assert.strictEqual(standard.enabled, true);
    assert.strictEqual(standard.profile, 'autonomous-coder');
    assert.strictEqual(standard.rules.length, 2);
    assert.strictEqual(standard.prompts.length, 2);
    assert.strictEqual(standard.modelProfile.contextLimit, 12288);
    assert.ok(standard.promptSection.includes('[Workspace Agent Profile]'));
    assert.ok(standard.promptSection.includes('Use small focused patches'));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspaceConfig should merge model profile overlay into runtime config', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-workspace-merge-'));
  try {
    writeWorkspaceStandard(workspaceRoot);
    const merged = applyWorkspaceStandardToConfig({
      workspaceRoot,
      activeModel: 'llamacpp:local-gguf',
      systemInstruction: 'Base system',
      agentModelProfiles: {
        coder: {
          model: '',
          contextLimit: 8192,
          maxTokens: 4096,
          temperature: 0.2
        }
      }
    });

    assert.strictEqual(merged.contextLimit, 12288);
    assert.strictEqual(merged.agentModelProfiles.coder.temperature, 0.12);
    assert.ok(merged.systemInstruction.includes('Base system'));
    assert.ok(merged.systemInstruction.includes('[Workspace Coding Rules]'));
    assert.strictEqual(merged.workspaceStandard.profile, 'autonomous-coder');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace Go model overlay updates runtime identity without importing a workspace key', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-go-workspace-'));
  try {
    writeWorkspaceStandard(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, '.blackhole', 'models.yaml'), [
      'profiles:', '  autonomous-coder:', '    activeModel: opencode-go:glm-5.3-flash',
      '    opencodeGoEnabled: true', '    opencodeGoApiKey: workspace-key-must-not-override'
    ].join('\n'));
    const merged = applyWorkspaceStandardToConfig({ workspaceRoot, localRuntime: 'llamacpp', opencodeGoApiKey: 'separate-key' });
    assert.strictEqual(merged.localRuntime, 'opencode-go');
    assert.strictEqual(merged.opencodeGoEnabled, true);
    assert.strictEqual(merged.opencodeGoApiKey, 'separate-key');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspaceConfig should strip derived prompt sections before persistence', () => {
  const clean = stripWorkspaceDerivedConfig({
    systemInstruction: 'Base\n\n[Workspace Agent Profile]\nProfile: test',
    workspaceStandard: { enabled: true },
    temperature: 0.1
  });

  assert.deepStrictEqual(clean, {
    systemInstruction: 'Base',
    temperature: 0.1
  });
});

test('parseRuleDirectives should extract machine-readable markdown directives', () => {
  const conflictStart = '<'.repeat(7);
  const directives = parseRuleDirectives([
    '# Rule',
    '- require-file: package.json',
    `- forbid-text: "${conflictStart}"`,
    '- require-script: test'
  ].join('\n'));

  assert.deepStrictEqual(directives, [
    { type: 'require-file', value: 'package.json' },
    { type: 'forbid-text', value: conflictStart },
    { type: 'require-script', value: 'test' }
  ]);
});

function writeWorkspaceStandard(workspaceRoot) {
  const blackholeDir = path.join(workspaceRoot, '.blackhole');
  fs.mkdirSync(path.join(blackholeDir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(blackholeDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(blackholeDir, 'config.yaml'), [
    'version: 1',
    'workspace:',
    '  name: Temp Project',
    '  agentProfile: autonomous-coder',
    '  codingStandard: default',
    'agent:',
    '  profile: autonomous-coder',
    '  prompts: ["prompts/system.md", "prompts/agent.md"]',
    '  rules: ["rules/coding-standard.md", "rules/pr-check.md"]',
    'models:',
    '  file: models.yaml'
  ].join('\n'));
  fs.writeFileSync(path.join(blackholeDir, 'models.yaml'), [
    'profiles:',
    '  autonomous-coder:',
    '    activeModel: llamacpp:local-gguf',
    '    contextLimit: 12288',
    '    maxTokens: 4096',
    '    temperature: 0.18',
    '    agentModelProfiles:',
    '      coder:',
    '        temperature: 0.12',
    '        maxTokens: 4096'
  ].join('\n'));
  fs.writeFileSync(path.join(blackholeDir, 'prompts', 'system.md'), '# System Prompt\nUse small focused patches.');
  fs.writeFileSync(path.join(blackholeDir, 'prompts', 'agent.md'), '# Agent Prompt\nPlan, act, verify.');
  fs.writeFileSync(path.join(blackholeDir, 'rules', 'coding-standard.md'), '# Coding Standard\n- require-file: package.json');
  fs.writeFileSync(path.join(blackholeDir, 'rules', 'pr-check.md'), '# PR Check\n- require-script: test');
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
}

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  parseToolCall,
  parseAllToolCalls,
  stripToolCallMarkup,
  detectMalformedToolCall,
  buildToolCorrectionPrompt
} from './toolParser.js';

test('XML ranged reads retain both bounds instead of silently reading the whole file', () => {
  const call = parseToolCall('<read_file lineCount="20" path="lib/argument.js" startLine="70" />');
  assert.deepStrictEqual(call, { tool: 'read_file', params: { path: 'lib/argument.js', startLine: 70, lineCount: 20 } });
  assert.deepStrictEqual(parseToolCall("<read_file path='file.js' startLine='0' lineCount='201'/>").params,
    { path: 'file.js', startLine: 0, lineCount: 201 });
  assert.equal(parseToolCall('<read_file path="file.js" startLine="-1"/>').params.startLine, -1);
  assert.ok(Number.isNaN(parseToolCall('<read_file path="file.js" lineCount="invalid"/>').params.lineCount));
  assert.equal(stripToolCallMarkup('<read_file path="file.js" startLine="10" lineCount="2"/>'), '');
});

test('mutation and command correction examples are executable tool shapes with required arguments', () => {
  for (const tool of ['patch_file', 'patch_lines', 'run_command']) {
    const prompt = buildToolCorrectionPrompt({ tool, reason: 'fixture malformed call' });
    const example = prompt.slice(prompt.indexOf('Example:\n') + 'Example:\n'.length);
    const parsed = parseAllToolCalls(example);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].tool, tool);
    if (tool === 'patch_file') assert.deepStrictEqual(parsed[0].params,
      { path: 'path/to/file.js', search: 'old code', replace: 'new code' });
    if (tool === 'patch_lines') assert.deepStrictEqual(parsed[0].params,
      { path: 'path/to/file.js', startLine: 1, endLine: 2, replacement: 'replacement code' });
    if (tool === 'run_command') assert.equal(parsed[0].params.command, 'echo example');
    assert.equal(detectMalformedToolCall(example), null);
  }
});

test('toolParser - parseToolCall', async (t) => {
  await t.test('should return null for invalid or empty content', () => {
    assert.strictEqual(parseToolCall(''), null);
    assert.strictEqual(parseToolCall(null), null);
    assert.strictEqual(parseToolCall('hello world without tags'), null);
  });

  await t.test('should parse list_dir with single or double quotes', () => {
    const res1 = parseToolCall('<list_dir path="d:\\workspace" />');
    assert.deepStrictEqual(res1, { tool: 'list_dir', params: { path: 'd:\\workspace' } });

    const res2 = parseToolCall("<list_dir path='d:\\workspace'/>");
    assert.deepStrictEqual(res2, { tool: 'list_dir', params: { path: 'd:\\workspace' } });
  });

  await t.test('should parse run_command with cmd or command attributes', () => {
    const res1 = parseToolCall('<run_command cmd="npm run test" />');
    assert.deepStrictEqual(res1, { tool: 'run_command', params: { command: 'npm run test' } });

    const res2 = parseToolCall('<run_command command="node index.js" />');
    assert.deepStrictEqual(res2, { tool: 'run_command', params: { command: 'node index.js' } });

    const res3 = parseToolCall('<run_command command="node index.js" cwd="frontend" />');
    assert.deepStrictEqual(res3, { tool: 'run_command', params: { command: 'node index.js', cwd: 'frontend' } });
  });

  await t.test('should parse write_file with multi-line content', () => {
    const content = `
    const x = 10;
    console.log(x);
    `;
    const res = parseToolCall(`<write_file path="src/index.js">${content}</write_file>`);
    assert.deepStrictEqual(res, {
      tool: 'write_file',
      params: { path: 'src/index.js', content }
    });
  });

  await t.test('should parse patch_file with search and replace blocks', () => {
    const res = parseToolCall(`
      <patch_file path="src/index.js">
        <search>oldCode();</search>
        <replace>newCode();</replace>
      </patch_file>
    `);
    assert.deepStrictEqual(res, {
      tool: 'patch_file',
      params: {
        path: 'src/index.js',
        search: 'oldCode();',
        replace: 'newCode();'
      }
    });
  });

  await t.test('should prioritize the first tool by index when multiple tools are present', () => {
    const content = `
      Some analysis here...
      <read_file path="d:\\first.js" />
      Then we write:
      <write_file path="d:\\second.js">data</write_file>
    `;
    const res = parseToolCall(content);
    // read_file comes first in the text, so it should be prioritized
    assert.deepStrictEqual(res, {
      tool: 'read_file',
      params: { path: 'd:\\first.js' }
    });
  });
});

test('toolParser - parseAllToolCalls', async (t) => {
  await t.test('should parse multiple tool calls in sequence of appearance', () => {
    const content = `
      Let's scan directory:
      <list_dir path="D:\\workspace" />
      Then we read a file:
      <read_file path="D:\\workspace\\index.js" />
      And execute a command:
      <run_command command="npm test" />
    `;
    const res = parseAllToolCalls(content);
    assert.strictEqual(res.length, 3);
    assert.deepStrictEqual(res[0], { tool: 'list_dir', params: { path: 'D:\\workspace' } });
    assert.deepStrictEqual(res[1], { tool: 'read_file', params: { path: 'D:\\workspace\\index.js' } });
    assert.deepStrictEqual(res[2], { tool: 'run_command', params: { command: 'npm test' } });
  });

  await t.test('should return empty array when no tools match', () => {
    assert.deepStrictEqual(parseAllToolCalls('hello world without tool calls'), []);
    assert.deepStrictEqual(parseAllToolCalls(''), []);
  });
});

test('toolParser - JSON tool calls', async (t) => {
  await t.test('should parse a single JSON tool call', () => {
    const res = parseToolCall('{"tool":"read_file","params":{"path":"src/index.js"}}');
    assert.deepStrictEqual(res, {
      tool: 'read_file',
      params: { path: 'src/index.js' }
    });
  });

  await t.test('should parse JSON tool_calls arrays', () => {
    const res = parseAllToolCalls(`
      {"tool_calls":[
        {"tool":"read_file","params":{"path":"src/a.js"}},
        {"tool":"run_command","params":{"command":"node --test"}}
      ]}
    `);
    assert.strictEqual(res.length, 2);
    assert.deepStrictEqual(res[0], { tool: 'read_file', params: { path: 'src/a.js' } });
    assert.deepStrictEqual(res[1], { tool: 'run_command', params: { command: 'node --test' } });
  });

  await t.test('should parse OpenAI function-style JSON arguments', () => {
    const res = parseToolCall(JSON.stringify({
      function: {
        name: 'patch_lines',
        arguments: JSON.stringify({
          path: 'src/a.js',
          startLine: 2,
          endLine: 3,
          replacement: 'const ok = true;'
        })
      }
    }));

    assert.deepStrictEqual(res, {
      tool: 'patch_lines',
      params: {
        path: 'src/a.js',
        startLine: 2,
        endLine: 3,
        replacement: 'const ok = true;'
      }
    });
  });

  await t.test('should parse resilient JSON with trailing commas and unquoted/single-quoted keys', () => {
    // Malformed JSON common in local SLMs: single quotes and trailing comma
    const malformed = `
\`\`\`json
{
  'tool': 'read_file',
  'params': {
    'path': 'src/index.js',
  }
}
\`\`\`
`;
    const res = parseToolCall(malformed);
    assert.deepStrictEqual(res, {
      tool: 'read_file',
      params: {
        path: 'src/index.js'
      }
    });
  });

  await t.test('should strip JSON and XML tool calls from visible text', () => {
    const text = stripToolCallMarkup(`
      Plan: inspect files
      {"tool_calls":[{"tool":"read_file","params":{"path":"src/a.js"}}]}
      <run_command command="node --test" />
      Done.
    `);

    assert.doesNotMatch(text, /tool_calls/);
    assert.doesNotMatch(text, /run_command/);
    assert.match(text, /Plan: inspect files/);
    assert.match(text, /Done\./);
  });
});

test('useChatState contract - should return required actions', () => {
  const filePath = path.join(process.cwd(), 'frontend', 'src', 'hooks', 'useChatState.js');
  if (fs.existsSync(filePath)) {
    const code = fs.readFileSync(filePath, 'utf-8');
    assert.ok(code.includes('handleSendMessage'), 'useChatState must return handleSendMessage');
    assert.ok(code.includes('handleStopGeneration'), 'useChatState must return handleStopGeneration');
    assert.ok(code.includes('handleRespondSecurity'), 'useChatState must return handleRespondSecurity');
  }
});

test('toolParser - web_search with provider', async (t) => {
  await t.test('should parse web_search with query and optional provider', () => {
    const res = parseToolCall('<web_search query="Vite 5 guide" provider="tavily" />');
    assert.deepStrictEqual(res, {
      tool: 'web_search',
      params: { query: 'Vite 5 guide', provider: 'tavily' }
    });
  });

  await t.test('should parse web_search without provider', () => {
    const res = parseToolCall('<web_search query="Node.js tutorial" />');
    assert.deepStrictEqual(res, {
      tool: 'web_search',
      params: { query: 'Node.js tutorial', provider: undefined }
    });
  });
});

test('toolParser - fetch_url', () => {
  const res = parseToolCall('<fetch_url url="https://example.com/api" />');
  assert.deepStrictEqual(res, {
    tool: 'fetch_url',
    params: { url: 'https://example.com/api' }
  });
});

test('toolParser - inspect_code_context XML compatibility', () => {
  const res = parseToolCall('<inspect_code_context mode="references" query="add" limit="5" />');
  assert.deepStrictEqual(res, {
    tool: 'inspect_code_context',
    params: { mode: 'references', query: 'add', limit: 5 }
  });
});

test('toolParser - inspect_url', () => {
  const res = parseToolCall('<inspect_url url="https://example.com" />');
  assert.deepStrictEqual(res, {
    tool: 'inspect_url',
    params: { url: 'https://example.com' }
  });
});

test('toolParser - render_page', () => {
  const res = parseToolCall('<render_page url="https://example.com" />');
  assert.deepStrictEqual(res, {
    tool: 'render_page',
    params: { url: 'https://example.com' }
  });
});

test('toolParser - crawl_site with depth and limit', async (t) => {
  await t.test('should parse crawl_site with explicit depth and limit', () => {
    const res = parseToolCall('<crawl_site url="https://example.com" depth="2" limit="10" />');
    assert.deepStrictEqual(res, {
      tool: 'crawl_site',
      params: { url: 'https://example.com', depth: 2, limit: 10 }
    });
  });

  await t.test('should use defaults when depth/limit not specified', () => {
    const res = parseToolCall('<crawl_site url="https://example.com" />');
    assert.deepStrictEqual(res, {
      tool: 'crawl_site',
      params: { url: 'https://example.com', depth: 1, limit: 20 }
    });
  });
});

test('toolParser - monitor_target', () => {
  const res = parseToolCall('<monitor_target url="https://example.com" />');
  assert.deepStrictEqual(res, {
    tool: 'monitor_target',
    params: { url: 'https://example.com' }
  });
});

test('toolParser - multiple web tools in sequence', () => {
  const content = `
    Let's search first:
    <web_search query="test" />
    Then fetch:
    <fetch_url url="https://example.com" />
    Then inspect:
    <inspect_url url="https://example.com" />
  `;
  const res = parseAllToolCalls(content);
  assert.strictEqual(res.length, 3);
  assert.strictEqual(res[0].tool, 'web_search');
  assert.strictEqual(res[1].tool, 'fetch_url');
  assert.strictEqual(res[2].tool, 'inspect_url');
});

test('toolParser - detectMalformedToolCall & buildToolCorrectionPrompt', async (t) => {
  await t.test('should detect unclosed or broken XML tool call', () => {
    const unclosed = 'I will write the file: <write_file path="test.js">const a = 1;';
    const malformed = detectMalformedToolCall(unclosed);
    assert.notStrictEqual(malformed, null);
    assert.strictEqual(malformed.tool, 'write_file');
    assert.strictEqual(malformed.type, 'unclosed_or_malformed_xml');

    const prompt = buildToolCorrectionPrompt(malformed);
    assert.strictEqual(prompt.includes('write_file'), true);
  });

  await t.test('should detect malformed JSON tool call', () => {
    const brokenJson = 'Calling tool: {"tool": "read_file", "params": { broken ...';
    const malformed = detectMalformedToolCall(brokenJson);
    assert.notStrictEqual(malformed, null);
    assert.strictEqual(malformed.tool, 'read_file');
    assert.strictEqual(malformed.type, 'malformed_json_tool_call');
  });

  await t.test('should return null when tool is properly parsed or plain text', () => {
    assert.strictEqual(detectMalformedToolCall('<read_file path="src/index.js" />'), null);
    assert.strictEqual(detectMalformedToolCall('just a normal conversation without tool attempt'), null);
  });
});

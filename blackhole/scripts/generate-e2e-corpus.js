import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const outputPath = path.join(PROJECT_ROOT, 'benchmarks', 'agent-e2e', 'e2e-cases.json');

const cases = [
  makeCase({
    id: 'fix-average-empty-array',
    instruction: 'Fix average([]) so it returns 0 instead of NaN while preserving normal averages.',
    module: 'stats',
    initial: 'export function average(values) {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { average } from './stats.js';\n\ntest('average handles normal and empty arrays', () => {\n  assert.strictEqual(average([2, 4, 6]), 4);\n  assert.strictEqual(average([]), 0);\n});\n",
    search: 'export function average(values) {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n',
    replace: 'export function average(values) {\n  if (!Array.isArray(values) || values.length === 0) return 0;\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n',
    contains: 'values.length === 0'
  }),
  makeCase({
    id: 'normalize-email',
    instruction: 'Make normalizeEmail trim whitespace and lowercase email addresses.',
    module: 'user',
    initial: 'export function normalizeEmail(email) {\n  return String(email);\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { normalizeEmail } from './user.js';\n\ntest('normalizeEmail trims and lowercases', () => {\n  assert.strictEqual(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');\n});\n",
    search: 'return String(email);',
    replace: 'return String(email).trim().toLowerCase();',
    contains: '.toLowerCase()'
  }),
  makeCase({
    id: 'parse-port-default',
    instruction: 'Fix parsePort so invalid, empty, or non-positive values fall back to the provided default port.',
    module: 'config',
    initial: 'export function parsePort(value, defaultPort = 3000) {\n  return Number(value);\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { parsePort } from './config.js';\n\ntest('parsePort validates numeric ports', () => {\n  assert.strictEqual(parsePort('8080'), 8080);\n  assert.strictEqual(parsePort('', 3003), 3003);\n  assert.strictEqual(parsePort('nope', 3003), 3003);\n  assert.strictEqual(parsePort('-1', 3003), 3003);\n});\n",
    search: 'return Number(value);',
    replace: 'const parsed = Number(value);\n  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;',
    contains: 'Number.isInteger'
  }),
  makeCase({
    id: 'unique-tags',
    instruction: 'Make uniqueTags return lowercase tags without duplicates while preserving first-seen order.',
    module: 'tags',
    initial: 'export function uniqueTags(tags) {\n  return tags;\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { uniqueTags } from './tags.js';\n\ntest('uniqueTags normalizes and deduplicates', () => {\n  assert.deepStrictEqual(uniqueTags(['AI', 'agent', 'ai', 'Code']), ['ai', 'agent', 'code']);\n});\n",
    search: 'return tags;',
    replace: "const seen = new Set();\n  const result = [];\n  for (const tag of tags) {\n    const normalized = String(tag).trim().toLowerCase();\n    if (!normalized || seen.has(normalized)) continue;\n    seen.add(normalized);\n    result.push(normalized);\n  }\n  return result;",
    contains: 'new Set'
  }),
  makeCase({
    id: 'async-cache-hit',
    instruction: 'Fix loadUser so it returns a cached user without calling the fetcher again.',
    module: 'users',
    initial: 'const cache = new Map();\n\nexport async function loadUser(id, fetcher) {\n  const user = await fetcher(id);\n  cache.set(id, user);\n  return user;\n}\n\nexport function clearUserCache() {\n  cache.clear();\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { clearUserCache, loadUser } from './users.js';\n\ntest('loadUser returns cached users', async () => {\n  clearUserCache();\n  let calls = 0;\n  const fetcher = async (id) => ({ id, calls: ++calls });\n  assert.deepStrictEqual(await loadUser('ada', fetcher), { id: 'ada', calls: 1 });\n  assert.deepStrictEqual(await loadUser('ada', fetcher), { id: 'ada', calls: 1 });\n  assert.strictEqual(calls, 1);\n});\n",
    search: 'export async function loadUser(id, fetcher) {\n  const user = await fetcher(id);\n  cache.set(id, user);\n  return user;\n}\n',
    replace: 'export async function loadUser(id, fetcher) {\n  if (cache.has(id)) return cache.get(id);\n  const user = await fetcher(id);\n  cache.set(id, user);\n  return user;\n}\n',
    contains: 'cache.has'
  }),
  makeCase({
    id: 'multi-file-export-contract',
    instruction: 'Rename the public formatter from formatName to formatDisplayName and update its test/import usage.',
    module: 'formatter',
    initial: 'export function formatName(user) {\n  return user.first + " " + user.last;\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { formatDisplayName } from './formatter.js';\n\ntest('formatDisplayName joins first and last name', () => {\n  assert.strictEqual(formatDisplayName({ first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace');\n});\n",
    search: 'export function formatName(user) {',
    replace: 'export function formatDisplayName(user) {',
    contains: 'formatDisplayName'
  }),
  makeCase({
    id: 'safe-json-parse',
    instruction: 'Make safeJsonParse return the fallback value when parsing invalid JSON.',
    module: 'json',
    initial: 'export function safeJsonParse(value, fallback = null) {\n  return JSON.parse(value);\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { safeJsonParse } from './json.js';\n\ntest('safeJsonParse handles invalid JSON', () => {\n  assert.deepStrictEqual(safeJsonParse('{\"ok\":true}'), { ok: true });\n  assert.deepStrictEqual(safeJsonParse('{bad', { ok: false }), { ok: false });\n});\n",
    search: 'return JSON.parse(value);',
    replace: 'try {\n    return JSON.parse(value);\n  } catch {\n    return fallback;\n  }',
    contains: 'catch'
  }),
  makeCase({
    id: 'sort-by-priority',
    instruction: 'Fix sortTasks so highest priority tasks appear first, with stable alphabetical tie-breaking.',
    module: 'tasks',
    initial: 'export function sortTasks(tasks) {\n  return [...tasks].sort((a, b) => a.priority - b.priority);\n}\n',
    test: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sortTasks } from './tasks.js';\n\ntest('sortTasks sorts by priority desc then title asc', () => {\n  assert.deepStrictEqual(sortTasks([\n    { title: 'beta', priority: 1 },\n    { title: 'alpha', priority: 3 },\n    { title: 'gamma', priority: 3 }\n  ]).map(task => task.title), ['alpha', 'gamma', 'beta']);\n});\n",
    search: 'return [...tasks].sort((a, b) => a.priority - b.priority);',
    replace: 'return [...tasks].sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));',
    contains: 'localeCompare'
  }),
  simpleCase('clamp-boundary', 'Fix clamp so it respects both min and max boundaries.', 'math', 'export function clamp(value, min, max) {\n  return Math.max(max, Math.min(value, max));\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { clamp } from './math.js';\n\ntest('clamp keeps values inside bounds', () => {\n  assert.strictEqual(clamp(5, 0, 10), 5);\n  assert.strictEqual(clamp(-1, 0, 10), 0);\n  assert.strictEqual(clamp(20, 0, 10), 10);\n});\n", 'return Math.max(max, Math.min(value, max));', 'return Math.max(min, Math.min(value, max));', 'Math.max(min'),
  simpleCase('slug-normalization', 'Normalize punctuation and duplicate separators in toSlug.', 'slug', "export function toSlug(value) {\n  return String(value).trim().toLowerCase().replace(/\\s+/g, '-');\n}\n", "import test from 'node:test';\nimport assert from 'node:assert';\nimport { toSlug } from './slug.js';\n\ntest('toSlug normalizes punctuation and repeated separators', () => {\n  assert.strictEqual(toSlug(' Hello,   BlackHole!! '), 'hello-blackhole');\n});\n", "return String(value).trim().toLowerCase().replace(/\\s+/g, '-');", "return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');", 'replace(/[^a-z0-9]+/g'),
  simpleCase('format-status-prefix', 'Make formatStatus wrap uppercase statuses in square brackets.', 'status', 'export function formatStatus(status) {\n  return status.toUpperCase();\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { formatStatus } from './status.js';\n\ntest('formatStatus includes stable prefix', () => {\n  assert.strictEqual(formatStatus('ready'), '[READY]');\n});\n", 'return status.toUpperCase();', 'return "[" + String(status).toUpperCase() + "]";', 'String(status)'),
  simpleCase('sum-numeric-strings', 'Make sumValues coerce numeric strings while ignoring invalid values.', 'sum', 'export function sumValues(values) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sumValues } from './sum.js';\n\ntest('sumValues coerces numeric strings', () => {\n  assert.strictEqual(sumValues([1, '2', 'bad', 3]), 6);\n});\n", 'return values.reduce((sum, value) => sum + value, 0);', 'return values.reduce((sum, value) => {\n    const parsed = Number(value);\n    return Number.isFinite(parsed) ? sum + parsed : sum;\n  }, 0);', 'Number.isFinite'),
  simpleCase('parse-boolean-values', 'Support yes/no and 1/0 strings in parseBoolean.', 'boolean', 'export function parseBoolean(value) {\n  return Boolean(value);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { parseBoolean } from './boolean.js';\n\ntest('parseBoolean supports explicit strings', () => {\n  assert.strictEqual(parseBoolean('yes'), true);\n  assert.strictEqual(parseBoolean('1'), true);\n  assert.strictEqual(parseBoolean('no'), false);\n  assert.strictEqual(parseBoolean('0'), false);\n});\n", 'return Boolean(value);', "const normalized = String(value).trim().toLowerCase();\n  if (['yes', 'true', '1'].includes(normalized)) return true;\n  if (['no', 'false', '0', ''].includes(normalized)) return false;\n  return Boolean(value);", 'normalized'),
  simpleCase('ensure-array-null', 'Make ensureArray return an empty array for nullish input.', 'array', 'export function ensureArray(value) {\n  return Array.isArray(value) ? value : [value];\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { ensureArray } from './array.js';\n\ntest('ensureArray handles nullish values', () => {\n  assert.deepStrictEqual(ensureArray(null), []);\n  assert.deepStrictEqual(ensureArray(undefined), []);\n  assert.deepStrictEqual(ensureArray('x'), ['x']);\n});\n", 'return Array.isArray(value) ? value : [value];', 'if (value === null || value === undefined) return [];\n  return Array.isArray(value) ? value : [value];', 'undefined'),
  simpleCase('last-item-empty', 'Make lastItem return null for empty arrays.', 'last', 'export function lastItem(items) {\n  return items[items.length - 1];\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { lastItem } from './last.js';\n\ntest('lastItem handles empty arrays', () => {\n  assert.strictEqual(lastItem([1, 2, 3]), 3);\n  assert.strictEqual(lastItem([]), null);\n});\n", 'return items[items.length - 1];', 'return items.length ? items[items.length - 1] : null;', 'items.length ?'),
  simpleCase('group-by-category', 'Implement groupByCategory so items are grouped by category.', 'groups', 'export function groupByCategory(items) {\n  return {};\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { groupByCategory } from './groups.js';\n\ntest('groupByCategory groups items', () => {\n  assert.deepStrictEqual(groupByCategory([{ category: 'a', id: 1 }, { category: 'a', id: 2 }, { category: 'b', id: 3 }]), {\n    a: [{ category: 'a', id: 1 }, { category: 'a', id: 2 }],\n    b: [{ category: 'b', id: 3 }]\n  });\n});\n", 'return {};', 'return items.reduce((groups, item) => {\n    const key = item.category || "uncategorized";\n    groups[key] = groups[key] || [];\n    groups[key].push(item);\n    return groups;\n  }, {});', 'reduce'),
  simpleCase('merge-defaults-order', 'Make mergeDefaults keep explicit config values while filling missing defaults.', 'defaults', 'export function mergeDefaults(config, defaults) {\n  return { ...config, ...defaults };\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { mergeDefaults } from './defaults.js';\n\ntest('mergeDefaults preserves explicit values', () => {\n  assert.deepStrictEqual(mergeDefaults({ port: 3003 }, { port: 8080, host: '127.0.0.1' }), { port: 3003, host: '127.0.0.1' });\n});\n", 'return { ...config, ...defaults };', 'return { ...defaults, ...config };', '...defaults'),
  simpleCase('parse-csv-trim', 'Make parseCsv trim entries and drop empty fields.', 'csv', 'export function parseCsv(value) {\n  return String(value).split(",");\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { parseCsv } from './csv.js';\n\ntest('parseCsv trims and drops empty entries', () => {\n  assert.deepStrictEqual(parseCsv(' a, ,b,c '), ['a', 'b', 'c']);\n});\n", 'return String(value).split(",");', 'return String(value).split(",").map(part => part.trim()).filter(Boolean);', 'filter(Boolean)'),
  simpleCase('filter-active-users', 'Make activeUsers return only users with active === true.', 'activeUsers', 'export function activeUsers(users) {\n  return users;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { activeUsers } from './activeUsers.js';\n\ntest('activeUsers filters inactive users', () => {\n  assert.deepStrictEqual(activeUsers([{ id: 1, active: true }, { id: 2, active: false }]), [{ id: 1, active: true }]);\n});\n", 'return users;', 'return users.filter(user => user.active === true);', 'active === true'),
  simpleCase('currency-cents-rounding', 'Make dollarsToCents round to the nearest cent.', 'money', 'export function dollarsToCents(amount) {\n  return amount * 100;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { dollarsToCents } from './money.js';\n\ntest('dollarsToCents rounds correctly', () => {\n  assert.strictEqual(dollarsToCents(10.239), 1024);\n});\n", 'return amount * 100;', 'return Math.round(Number(amount) * 100);', 'Math.round'),
  simpleCase('title-case-words', 'Make titleCase capitalize each word and normalize whitespace.', 'title', 'export function titleCase(value) {\n  return String(value);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { titleCase } from './title.js';\n\ntest('titleCase capitalizes words', () => {\n  assert.strictEqual(titleCase('  hello blackhole agent '), 'Hello Blackhole Agent');\n});\n", 'return String(value);', "return String(value).trim().split(/\\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');", 'charAt(0)'),
  simpleCase('redact-api-token', 'Make redactToken keep the first and last four characters only.', 'redact', 'export function redactToken(token) {\n  return String(token);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { redactToken } from './redact.js';\n\ntest('redactToken masks secrets', () => {\n  assert.strictEqual(redactToken('abcdefghijklmnop'), 'abcd********mnop');\n});\n", 'return String(token);', 'const value = String(token);\n  if (value.length <= 8) return "*".repeat(value.length);\n  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);', 'repeat'),
  simpleCase('query-string-decode', 'Make parseQuery decode URL query strings into an object.', 'query', 'export function parseQuery(query) {\n  return {};\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { parseQuery } from './query.js';\n\ntest('parseQuery decodes params', () => {\n  assert.deepStrictEqual(parseQuery('?q=black%20hole&page=2'), { q: 'black hole', page: '2' });\n});\n", 'return {};', 'const params = new URLSearchParams(String(query).replace(/^\\?/, ""));\n  return Object.fromEntries(params.entries());', 'URLSearchParams'),
  simpleCase('build-url-join', 'Make joinUrl avoid duplicate slashes between base and path.', 'url', 'export function joinUrl(base, pathname) {\n  return base + "/" + pathname;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { joinUrl } from './url.js';\n\ntest('joinUrl avoids duplicate slashes', () => {\n  assert.strictEqual(joinUrl('https://example.com/', '/api'), 'https://example.com/api');\n});\n", 'return base + "/" + pathname;', 'return String(base).replace(/\\/+$/, "") + "/" + String(pathname).replace(/^\\/+/, "");', 'replace(/\\/+$/'),
  simpleCase('minmax-summary', 'Make summarizeNumbers return min, max, and count.', 'numbers', 'export function summarizeNumbers(values) {\n  return { count: values.length };\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { summarizeNumbers } from './numbers.js';\n\ntest('summarizeNumbers returns min max count', () => {\n  assert.deepStrictEqual(summarizeNumbers([3, 1, 8]), { min: 1, max: 8, count: 3 });\n});\n", 'return { count: values.length };', 'return { min: Math.min(...values), max: Math.max(...values), count: values.length };', 'Math.min'),
  simpleCase('dedupe-by-id', 'Make dedupeById preserve the first object for each id.', 'dedupe', 'export function dedupeById(items) {\n  return items;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { dedupeById } from './dedupe.js';\n\ntest('dedupeById preserves first item', () => {\n  assert.deepStrictEqual(dedupeById([{ id: 1, name: 'a' }, { id: 1, name: 'b' }, { id: 2, name: 'c' }]), [{ id: 1, name: 'a' }, { id: 2, name: 'c' }]);\n});\n", 'return items;', 'const seen = new Set();\n  return items.filter(item => {\n    if (seen.has(item.id)) return false;\n    seen.add(item.id);\n    return true;\n  });', 'seen.has'),
  simpleCase('count-words-normalized', 'Make countWords ignore repeated whitespace and empty input.', 'words', 'export function countWords(value) {\n  return String(value).split(" ").length;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { countWords } from './words.js';\n\ntest('countWords normalizes whitespace', () => {\n  assert.strictEqual(countWords(' one   two three '), 3);\n  assert.strictEqual(countWords('   '), 0);\n});\n", 'return String(value).split(" ").length;', 'const text = String(value).trim();\n  return text ? text.split(/\\s+/).length : 0;', 'split(/\\s+/)'),
  simpleCase('path-separator-normalize', 'Make normalizePath convert Windows separators to forward slashes.', 'paths', 'export function normalizePath(value) {\n  return value;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { normalizePath } from './paths.js';\n\ntest('normalizePath converts separators', () => {\n  assert.strictEqual(normalizePath('src\\\\agent\\\\core.js'), 'src/agent/core.js');\n});\n", 'return value;', 'return String(value).replace(/\\\\+/g, "/");', 'replace(/\\\\+/g'),
  simpleCase('is-even-coerce', 'Make isEven return true only for finite even numbers.', 'even', 'export function isEven(value) {\n  return value % 2 === 0;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { isEven } from './even.js';\n\ntest('isEven validates finite numbers', () => {\n  assert.strictEqual(isEven(4), true);\n  assert.strictEqual(isEven('4'), true);\n  assert.strictEqual(isEven('x'), false);\n});\n", 'return value % 2 === 0;', 'const number = Number(value);\n  return Number.isFinite(number) && number % 2 === 0;', 'Number.isFinite'),
  simpleCase('role-access-admin', 'Make canAccess allow admins regardless of ownership.', 'access', 'export function canAccess(user, resource) {\n  return user.id === resource.ownerId;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { canAccess } from './access.js';\n\ntest('canAccess allows admins and owners', () => {\n  assert.strictEqual(canAccess({ id: 1, role: 'user' }, { ownerId: 1 }), true);\n  assert.strictEqual(canAccess({ id: 2, role: 'admin' }, { ownerId: 1 }), true);\n});\n", 'return user.id === resource.ownerId;', 'return user.role === "admin" || user.id === resource.ownerId;', 'role === "admin"'),
  simpleCase('paginate-bounds', 'Make paginate clamp page and size to positive values.', 'paginate', 'export function paginate(items, page, size) {\n  const start = (page - 1) * size;\n  return items.slice(start, start + size);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { paginate } from './paginate.js';\n\ntest('paginate clamps invalid bounds', () => {\n  assert.deepStrictEqual(paginate([1, 2, 3], 0, 2), [1, 2]);\n  assert.deepStrictEqual(paginate([1, 2, 3], 2, 2), [3]);\n});\n", 'const start = (page - 1) * size;\n  return items.slice(start, start + size);', 'const safePage = Math.max(1, Number(page) || 1);\n  const safeSize = Math.max(1, Number(size) || items.length || 1);\n  const start = (safePage - 1) * safeSize;\n  return items.slice(start, start + safeSize);', 'safePage'),
  simpleCase('discount-rounding', 'Make applyDiscount apply a percentage and round to two decimals.', 'discount', 'export function applyDiscount(price, percent) {\n  return price - price * percent;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { applyDiscount } from './discount.js';\n\ntest('applyDiscount rounds to two decimals', () => {\n  assert.strictEqual(applyDiscount(19.99, 0.15), 16.99);\n});\n", 'return price - price * percent;', 'return Math.round((Number(price) * (1 - Number(percent))) * 100) / 100;', 'Math.round'),
  simpleCase('invert-map-values', 'Make invertObject swap keys and values as strings.', 'invert', 'export function invertObject(value) {\n  return value;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { invertObject } from './invert.js';\n\ntest('invertObject swaps keys and values', () => {\n  assert.deepStrictEqual(invertObject({ a: 1, b: 2 }), { 1: 'a', 2: 'b' });\n});\n", 'return value;', 'return Object.fromEntries(Object.entries(value).map(([key, val]) => [String(val), key]));', 'Object.fromEntries'),
  simpleCase('compact-object-nullish', 'Make compactObject remove null and undefined values only.', 'compact', 'export function compactObject(value) {\n  return value;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { compactObject } from './compact.js';\n\ntest('compactObject removes nullish values', () => {\n  assert.deepStrictEqual(compactObject({ a: 0, b: null, c: false, d: undefined }), { a: 0, c: false });\n});\n", 'return value;', 'return Object.fromEntries(Object.entries(value).filter(([, val]) => val !== null && val !== undefined));', 'val !== null'),
  simpleCase('retry-attempt-count', 'Make shouldRetry allow attempts below maxRetries only.', 'retry', 'export function shouldRetry(attempt, maxRetries) {\n  return attempt <= maxRetries;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { shouldRetry } from './retry.js';\n\ntest('shouldRetry uses strict retry limit', () => {\n  assert.strictEqual(shouldRetry(0, 2), true);\n  assert.strictEqual(shouldRetry(1, 2), true);\n  assert.strictEqual(shouldRetry(2, 2), false);\n});\n", 'return attempt <= maxRetries;', 'return attempt < maxRetries;', 'attempt <'),
  simpleCase('resolve-env-default', 'Make getEnv return fallback when value is missing or empty.', 'env', 'export function getEnv(env, key, fallback) {\n  return env[key];\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { getEnv } from './env.js';\n\ntest('getEnv returns fallback for missing or empty', () => {\n  assert.strictEqual(getEnv({ PORT: '' }, 'PORT', '3003'), '3003');\n  assert.strictEqual(getEnv({ HOST: '127.0.0.1' }, 'HOST', 'localhost'), '127.0.0.1');\n});\n", 'return env[key];', 'const value = env[key];\n  return value === undefined || value === "" ? fallback : value;', 'fallback'),
  simpleCase('normalize-http-method', 'Make normalizeMethod uppercase methods and default to GET.', 'method', 'export function normalizeMethod(method) {\n  return method;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { normalizeMethod } from './method.js';\n\ntest('normalizeMethod uppercases and defaults', () => {\n  assert.strictEqual(normalizeMethod('post'), 'POST');\n  assert.strictEqual(normalizeMethod(''), 'GET');\n});\n", 'return method;', 'const normalized = String(method || "GET").trim().toUpperCase();\n  return normalized || "GET";', 'toUpperCase'),
  simpleCase('select-primary-email', 'Make primaryEmail pick the primary email or fallback to the first email.', 'emails', 'export function primaryEmail(user) {\n  return user.emails[0].value;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { primaryEmail } from './emails.js';\n\ntest('primaryEmail prefers primary flag', () => {\n  assert.strictEqual(primaryEmail({ emails: [{ value: 'a@example.com' }, { value: 'b@example.com', primary: true }] }), 'b@example.com');\n});\n", 'return user.emails[0].value;', 'const primary = user.emails.find(email => email.primary) || user.emails[0];\n  return primary?.value || "";', 'find'),
  simpleCase('parse-number-list', 'Make parseNumberList return only finite numbers from a comma string.', 'numberList', 'export function parseNumberList(value) {\n  return String(value).split(",").map(Number);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { parseNumberList } from './numberList.js';\n\ntest('parseNumberList filters invalid entries', () => {\n  assert.deepStrictEqual(parseNumberList('1,2,x,4'), [1, 2, 4]);\n});\n", 'return String(value).split(",").map(Number);', 'return String(value).split(",").map(Number).filter(Number.isFinite);', 'Number.isFinite'),
  simpleCase('status-code-ok', 'Make isOkStatus accept every 2xx HTTP status.', 'httpStatus', 'export function isOkStatus(status) {\n  return status === 200;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { isOkStatus } from './httpStatus.js';\n\ntest('isOkStatus accepts 2xx', () => {\n  assert.strictEqual(isOkStatus(200), true);\n  assert.strictEqual(isOkStatus(204), true);\n  assert.strictEqual(isOkStatus(404), false);\n});\n", 'return status === 200;', 'return status >= 200 && status < 300;', 'status < 300'),
  simpleCase('normalize-extension', 'Make ensureExtension append the extension only when missing.', 'extension', 'export function ensureExtension(file, ext) {\n  return file + ext;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { ensureExtension } from './extension.js';\n\ntest('ensureExtension appends only when missing', () => {\n  assert.strictEqual(ensureExtension('report', '.md'), 'report.md');\n  assert.strictEqual(ensureExtension('report.md', '.md'), 'report.md');\n});\n", 'return file + ext;', 'return String(file).endsWith(ext) ? String(file) : String(file) + ext;', 'endsWith'),
  simpleCase('stable-random-seed', 'Make seededId produce a stable id prefix from a name.', 'seededId', 'export function seededId(name) {\n  return Math.random().toString(16).slice(2);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { seededId } from './seededId.js';\n\ntest('seededId is stable for a name', () => {\n  assert.strictEqual(seededId('Black Hole'), 'black-hole');\n});\n", 'return Math.random().toString(16).slice(2);', 'return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");', 'toLowerCase'),
  simpleCase('validate-required-fields', 'Make hasRequiredFields check all requested fields are present.', 'required', 'export function hasRequiredFields(value, fields) {\n  return true;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { hasRequiredFields } from './required.js';\n\ntest('hasRequiredFields checks all fields', () => {\n  assert.strictEqual(hasRequiredFields({ a: 1, b: 2 }, ['a', 'b']), true);\n  assert.strictEqual(hasRequiredFields({ a: 1 }, ['a', 'b']), false);\n});\n", 'return true;', 'return fields.every(field => Object.prototype.hasOwnProperty.call(value, field));', 'every'),
  simpleCase('merge-arrays-unique', 'Make mergeUnique combine arrays without duplicate primitive values.', 'mergeUnique', 'export function mergeUnique(a, b) {\n  return a.concat(b);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { mergeUnique } from './mergeUnique.js';\n\ntest('mergeUnique removes duplicates', () => {\n  assert.deepStrictEqual(mergeUnique([1, 2], [2, 3]), [1, 2, 3]);\n});\n", 'return a.concat(b);', 'return Array.from(new Set([...a, ...b]));', 'new Set'),
  simpleCase('calculate-duration-ms', 'Make durationMs return non-negative elapsed milliseconds.', 'duration', 'export function durationMs(start, end) {\n  return end - start;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { durationMs } from './duration.js';\n\ntest('durationMs clamps negative values', () => {\n  assert.strictEqual(durationMs(10, 20), 10);\n  assert.strictEqual(durationMs(20, 10), 0);\n});\n", 'return end - start;', 'return Math.max(0, Number(end) - Number(start));', 'Math.max'),
  simpleCase('format-bytes', 'Make formatBytes show bytes and KB values.', 'bytes', 'export function formatBytes(bytes) {\n  return bytes + " B";\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { formatBytes } from './bytes.js';\n\ntest('formatBytes supports KB', () => {\n  assert.strictEqual(formatBytes(512), '512 B');\n  assert.strictEqual(formatBytes(2048), '2 KB');\n});\n", 'return bytes + " B";', 'const value = Number(bytes);\n  return value < 1024 ? value + " B" : Math.round(value / 1024) + " KB";', '1024'),
  simpleCase('build-cache-key', 'Make cacheKey sort object keys for stable cache keys.', 'cacheKey', 'export function cacheKey(value) {\n  return JSON.stringify(value);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { cacheKey } from './cacheKey.js';\n\ntest('cacheKey sorts keys', () => {\n  assert.strictEqual(cacheKey({ b: 2, a: 1 }), '{\"a\":1,\"b\":2}');\n});\n", 'return JSON.stringify(value);', 'return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));', 'localeCompare'),
  simpleCase('find-by-id-string', 'Make findById match ids as strings.', 'findById', 'export function findById(items, id) {\n  return items.find(item => item.id === id);\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { findById } from './findById.js';\n\ntest('findById matches string ids', () => {\n  assert.deepStrictEqual(findById([{ id: 1 }], '1'), { id: 1 });\n});\n", 'return items.find(item => item.id === id);', 'return items.find(item => String(item.id) === String(id));', 'String(item.id)'),
  simpleCase('normalize-log-level', 'Make normalizeLevel map unknown log levels to info.', 'logLevel', 'export function normalizeLevel(level) {\n  return level;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { normalizeLevel } from './logLevel.js';\n\ntest('normalizeLevel maps unknown levels', () => {\n  assert.strictEqual(normalizeLevel('WARN'), 'warn');\n  assert.strictEqual(normalizeLevel('verbose'), 'info');\n});\n", 'return level;', 'const normalized = String(level).toLowerCase();\n  return ["debug", "info", "warn", "error"].includes(normalized) ? normalized : "info";', 'includes'),
  simpleCase('extract-domain', 'Make extractDomain return the hostname from a URL.', 'domain', 'export function extractDomain(url) {\n  return url;\n}\n', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { extractDomain } from './domain.js';\n\ntest('extractDomain returns hostname', () => {\n  assert.strictEqual(extractDomain('https://example.com/a?b=1'), 'example.com');\n});\n", 'return url;', 'return new URL(url).hostname;', 'new URL')
];

if (cases.length !== 50) {
  throw new Error(`Expected 50 generated cases, got ${cases.length}`);
}

const corpus = {
  version: 2,
  name: 'BlackHole agent end-to-end task corpus',
  description: 'Problem-only coding tasks for measuring full agent-loop solve-rate. Deterministic baseline uses operations; --real-model asks the configured model to solve from the instruction only.',
  cases
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, outputPath, cases: cases.length }, null, 2));

function simpleCase(id, instruction, module, initial, test, search, replace, contains) {
  return makeCase({ id, instruction, module, initial, test, search, replace, contains });
}

function makeCase({ id, instruction, module, initial, test, search, replace, contains }) {
  const sourcePath = `src/${module}.js`;
  const testPath = `src/${module}.test.js`;
  return {
    id,
    instruction,
    changedFiles: [sourcePath],
    files: {
      'package.json': '{"type":"module"}\n',
      [sourcePath]: initial,
      [testPath]: test
    },
    operations: [
      {
        type: 'patch_file',
        path: sourcePath,
        search,
        replace
      }
    ],
    expected: {
      contains: {
        [sourcePath]: contains
      },
      testTargets: [testPath]
    }
  };
}

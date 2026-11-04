import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

function getFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else if (filePath.endsWith('.js') && !filePath.endsWith('.test.js')) {
      results.push(filePath);
    }
  });
  return results;
}

try {
  console.log('🔍 Checking backend syntax...');
  const files = getFilesRecursively(srcDir);
  let hasError = false;

  files.forEach((file) => {
    const relativePath = path.relative(rootDir, file);
    try {
      execSync(`"${process.execPath}" --check "${relativePath}"`, { cwd: rootDir, stdio: 'ignore' });
      console.log(`✅ ${relativePath} is valid.`);
    } catch (e) {
      console.error(`❌ Syntax error in ${relativePath}`);
      hasError = true;
    }
  });

  if (hasError) {
    process.exit(1);
  } else {
    console.log('🎉 All backend files are syntax-valid!');
    process.exit(0);
  }
} catch (err) {
  console.error('Fatal error during syntax checks:', err);
  process.exit(1);
}

module.exports = filePath => /\/node_modules\/typescript\/lib\/[^/]+\.d\.ts$/.test(String(filePath).replaceAll('\\', '/'));

module.exports = {
  ...require('../package.json').build,
  extraResources: [
    { from: 'resources/llama.cpp/linux-${arch}', to: 'llama.cpp/linux-${arch}', filter: ['**/*'] },
    { from: 'models', to: 'models', filter: ['**/*', '!**/*.gguf', '!**/*.gguf.*'] },
    { from: 'resources/vscode', to: 'vscode', filter: ['vscode-blackhole.vsix'] },
    { from: 'resources/node-runtime/current', to: 'node-runtime', filter: ['**/*'] }
  ]
};

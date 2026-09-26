const readonly = (names) => Object.fromEntries(names.map(name => [name, 'readonly']));

module.exports = [
  { ignores: ['release/**', 'coverage/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: readonly([
        'Buffer', 'URL', 'URLSearchParams', 'console', 'process', 'global',
        '__dirname', '__filename', 'setTimeout', 'clearTimeout', 'setInterval', 'setImmediate', 'clearImmediate',
        'clearInterval', 'queueMicrotask', 'structuredClone', 'fetch', 'AbortController',
      ]),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: readonly([
        'window', 'document', 'navigator', 'localStorage', 'performance',
        'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver',
        'MutationObserver', 'Event', 'CustomEvent', 'DOMParser', 'HTMLElement',
        'Node', 'confirm', 'alert', 'getComputedStyle', 'matchMedia',
      ]),
    },
  },
];

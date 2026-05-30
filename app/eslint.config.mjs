// ESLint 9 flat config. Non-type-aware (fast, robust — no tsconfig project service).
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '.vite/**',
      'out/**',
      'dist/**',
      'node_modules/**',
      '*.d.ts',
      'forge.config.ts',
      'vite.*.config.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      // TS's own checker handles undefined identifiers (incl. Node/Vite globals and
      // ambient declarations); no-undef is redundant and misfires here.
      'no-undef': 'off',
      // Defer unused-vars to the TS-aware rule.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];

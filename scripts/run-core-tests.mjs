#!/usr/bin/env node
/**
 * Cross-platform (Windows & Linux) test runner for Bifrost Core tests.
 * Automatically discovers and runs all `tests/*.test.ts` files in sorted order
 * using `node --import tsx --test`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_ROOT, 'core');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

const testFiles = fs
  .readdirSync(TESTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => path.join(TESTS_DIR, entry.name))
  .sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error(`[fail] No *.test.ts files found in ${TESTS_DIR}`);
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...extraArgs, ...testFiles],
  {
    cwd: CORE_DIR,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error('[fail] Unable to spawn test runner:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);

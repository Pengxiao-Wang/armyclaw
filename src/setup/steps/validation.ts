// ═══════════════════════════════════════════════════════════
// Step 4: Validation — tsc + vitest
// ═══════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import type { WizardUI } from '../ui.js';

export async function stepValidation(ui: WizardUI): Promise<void> {
  ui.step(4, 5, 'Validation');

  // Type check
  ui.info('Running TypeScript type check...');
  try {
    execSync('npx tsc --noEmit', { stdio: 'pipe', cwd: process.cwd() });
    ui.success('Type check passed');
  } catch {
    ui.error('TypeScript errors found. Run `npx tsc --noEmit` for details.');
    const cont = await ui.confirm('Continue anyway?', true);
    if (!cont) process.exit(1);
  }

  // Tests
  ui.info('Running tests...');
  try {
    execSync('npm test', { stdio: 'pipe', cwd: process.cwd() });
    ui.success('All tests passed');
  } catch {
    ui.warn('Some tests failed. Run `npm test` for details.');
    const cont = await ui.confirm('Continue anyway?', true);
    if (!cont) process.exit(1);
  }
}

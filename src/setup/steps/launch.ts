// ═══════════════════════════════════════════════════════════
// Step 5: Launch — Summary + one-click start
// ═══════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import type { WizardUI } from '../ui.js';
import type { EnvManager } from '../env-manager.js';
import { channelModules } from '../channels/index.js';

export async function stepLaunch(ui: WizardUI, env: EnvManager): Promise<void> {
  ui.step(5, 5, 'Launch');

  // Build summary
  const configured: string[] = [];

  if (env.has('ANTHROPIC_API_KEY')) {
    configured.push('API Key');
  }

  const envSnapshot: Record<string, string> = {};
  for (const mod of channelModules) {
    for (const key of mod.envVarNames) {
      const val = env.get(key);
      if (val !== undefined) envSnapshot[key] = val;
    }
    if (mod.isConfigured(envSnapshot)) {
      configured.push(`${mod.displayName} Channel`);
    }
  }

  ui.header('Setup complete!');
  if (configured.length > 0) {
    ui.info(`Configured: ${configured.join(', ')}`);
  }
  ui.blank();

  const launch = await ui.confirm('Start ArmyClaw now?', true);

  if (launch) {
    ui.blank();
    ui.info('Starting HQ + War Room...');
    ui.close();
    // Replace this process with the launcher
    try {
      execSync('npx tsx src/launcher.ts', {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    } catch {
      // User Ctrl+C'd the launcher — normal exit
    }
  } else {
    ui.blank();
    ui.info('To start later:');
    ui.info('  npm start');
    ui.blank();
  }
}

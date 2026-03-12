#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════
// ArmyClaw — Setup Wizard (TypeScript entry point)
// Called by setup.sh after pre-flight checks.
// Also runnable via: npx tsx src/setup/wizard.ts [flags]
// ═══════════════════════════════════════════════════════════

import path from 'path';
import { WizardUI } from './ui.js';
import { EnvManager } from './env-manager.js';
import { stepApiKey } from './steps/api-key.js';
import { stepCoreSettings } from './steps/core-settings.js';
import { stepChannels } from './steps/channels.js';
import { stepValidation } from './steps/validation.js';
import { stepLaunch } from './steps/launch.js';

// ─── CLI flag parsing ─────────────────────────────────────

interface WizardOptions {
  quick: boolean;
  channelsOnly: boolean;
  channelName?: string;
  skipValidation: boolean;
}

function parseArgs(args: string[]): WizardOptions {
  const opts: WizardOptions = {
    quick: false,
    channelsOnly: false,
    channelName: undefined,
    skipValidation: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--quick':
        opts.quick = true;
        break;
      case '--channels-only':
        opts.channelsOnly = true;
        break;
      case '--channel':
        opts.channelName = args[++i];
        break;
      case '--skip-validation':
        opts.skipValidation = true;
        break;
    }
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const ui = new WizardUI();

  const envPath = path.join(process.cwd(), '.env');
  const templatePath = path.join(process.cwd(), '.env.example');
  const env = EnvManager.load(envPath, templatePath);

  // Graceful Ctrl+C — save whatever we have
  process.on('SIGINT', () => {
    console.log('\n');
    ui.warn('Interrupted. Progress saved to .env.');
    ui.close();
    process.exit(130);
  });

  try {
    if (opts.channelsOnly || opts.channelName) {
      // Channels-only mode: jump straight to Step 3
      await stepChannels(ui, env, {
        channelsOnly: opts.channelsOnly,
        channelName: opts.channelName,
      });
      ui.blank();
      ui.success('Done!');
      ui.close();
      return;
    }

    // Full wizard flow
    if (!opts.quick) {
      ui.header('ArmyClaw Setup Wizard');
    }

    // Step 1: API Key (always, even in quick mode)
    await stepApiKey(ui, env);

    // Step 2: Core Settings
    await stepCoreSettings(ui, env, opts.quick);

    // Step 3: Channels (skip in quick mode)
    if (!opts.quick) {
      await stepChannels(ui, env, {});
    }

    // Step 4: Validation (skip if flagged or quick)
    if (!opts.skipValidation && !opts.quick) {
      await stepValidation(ui);
    }

    // Step 5: Launch
    await stepLaunch(ui, env);

    ui.close();
  } catch (err) {
    ui.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    ui.close();
    process.exit(1);
  }
}

main();

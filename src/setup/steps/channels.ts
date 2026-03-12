// ═══════════════════════════════════════════════════════════
// Step 3: Channels — Discover modules, multi-select, delegate
// ═══════════════════════════════════════════════════════════

import type { WizardUI } from '../ui.js';
import type { EnvManager } from '../env-manager.js';
import { channelModules } from '../channels/index.js';
import type { ChannelSetupModule } from '../channel-module.js';

export async function stepChannels(
  ui: WizardUI,
  env: EnvManager,
  opts: { channelsOnly?: boolean; channelName?: string },
): Promise<void> {
  ui.step(3, 5, 'Channel Configuration');

  // If a specific channel is requested, jump straight to it
  if (opts.channelName) {
    const mod = channelModules.find((m) => m.name === opts.channelName);
    if (!mod) {
      ui.error(`Unknown channel: ${opts.channelName}`);
      ui.info(`Available: ${channelModules.map((m) => m.name).join(', ')}`);
      return;
    }
    await configureChannel(ui, env, mod);
    return;
  }

  if (channelModules.length === 0) {
    ui.info('No channel modules found. Skipping.');
    return;
  }

  // Build current env snapshot for isConfigured check
  const envSnapshot = buildEnvSnapshot(env, channelModules);

  // Multi-select channels
  const options = channelModules.map((m) => {
    const status = m.isConfigured(envSnapshot) ? ' (configured)' : '';
    return {
      label: `${m.displayName} — ${m.description}${status}`,
      checked: m.isConfigured(envSnapshot),
    };
  });

  if (opts.channelsOnly) {
    // In channels-only mode, show all and let user pick
    ui.info('Select channels to configure:');
  }

  const selected = await ui.selectMany('Which channels to configure?', options);

  if (selected.length === 0) {
    ui.info('No channels selected. Skipping.');
    return;
  }

  for (const idx of selected) {
    await configureChannel(ui, env, channelModules[idx]);
  }
}

async function configureChannel(
  ui: WizardUI,
  env: EnvManager,
  mod: ChannelSetupModule,
): Promise<void> {
  ui.blank();
  ui.info(`Configuring ${mod.displayName}...`);
  ui.blank();

  const vars = await mod.setup(ui);

  // Test connection if available
  if (mod.testConnection) {
    ui.blank();
    ui.info('Testing connection...');
    const result = await mod.testConnection(vars);
    if (result.success) {
      ui.success(result.message);
    } else {
      ui.error(`Connection test failed: ${result.message}`);
      const cont = await ui.confirm('Save config anyway?', false);
      if (!cont) return;
    }
  }

  // Save as managed block
  env.upsertBlock(`${mod.displayName} Channel`, vars);
  env.save('.env');
  ui.success(`${mod.displayName} configuration saved`);
}

function buildEnvSnapshot(
  env: EnvManager,
  modules: ChannelSetupModule[],
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const mod of modules) {
    for (const key of mod.envVarNames) {
      const val = env.get(key);
      if (val !== undefined) snapshot[key] = val;
    }
  }
  return snapshot;
}

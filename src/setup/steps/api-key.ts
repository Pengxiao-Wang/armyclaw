// ═══════════════════════════════════════════════════════════
// Step 1: API Key — The only hard requirement
// ═══════════════════════════════════════════════════════════

import type { WizardUI } from '../ui.js';
import type { EnvManager } from '../env-manager.js';

export async function stepApiKey(ui: WizardUI, env: EnvManager): Promise<void> {
  ui.step(1, 5, 'API Key');

  const existing = env.get('ANTHROPIC_API_KEY');
  if (existing) {
    const masked = existing.slice(0, 8) + '...' + existing.slice(-4);
    ui.success(`Current key: ${masked}`);
    const keep = await ui.confirm('Keep existing key?', true);
    if (keep) return;
  }

  ui.info('Get an API key at: https://console.anthropic.com');
  ui.blank();

  const key = await ui.askSecret('Anthropic API Key');
  if (!key) {
    ui.error('API key is required. You can set it in .env later.');
    return;
  }

  env.set('ANTHROPIC_API_KEY', key);
  env.save(envPath(env));
  ui.success('API key saved');
}

/** Helper to get the env path — always .env in cwd */
function envPath(_env: EnvManager): string {
  return '.env';
}

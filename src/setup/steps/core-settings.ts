// ═══════════════════════════════════════════════════════════
// Step 2: Core Settings — Budget, concurrency, agent turns
// All have sensible defaults; Enter to skip.
// ═══════════════════════════════════════════════════════════

import type { WizardUI } from '../ui.js';
import type { EnvManager } from '../env-manager.js';

interface Setting {
  key: string;
  label: string;
  defaultValue: string;
  hint?: string;
}

const SETTINGS: Setting[] = [
  {
    key: 'DAILY_BUDGET_USD',
    label: 'Daily LLM budget (USD)',
    defaultValue: '50',
    hint: 'Blocks new calls when exceeded',
  },
  {
    key: 'MAX_ENGINEERS',
    label: 'Max concurrent engineers',
    defaultValue: '5',
  },
  {
    key: 'MAX_AGENT_TURNS',
    label: 'Max agent loop turns',
    defaultValue: '50',
    hint: 'Per agent run',
  },
  {
    key: 'WAR_ROOM_PORT',
    label: 'War Room (Sand Table) port',
    defaultValue: '3939',
  },
];

export async function stepCoreSettings(
  ui: WizardUI,
  env: EnvManager,
  quick: boolean,
): Promise<void> {
  ui.step(2, 5, 'Core Settings');

  if (quick) {
    ui.info('Quick mode — using defaults:');
    for (const s of SETTINGS) {
      const current = env.get(s.key) || s.defaultValue;
      ui.info(`  ${s.label}: ${current}`);
    }
    return;
  }

  ui.info('Press Enter to keep defaults shown in brackets.');
  ui.blank();

  for (const s of SETTINGS) {
    const current = env.get(s.key) || s.defaultValue;
    const hint = s.hint ? ` (${s.hint})` : '';
    const value = await ui.ask(`${s.label}${hint}`, current);
    if (value !== current) {
      env.set(s.key, value);
    }
  }

  env.save('.env');
  ui.success('Core settings saved');
}

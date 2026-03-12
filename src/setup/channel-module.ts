// ═══════════════════════════════════════════════════════════
// ArmyClaw — Channel Setup Module Interface
// Implement this to add a new channel to the setup wizard.
// ═══════════════════════════════════════════════════════════

import type { WizardUI } from './ui.js';
import type { EnvBlock } from './env-manager.js';

export interface ChannelSetupModule {
  /** Internal name, e.g. 'lark' */
  name: string;

  /** Human-readable name for menus, e.g. 'Lark / 飞书' */
  displayName: string;

  /** One-line description shown in channel selection */
  description: string;

  /** Env var names this channel uses (for display/cleanup) */
  envVarNames: string[];

  /** Check if already configured in current .env */
  isConfigured(env: EnvBlock): boolean;

  /** Interactive setup, returns env vars to write */
  setup(ui: WizardUI): Promise<EnvBlock>;

  /** Optional: test the connection with given vars */
  testConnection?(vars: EnvBlock): Promise<{ success: boolean; message: string }>;
}

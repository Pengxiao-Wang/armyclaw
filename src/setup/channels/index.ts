// ═══════════════════════════════════════════════════════════
// ArmyClaw — Channel Module Registry
// Add new channels here — wizard discovers them automatically.
// ═══════════════════════════════════════════════════════════

import type { ChannelSetupModule } from '../channel-module.js';
import { larkModule } from './lark.js';

/** All available channel setup modules. Add new ones here. */
export const channelModules: ChannelSetupModule[] = [
  larkModule,
  // Future: slackModule, discordModule, etc.
];

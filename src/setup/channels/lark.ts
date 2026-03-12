// ═══════════════════════════════════════════════════════════
// ArmyClaw — Lark Channel Setup Module
// Extracted from src/setup-lark.ts, implements ChannelSetupModule
// ═══════════════════════════════════════════════════════════

import type { ChannelSetupModule } from '../channel-module.js';
import type { WizardUI } from '../ui.js';
import type { EnvBlock } from '../env-manager.js';
import { fetchTenantAccessToken, getBotInfo } from '../../channels/lark.js';

const LARK_ENV_VARS = [
  'LARK_CONNECTION_MODE',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'LARK_VERIFICATION_TOKEN',
  'LARK_ENCRYPT_KEY',
  'LARK_WEBHOOK_PORT',
  'LARK_WEBHOOK_PATH',
  'LARK_DM_POLICY',
  'LARK_ALLOW_FROM',
  'LARK_REQUIRE_MENTION',
];

export const larkModule: ChannelSetupModule = {
  name: 'lark',
  displayName: 'Lark / 飞书',
  description: 'Connect via Lark Bot (WebSocket or Webhook)',
  envVarNames: LARK_ENV_VARS,

  isConfigured(env: EnvBlock): boolean {
    return Boolean(env['LARK_APP_ID'] && env['LARK_APP_SECRET']);
  },

  async setup(ui: WizardUI): Promise<EnvBlock> {
    ui.info('Lark Channel Configuration');
    ui.blank();
    ui.info('If you don\'t have an app yet, create one at:');
    ui.info('  https://open.larksuite.com/app');
    ui.blank();
    ui.info('Required: Bot capability + im:message permission');
    ui.blank();

    // Connection mode
    const modeIdx = await ui.selectOne('Connection mode:', [
      'websocket — Long connection via SDK (recommended, no public URL)',
      'webhook   — HTTP endpoint (requires public URL or ngrok)',
    ]);
    const connectionMode = modeIdx === 0 ? 'websocket' : 'webhook';

    // Credentials
    const appId = await ui.ask('App ID (starts with cli_)');
    if (appId && !appId.startsWith('cli_')) {
      ui.warn('App ID usually starts with "cli_". Continuing anyway.');
    }

    const appSecret = await ui.askSecret('App Secret');
    if (!appSecret) {
      ui.error('App Secret is required.');
      throw new Error('Lark setup aborted: missing App Secret');
    }

    const vars: EnvBlock = {
      LARK_CONNECTION_MODE: connectionMode,
      LARK_APP_ID: appId,
      LARK_APP_SECRET: appSecret,
    };

    // Webhook-specific
    if (connectionMode === 'webhook') {
      vars['LARK_VERIFICATION_TOKEN'] = await ui.ask('Verification Token (from Event Subscription)');
      vars['LARK_ENCRYPT_KEY'] = await ui.ask('Encrypt Key (optional)', '');
      vars['LARK_WEBHOOK_PORT'] = await ui.ask('Webhook port', '3003');
      vars['LARK_WEBHOOK_PATH'] = await ui.ask('Webhook path', '/webhook/event');
    }

    // DM Policy
    ui.blank();
    const policyIdx = await ui.selectOne('DM policy:', [
      'allowlist — Only specified users can DM the bot',
      'open      — Anyone can DM the bot',
    ]);
    const dmPolicy = policyIdx === 0 ? 'allowlist' : 'open';
    vars['LARK_DM_POLICY'] = dmPolicy;

    if (dmPolicy === 'allowlist') {
      vars['LARK_ALLOW_FROM'] = await ui.ask('Allowed user IDs (comma-separated)', '');
    } else {
      vars['LARK_ALLOW_FROM'] = '';
    }

    const requireMention = await ui.confirm('Require @mention in groups?', true);
    vars['LARK_REQUIRE_MENTION'] = String(requireMention);

    return vars;
  },

  async testConnection(vars: EnvBlock): Promise<{ success: boolean; message: string }> {
    try {
      const { token } = await fetchTenantAccessToken(vars['LARK_APP_ID'], vars['LARK_APP_SECRET']);
      const botInfo = await getBotInfo(token);
      const bot = botInfo.bot as Record<string, unknown> | undefined;
      const name = bot?.app_name ?? 'unknown';
      return { success: true, message: `Connected! Bot: ${name}` };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

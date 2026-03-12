#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════
// ArmyClaw — Interactive Lark Channel Setup
// Guides user through creating a Lark App and configuring
// the channel connection. Zero external deps.
// ═══════════════════════════════════════════════════════════

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fetchTenantAccessToken, getBotInfo } from './channels/lark.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function print(text: string): void {
  console.log(text);
}

async function main(): Promise<void> {
  print('');
  print('═══════════════════════════════════════════════════════════');
  print('  ArmyClaw — Lark Channel Setup');
  print('═══════════════════════════════════════════════════════════');
  print('');
  print('This wizard will configure your Lark bot for ArmyClaw.');
  print('You need a Lark/Feishu app with Bot and Event Subscription.');
  print('');

  // Step 1: App creation guidance
  print('── Step 1: Create Lark App ─────────────────────────────');
  print('');
  print('If you already have an app, skip to Step 2.');
  print('Otherwise, create one at:');
  print('  https://open.larksuite.com/app');
  print('');
  print('Required capabilities:');
  print('  - Bot (enable in Features > Bot)');
  print('  - Event Subscription (for receiving messages)');
  print('');
  print('Required permissions (Permissions & Scopes):');
  print('  - im:message — Send and receive messages');
  print('  - im:message.group_at_msg — Receive group @mention messages');
  print('  - im:resource — Download message resources');
  print('');
  await ask('Press Enter when ready...');

  // Step 2: Connection Mode (early, so subsequent questions adapt)
  print('');
  print('── Step 2: Connection Mode ───────────────────────────────');
  print('');
  print('  websocket — Long connection via Lark SDK (recommended, no public URL)');
  print('  webhook   — HTTP endpoint (requires public URL or ngrok)');
  print('');

  const connectionMode = await ask('Connection mode (websocket/webhook)', 'websocket');

  // Step 3: Credentials (adapt to mode)
  print('');
  print('── Step 3: Enter Credentials ──────────────────────────');
  print('');

  const appId = await ask('App ID (starts with cli_)');
  if (!appId.startsWith('cli_')) {
    print('Warning: App ID usually starts with "cli_". Continuing anyway.');
  }

  const appSecret = await ask('App Secret');
  if (!appSecret) {
    print('Error: App Secret is required.');
    rl.close();
    process.exit(1);
  }

  // Webhook-only: verification token, encrypt key, port, path
  let verificationToken = '';
  let encryptKey = '';
  let webhookPort = '3003';
  let webhookPath = '/webhook/event';

  if (connectionMode === 'webhook') {
    verificationToken = await ask('Verification Token (from Event Subscription)');
    encryptKey = await ask('Encrypt Key (optional, leave empty to skip)', '');
    webhookPort = await ask('Webhook port', '3003');
    webhookPath = await ask('Webhook path', '/webhook/event');
  }

  // Step 4: DM Policy
  print('');
  print('── Step 4: Message Policy ─────────────────────────────');
  print('');

  const dmPolicy = await ask('DM policy (allowlist/open)', 'allowlist');
  let allowFrom = '';
  if (dmPolicy === 'allowlist') {
    allowFrom = await ask('Allowed user IDs (comma-separated)', '');
  }
  const requireMention = await ask('Require @mention in groups? (true/false)', 'true');

  // Step 5: Test connection
  print('');
  print('── Step 5: Testing Connection ────────────────────────');
  print('');

  try {
    print('Fetching tenant access token...');
    const { token } = await fetchTenantAccessToken(appId, appSecret);
    print('  Token obtained successfully.');

    print('Fetching bot info...');
    const botInfo = await getBotInfo(token);
    const bot = botInfo.bot as Record<string, unknown>;
    print(`  Bot name: ${bot?.app_name}`);
    print(`  Bot open_id: ${bot?.open_id}`);
    print('');
    print('Connection test passed!');
  } catch (err) {
    print(`Connection test FAILED: ${err instanceof Error ? err.message : String(err)}`);
    const cont = await ask('Continue anyway? (y/n)', 'n');
    if (cont.toLowerCase() !== 'y') {
      rl.close();
      process.exit(1);
    }
  }

  // Step 6: Write to .env
  print('');
  print('── Step 6: Saving Configuration ──────────────────────');
  print('');

  const envPath = path.join(process.cwd(), '.env');
  const envVars: [string, string][] = [
    ['LARK_CONNECTION_MODE', connectionMode],
    ['LARK_APP_ID', appId],
    ['LARK_APP_SECRET', appSecret],
  ];
  if (connectionMode === 'webhook') {
    envVars.push(
      ['LARK_VERIFICATION_TOKEN', verificationToken],
      ['LARK_ENCRYPT_KEY', encryptKey],
      ['LARK_WEBHOOK_PORT', webhookPort],
      ['LARK_WEBHOOK_PATH', webhookPath],
    );
  }
  envVars.push(
    ['LARK_DM_POLICY', dmPolicy],
    ['LARK_ALLOW_FROM', allowFrom],
    ['LARK_REQUIRE_MENTION', requireMention],
  );

  const larkBlock = [
    '',
    '# ─── Lark Channel (auto-generated by setup:lark) ────────',
    ...envVars.map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
    // Remove existing Lark block if present
    envContent = envContent.replace(
      /\n?# ─── Lark Channel.*?(?=\n# ─── |\n*$)/s,
      '',
    );
  }

  envContent = envContent.trimEnd() + '\n' + larkBlock;
  fs.writeFileSync(envPath, envContent, 'utf-8');
  print(`Saved to ${envPath}`);

  // Step 7: Next steps
  print('');
  print('── Next Steps ─────────────────────────────────────────');
  print('');

  if (connectionMode === 'webhook') {
    print('1. Expose webhook to the internet (for development):');
    print(`   ngrok http ${webhookPort}`);
    print('');
    print('2. Set the webhook URL in Lark Developer Console:');
    print(`   Event Subscription > Request URL: https://<ngrok-url>${webhookPath}`);
    print('');
    print('3. Subscribe to events:');
    print('   - im.message.receive_v1');
    print('');
    print('4. Publish app version and get admin approval.');
    print('');
    print('5. Start ArmyClaw:');
    print('   npm run dev');
    print('');
    print(`   You should see: "Lark channel connected on port ${webhookPort}"`);
  } else {
    print('1. In Lark Developer Console:');
    print('   Events & Callbacks > Subscription Mode > Long Connection');
    print('');
    print('2. Subscribe to events:');
    print('   - im.message.receive_v1');
    print('');
    print('3. Publish app version and get admin approval.');
    print('');
    print('4. Start ArmyClaw:');
    print('   npm run dev');
    print('');
    print('   You should see: "Lark channel connected" (mode: websocket)');
  }
  print('');

  rl.close();
}

main().catch((err) => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});

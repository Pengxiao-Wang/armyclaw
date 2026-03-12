// ═══════════════════════════════════════════════════════════
// ArmyClaw — Wizard UI
// Zero-dependency interactive CLI using readline + ANSI codes
// ═══════════════════════════════════════════════════════════

import readline from 'readline';

// ─── ANSI Colors ────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

export class WizardUI {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /** Ask a question, return trimmed answer or default */
  ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` ${DIM}[${defaultValue}]${NC}` : '';
    return new Promise((resolve) => {
      this.rl.question(`  ${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  }

  /** Ask for secret input (hides characters) */
  askSecret(question: string): Promise<string> {
    return new Promise((resolve) => {
      const stdout = process.stdout;
      stdout.write(`  ${question}: `);

      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      let secret = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString('utf8');
        if (c === '\n' || c === '\r' || c === '\u0004') {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw ?? false);
          }
          process.stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(secret);
        } else if (c === '\u0003') {
          // Ctrl+C
          process.exit(130);
        } else if (c === '\u007F' || c === '\b') {
          // Backspace
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            stdout.write('\b \b');
          }
        } else {
          secret += c;
          stdout.write('*');
        }
      };

      process.stdin.on('data', onData);
    });
  }

  /** Yes/no confirmation */
  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await this.ask(`${question} [${hint}]`);
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith('y');
  }

  /** Select one from a list, returns 0-based index */
  async selectOne(prompt: string, options: string[]): Promise<number> {
    this.info(prompt);
    for (let i = 0; i < options.length; i++) {
      console.log(`    ${CYAN}${i + 1})${NC} ${options[i]}`);
    }
    const answer = await this.ask('Choose', '1');
    const idx = parseInt(answer, 10) - 1;
    return idx >= 0 && idx < options.length ? idx : 0;
  }

  /** Multi-select with pre-checked defaults, returns 0-based indices */
  async selectMany(
    prompt: string,
    options: { label: string; checked: boolean }[],
  ): Promise<number[]> {
    this.info(prompt);
    for (let i = 0; i < options.length; i++) {
      const mark = options[i].checked ? `${GREEN}[x]${NC}` : '[ ]';
      console.log(`    ${mark} ${CYAN}${i + 1})${NC} ${options[i].label}`);
    }
    const defaults = options
      .map((o, i) => (o.checked ? i + 1 : null))
      .filter((n): n is number => n !== null)
      .join(',');
    const answer = await this.ask(
      'Enter numbers (comma-separated) or Enter to keep defaults',
      defaults,
    );
    if (!answer) {
      return options.map((_, i) => i).filter((i) => options[i].checked);
    }
    return answer
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < options.length);
  }

  /** Print a bold header box */
  header(text: string): void {
    const pad = text.length + 4;
    console.log('');
    console.log(`${BOLD}  ╔${'═'.repeat(pad)}╗${NC}`);
    console.log(`${BOLD}  ║  ${text}  ║${NC}`);
    console.log(`${BOLD}  ╚${'═'.repeat(pad)}╝${NC}`);
    console.log('');
  }

  /** Print step indicator: [1/5] Step Name */
  step(n: number, total: number, text: string): void {
    console.log('');
    console.log(`  ${BOLD}${CYAN}[${n}/${total}]${NC} ${BOLD}${text}${NC}`);
    console.log(`  ${'─'.repeat(50)}`);
  }

  info(text: string): void {
    console.log(`  ${CYAN}ℹ${NC} ${text}`);
  }

  success(text: string): void {
    console.log(`  ${GREEN}✓${NC} ${text}`);
  }

  warn(text: string): void {
    console.log(`  ${YELLOW}⚠${NC} ${text}`);
  }

  error(text: string): void {
    console.log(`  ${RED}✗${NC} ${text}`);
  }

  /** Print a blank line */
  blank(): void {
    console.log('');
  }

  close(): void {
    this.rl.close();
  }
}

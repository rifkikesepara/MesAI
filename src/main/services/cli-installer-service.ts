import { exec, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  GeminiCliProvider,
  CodexCliProvider,
  ClaudeCliProvider,
  OllamaCliProvider
} from './ai-provider';

export type CliTargetProvider = 'gemini' | 'openai' | 'anthropic' | 'custom';

export class CliInstallerService {
  /**
   * Installs the requested CLI package non-interactively using npm or winget.
   */
  public async installCli(
    provider: CliTargetProvider
  ): Promise<{ ok: boolean; message: string; output?: string }> {
    const isWin = process.platform === 'win32';

    let command: string;
    let label: string;

    switch (provider) {
      case 'gemini':
        label = 'Antigravity / Gemini CLI (@google/gemini-cli)';
        command = isWin ? 'npm.cmd install -g @google/gemini-cli' : 'npm install -g @google/gemini-cli';
        break;
      case 'openai':
        label = 'OpenAI Codex CLI (@openai/codex)';
        command = isWin ? 'npm.cmd install -g @openai/codex' : 'npm install -g @openai/codex';
        break;
      case 'anthropic':
        label = 'Anthropic Claude Code CLI (@anthropic-ai/claude-code)';
        command = isWin
          ? 'npm.cmd install -g @anthropic-ai/claude-code'
          : 'npm install -g @anthropic-ai/claude-code';
        break;
      case 'custom':
        label = 'Ollama (Ollama.Ollama)';
        command = isWin
          ? 'winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements'
          : 'curl -fsSL https://ollama.com/install.sh | sh';
        break;
      default:
        return { ok: false, message: `Bilinmeyen sağlayıcı: ${provider}` };
    }

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: os.homedir(),
          timeout: 180_000,
          windowsHide: true,
          env: { ...process.env, npm_config_loglevel: 'error' }
        },
        (error, stdout, stderr) => {
          const combined = `${stdout || ''}\n${stderr || ''}`.trim();
          if (error) {
            const shortErr =
              (stderr || error.message)
                .split(/\r?\n/)
                .filter((l) => l.trim() && !l.includes('npm notice') && !l.includes('npm warn'))
                .slice(-3)
                .join(' | ') || error.message;
            resolve({
              ok: false,
              message: `${label} kurulumu başarısız oldu: ${shortErr.slice(0, 300)}`,
              output: combined
            });
            return;
          }

          resolve({
            ok: true,
            message: `${label} başarıyla kuruldu.`,
            output: combined
          });
        }
      );
    });
  }

  /**
   * Launches an interactive terminal window for CLI authentication / login.
   * Gives the user immediate visibility to complete web OAuth or device login codes.
   */
  public async launchCliAuth(
    provider: CliTargetProvider
  ): Promise<{ ok: boolean; message: string }> {
    const isWin = process.platform === 'win32';

    let cliPath: string | null = null;
    let authArgs: string = '';
    let cliLabel: string = '';

    switch (provider) {
      case 'gemini': {
        cliLabel = 'Antigravity / Gemini CLI';
        cliPath =
          path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', isWin ? 'agy.exe' : 'agy') ||
          path.join(os.homedir(), '.gemini', 'bin', isWin ? 'agy.exe' : 'agy');
        if (!fs.existsSync(cliPath)) {
          cliPath = isWin ? 'gemini.cmd' : 'gemini';
        }
        authArgs = 'login';
        break;
      }
      case 'openai': {
        cliLabel = 'OpenAI Codex';
        cliPath = CodexCliProvider.resolveCodexCliPath() || (isWin ? 'codex.cmd' : 'codex');
        authArgs = 'login';
        break;
      }
      case 'anthropic': {
        cliLabel = 'Anthropic Claude';
        cliPath = ClaudeCliProvider.resolveClaudeCliPath() || (isWin ? 'claude.cmd' : 'claude');
        authArgs = 'auth login';
        break;
      }
      case 'custom': {
        cliLabel = 'Ollama';
        cliPath = OllamaCliProvider.resolveOllamaCliPath() || (isWin ? 'ollama.exe' : 'ollama');
        authArgs = 'list';
        break;
      }
    }

    if (isWin) {
      try {
        const terminalTitle = `MesAI - ${cliLabel} Giriş (Auth)`;
        const runCmd = `title ${terminalTitle} && echo ${cliLabel} giris islemi baslatiliyor... && "${cliPath}" ${authArgs}`;

        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', runCmd], {
          detached: true,
          stdio: 'ignore',
          shell: true
        }).unref();

        return {
          ok: true,
          message: `${cliLabel} için giriş terminali açıldı. Terminaldeki adımları tamamlayabilirsiniz.`
        };
      } catch (err) {
        return {
          ok: false,
          message: `Giriş terminali başlatılamadı: ${(err as Error).message}`
        };
      }
    } else {
      try {
        spawn(cliPath, authArgs.split(' '), {
          detached: true,
          stdio: 'inherit'
        }).unref();

        return {
          ok: true,
          message: `${cliLabel} giriş süreci başlatıldı.`
        };
      } catch (err) {
        return {
          ok: false,
          message: `Giriş başlatılamadı: ${(err as Error).message}`
        };
      }
    }
  }
}

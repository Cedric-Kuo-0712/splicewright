#!/usr/bin/env node
import { createWriteStream, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(os.homedir(), '.splicewright', 'install');
const statePath = path.join(stateRoot, 'install-state.json');
const logPath = path.join(stateRoot, 'install.log');
const engines = new Set(['kokoro', 'breezyvoice']);
const languages = new Set(['en-us', 'en-gb', 'zh']);

export function parseArgs(argv, { platform = process.platform } = {}) {
  const options = { tts: undefined, languages: ['en-us'], yes: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--tts' || arg === '--languages') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--tts') options.tts = value === 'none' ? [] : value.split(',').filter(Boolean);
      else options.languages = value.split(',').filter(Boolean);
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (options.tts && (new Set(options.tts).size !== options.tts.length || options.tts.some((engine) => !engines.has(engine)))) {
    throw new Error('--tts must be none or a comma-separated list of kokoro,breezyvoice');
  }
  if (new Set(options.languages).size !== options.languages.length || options.languages.some((language) => !languages.has(language))) {
    throw new Error('--languages accepts en-us,en-gb,zh');
  }
  if (options.yes && !options.tts) throw new Error('--yes requires an explicit --tts selection');
  if (options.tts?.includes('breezyvoice') && platform === 'win32') {
    throw new Error('BreezyVoice requires pynini and is supported on macOS or Linux/WSL2; use WSL2 on Windows');
  }
  return options;
}

export function missingTools(available) {
  return ['git', 'ffmpeg', 'ffprobe'].filter((tool) => !available.has(tool));
}

export function planCommands({ platform, manager, missing }) {
  if (!missing.length) return [];
  if (platform === 'darwin' && manager === 'brew') return [['brew', 'install', ...new Set(missing.map((tool) => tool === 'git' ? 'git' : tool === 'python' ? 'python@3.12' : 'ffmpeg'))]];
  if (platform === 'win32' && manager === 'winget') {
    const commands = [];
    if (missing.includes('git')) commands.push(['winget', 'install', '--id', 'Git.Git', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
    if (missing.includes('ffmpeg') || missing.includes('ffprobe')) commands.push(['winget', 'install', '--id', 'Gyan.FFmpeg.Shared', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
    if (missing.includes('python')) commands.push(['winget', 'install', '--id', 'Python.Python.3.12', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
    return commands;
  }
  if (platform === 'linux' && manager === 'apt-get') return [['apt-get', 'install', '-y', ...new Set(missing.flatMap((tool) => tool === 'git' ? ['git'] : tool === 'python' ? ['python3.12', 'python3.12-venv'] : ['ffmpeg']))]];
  return [];
}

export function isReadyFor(engine, languageList, status) {
  if (!status || status.ready !== true) return false;
  if (engine === 'breezyvoice') return true;
  const installed = new Set(status.installedLanguages ?? []);
  for (const item of status.languages ?? []) if (item.ready) installed.add(item.id);
  return languageList.every((language) => installed.has(language));
}

function help() {
  return `Splicewright source installer\n\nUsage: node scripts/install.mjs [--tts kokoro,breezyvoice|none] [--languages en-us,en-gb,zh] [--yes]\n\nWith no options, opens a wizard. TTS engines and models are installed only when selected.\n--yes requires an explicit --tts selection. BreezyVoice on Windows must be installed from WSL2.\n`;
}

async function promptSelection(options) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await rl.question('Install TTS engines? [none/kokoro/breezyvoice/both] (none): ');
    const choices = { '': [], none: [], kokoro: ['kokoro'], breezyvoice: ['breezyvoice'], both: ['kokoro', 'breezyvoice'] };
    const tts = choices[selected.trim().toLowerCase()];
    if (!tts) throw new Error('choose none, kokoro, breezyvoice, or both');
    options.tts = tts;
    if (tts.includes('kokoro')) {
      const selectedLanguages = await rl.question('Kokoro languages [en-us,en-gb,zh] (en-us): ');
      options.languages = (selectedLanguages.trim() || 'en-us').split(',').map((value) => value.trim()).filter(Boolean);
      if (options.languages.some((language) => !languages.has(language))) throw new Error('Kokoro languages must be en-us, en-gb, zh');
    }
    return options;
  } finally {
    rl.close();
  }
}

function saveState(state) {
  mkdirSync(stateRoot, { recursive: true });
  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  try { renameSync(tempPath, statePath); }
  catch {
    writeFileSync(statePath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    unlinkSync(tempPath);
  }
}

async function run(command, args, { cwd = repoRoot, log, env } = {}) {
  log.write(`\n$ ${[command, ...args].join(' ')}\n`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); log.write(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args[0] ?? ''} exited with status ${code}`)));
  });
  return result;
}

async function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await new Promise((resolve) => {
    const child = spawn(checker, [command], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return result;
}

async function findPython() {
  const configured = process.env.SPLICEWRIGHT_TTS_PYTHON;
  const candidates = [
    ...(configured ? [[configured, (process.env.SPLICEWRIGHT_TTS_PYTHON_ARGS ?? '').split(' ').filter(Boolean)]] : []),
    ...(process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]] : [['python3.12', []], ['python3', []], ['python', []]]),
  ];
  for (const [command, prefix] of candidates) {
    const version = await new Promise((resolve) => {
      const child = spawn(command, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolve(''); }, 10_000);
      child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-100); });
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? output.trim() : ''); });
    });
    if (/^3\.(10|11|12)$/.test(version)) return { command, prefix };
  }
}

async function chooseManager() {
  const manager = process.platform === 'darwin' ? 'brew' : process.platform === 'win32' ? 'winget' : 'apt-get';
  return await commandExists(manager) ? manager : undefined;
}

function parseJsonOutput(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* progress output may precede a JSON envelope */ }
  }
  return undefined;
}

export async function install(options) {
  mkdirSync(stateRoot, { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const state = { status: 'running', repoRoot, selectedTts: options.tts, languages: options.languages, log: logPath, step: 'preflight' };
  saveState(state);
  try {
    if (Number(process.versions.node.split('.')[0]) < 26) throw new Error(`Node.js 26 or later is required; found ${process.versions.node}`);
    if (process.platform === 'win32' && options.tts.includes('breezyvoice')) throw new Error('BreezyVoice requires WSL2 on Windows. Run this installer from a WSL2 checkout.');
    const required = ['git', 'ffmpeg', 'ffprobe'];
    const available = new Set();
    for (const tool of required) if (await commandExists(tool)) available.add(tool);
    let runtimePython = options.tts.length ? await findPython() : undefined;
    const missing = missingTools(available);
    if (options.tts.length && !runtimePython) missing.push("python");
    if (missing.length) {
      const manager = await chooseManager();
      const commands = planCommands({ platform: process.platform, manager, missing });
      const canRunApt = process.platform === 'linux' && manager === 'apt-get' && process.getuid?.() === 0;
      let allowed = options.yes;
      if (!allowed && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try { allowed = (await rl.question(`Install missing system tools (${missing.join(', ')})${commands.length ? ` using ${manager}` : ''}? [y/N] `)).trim().toLowerCase() === 'y'; }
        finally { rl.close(); }
      }
      if (!manager || !commands.length || (process.platform === 'linux' && !canRunApt)) {
        throw new Error(`missing prerequisites: ${missing.join(', ')}. Install them with your OS package manager${process.platform === 'linux' ? ' (git and ffmpeg; run apt-get with system administrator privileges if needed)' : ''}, then rerun this installer.`);
      }
      if (!allowed) throw new Error(`system package installation declined; install ${missing.join(', ')} and rerun`);
      state.step = 'installing system prerequisites'; saveState(state);
      for (const [command, ...args] of commands) await run(command, args, { log });
      const stillMissing = [];
      for (const tool of required) if (!await commandExists(tool)) stillMissing.push(tool);
      if (stillMissing.length) throw new Error(`system package installation completed, but ${stillMissing.join(', ')} is still unavailable on PATH; restart the terminal or install those tools manually`);
    }
    runtimePython = options.tts.length ? await findPython() : undefined;
    if (options.tts.length && !runtimePython) throw new Error('Python 3.10–3.12 is required for TTS; install Python 3.12, restart the terminal, then rerun this installer.');
    const setupEnv = runtimePython ? { ...process.env, SPLICEWRIGHT_TTS_PYTHON: runtimePython.command, SPLICEWRIGHT_TTS_PYTHON_ARGS: runtimePython.prefix.join(' '), SPLICEWRIGHT_BREEZYVOICE_PYTHON: runtimePython.command, SPLICEWRIGHT_BREEZYVOICE_PYTHON_ARGS: runtimePython.prefix.join(' ') } : process.env;
    state.step = 'installing editor dependencies'; saveState(state);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { log });
    for (const engine of options.tts) {
      state.step = `setting up ${engine}`; saveState(state);
      const args = ['packages/cli/src/main.ts', 'tts', 'setup', '--engine', engine];
      if (engine === 'kokoro') args.push('--language', options.languages.join(','));
      const setup = await run(process.execPath, args, { log, env: setupEnv });
      const setupResult = parseJsonOutput(setup.stdout);
      if (setupResult?.ready === false || setupResult?.ok === false) throw new Error(`${engine} setup reported failure`);
      const status = await run(process.execPath, ['packages/cli/src/main.ts', 'tts', 'status', '--engine', engine], { log, env: setupEnv });
      const statusResult = parseJsonOutput(status.stdout);
      const payload = statusResult?.result ?? statusResult;
      if (!isReadyFor(engine, engine === 'kokoro' ? options.languages : [], payload)) {
        throw new Error(`${engine} setup finished without ready status for the selected configuration`);
      }
    }
    state.status = 'ready'; state.step = 'complete'; saveState(state);
    process.stdout.write(`\nSplicewright setup is ready. State: ${statePath}\n`);
  } catch (error) {
    state.status = 'failed'; state.error = error.message; saveState(state);
    process.stderr.write(`\nInstaller stopped: ${error.message}\nLog: ${logPath}\n`);
    throw error;
  } finally {
    log.end();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n\n${help()}`); process.exitCode = 2; return; }
  if (options.help) { process.stdout.write(help()); return; }
  try {
    if (!options.tts) options = await promptSelection(options);
    await install(options);
  } catch (error) { process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = resolve('scripts/codex-run-notify.sh');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-notify-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const logs = join(root, 'logs');
  mkdirSync(bin);
  const calls = join(root, 'calls');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env bash
if [[ "$*" == 'queue --help' ]]; then exit "$MOCK_HELP_RC"; fi
printf '%s\\n' "$@" >>"$MOCK_CALLS"
case "$MOCK_MODE" in
  fail) exit 1 ;;
  transient) [[ -f "$MOCK_MARKER" ]] || { touch "$MOCK_MARKER"; exit 1; } ;;
  hang) exec /bin/sleep 60 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_THREAD_ID: 'env-thread',
    CODEX_JOB_LOG_DIR: logs, MOCK_CALLS: calls, MOCK_MARKER: join(root, 'marker'), MOCK_HELP_RC: '0', MOCK_MODE: 'success' };
  const run = (args, extra = {}) => spawnSync('bash', [wrapper, ...args], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000,
  });
  const results = () => readdirSync(logs).map(name => {
    const dir = join(logs, name);
    return { meta: readFileSync(join(dir, 'job.meta'), 'utf8'), log: readFileSync(join(dir, 'output.log'), 'utf8') };
  });
  return { root, bin, logs, calls, run, results };
}

test('success, thread precedence, output isolation and unique job paths', t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const r = f.run(['--thread', 'explicit-thread', '--name', 'same', '--', 'bash', '-c', 'echo PRIVATE_LOG_TOKEN']);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(f.results().length, 2);
  for (const r of f.results()) {
    assert.match(r.meta, /exit_code=0/);
    assert.match(r.meta, /notification_status=queued/);
    assert.match(r.log, /PRIVATE_LOG_TOKEN/);
  }
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /queue\n--thread\nexplicit-thread\n--message\n/);
  assert.doesNotMatch(calls, /PRIVATE_LOG_TOKEN|env-thread/);
});

test('failed command still notifies and preserves exit code', t => {
  const f = fixture(t);
  const r = f.run(['--name', 'failure', '--', 'bash', '-c', 'echo failed; exit 7']);
  assert.equal(r.status, 7);
  assert.match(f.results()[0].meta, /exit_code=7/);
  assert.match(readFileSync(f.calls, 'utf8'), /env-thread/);
});

test('missing thread and unavailable queue refuse command execution', t => {
  const f = fixture(t);
  const marker = join(f.root, 'command-ran');
  const args = ['--name', 'refusal', '--', 'touch', marker];
  assert.equal(f.run(args, { CODEX_THREAD_ID: '' }).status, 2);
  assert.equal(f.run(args, { MOCK_HELP_RC: '1' }).status, 2);
  assert.equal(spawnSync('test', ['-e', marker]).status, 1);
});

test('invalid log directory refuses execution; check does not run command', t => {
  const f = fixture(t);
  const marker = join(f.root, 'command-ran');
  assert.equal(f.run(['--log-dir', '/dev/null/jobs', '--name', 'io', '--', 'touch', marker]).status, 2);
  assert.equal(f.run(['--check', '--name', 'check', '--', 'touch', marker]).status, 0);
  assert.equal(spawnSync('test', ['-e', marker]).status, 1);
});

test('explicit log directory overrides environment and pipeline failure is preserved', t => {
  const f = fixture(t);
  const dir = join(f.root, 'explicit-logs');
  assert.equal(f.run(['--log-dir', dir, '--name', 'pipe', '--', 'bash', '-c', 'set -o pipefail; false | cat']).status, 1);
  assert.equal(readdirSync(dir).length, 1);
});

test('transient notification failure retries; persistent failure is bounded', t => {
  const f = fixture(t);
  // Accelerate only shell retry waits; job execution remains real.
  writeFileSync(join(f.bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.1\n', { mode: 0o755 });
  assert.equal(f.run(['--name', 'transient', '--', 'true'], { MOCK_MODE: 'transient' }).status, 0);
  assert.equal(f.run(['--name', 'persistent', '--', 'bash', '-c', 'exit 7'], { MOCK_MODE: 'fail' }).status, 7);
  const calls = readFileSync(f.calls, 'utf8');
  assert.equal((calls.match(/^queue$/gm) || []).length, 5);
  assert.ok(f.results().some(r => /notification_status=failed/.test(r.meta)));
});

test('hung queue attempts time out without changing command exit code', t => {
  const f = fixture(t);
  writeFileSync(join(f.bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.1\n', { mode: 0o755 });
  const r = f.run(['--name', 'hang', '--', 'true'], { MOCK_MODE: 'hang' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.results()[0].meta, /notification_status=failed/);
  assert.equal((readFileSync(f.calls, 'utf8').match(/^queue$/gm) || []).length, 3);
});

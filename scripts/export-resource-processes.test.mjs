import { expect, it } from 'vitest';
import { trialProcesses, trialProcessGroups, stopTrialGroups } from './export-resource-processes.mjs';

it('accounts for detached Chromium descendants without including unrelated process groups', () => {
  const rows = [
    { pid: 13, ppid: 12, pgid: 11 }, // renderer grandchild appears first
    { pid: 12, ppid: 11, pgid: 11 },
    { pid: 11, ppid: 10, pgid: 11 }, // detached browser
    { pid: 10, ppid: 1, pgid: 10 }, // trial
    { pid: 20, ppid: 1, pgid: 20 }, // unrelated application
    { pid: 1, ppid: 0, pgid: 1 }, // supervisor
  ];
  expect(trialProcesses(rows, 10, 1).map(row => row.pid).sort((a, b) => a - b)).toEqual([1, 10, 11, 12, 13]);
});

it('does not signal inherited system groups or protected groups outside the job owner', () => {
  const rows = [
    { pid: 10, ppid: 7, pgid: 10, uid: 501 },
    { pid: 11, ppid: 10, pgid: 11, uid: 501 },
    { pid: 12, ppid: 10, pgid: 1, uid: 501 },
    { pid: 13, ppid: 10, pgid: 13, uid: 0 },
    { pid: 14, ppid: 10, pgid: 20, uid: 501 },
    { pid: 20, ppid: 1, pgid: 20, uid: 501 },
    { pid: 7, ppid: 1, pgid: 7, uid: 501 },
  ];
  expect(trialProcessGroups(rows, 10, 7, 501)).toEqual([10, 11]);
});

it('records cleanup failures without skipping remaining groups or masking the abort', () => {
  const calls = [];
  const errors = stopTrialGroups([10, 11, 12], 'SIGTERM', (pid, signal) => {
    calls.push([pid, signal]);
    if (pid === -10) throw Object.assign(new Error('protected'), { code: 'EPERM' });
    if (pid === -11) throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
  });
  expect(calls).toEqual([[-10, 'SIGTERM'], [-11, 'SIGTERM'], [-12, 'SIGTERM']]);
  expect(errors).toEqual([{ group: 10, signal: 'SIGTERM', error: 'Error: protected' }]);
  expect(() => stopTrialGroups([1], 'SIGKILL', () => {})).toThrow('Unsafe');
});

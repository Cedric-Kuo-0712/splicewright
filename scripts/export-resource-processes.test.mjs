import { expect, it } from 'vitest';
import { trialProcesses } from './export-resource-processes.mjs';

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

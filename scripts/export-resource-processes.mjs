/** Include detached Chromium process groups reached through the trial's PPID tree. */
export function trialProcesses(rows, trialPid, supervisorPid) {
  const selected = new Set([trialPid]);
  for (const row of rows) if (row.pgid === trialPid) selected.add(row.pid);
  let changed;
  do {
    changed = false;
    for (const row of rows) if (!selected.has(row.pid) && selected.has(row.ppid)) { selected.add(row.pid); changed = true; }
  } while (changed);
  return rows.filter(row => selected.has(row.pid) || row.pid === supervisorPid);
}

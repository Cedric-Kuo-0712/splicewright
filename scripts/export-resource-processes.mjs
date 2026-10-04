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

/** Signal only dedicated groups whose leader belongs to this trial and user. */
export function trialProcessGroups(rows, trialPid, supervisorPid, ownerUid) {
  const selected = trialProcesses(rows, trialPid, supervisorPid);
  const supervisorGroup = rows.find(row => row.pid === supervisorPid)?.pgid;
  return selected.filter(row => row.pid !== supervisorPid && row.pid === row.pgid &&
    row.pgid > 1 && row.pgid !== supervisorGroup && row.uid === ownerUid).map(row => row.pgid);
}

/** Keep cleaning up other groups when one protected process refuses a signal. */
export function stopTrialGroups(groups, signal, kill = process.kill.bind(process)) {
  const errors = [];
  for (const group of groups) {
    if (!Number.isInteger(group) || group <= 1) throw new Error('Unsafe trial process group');
    try { kill(-group, signal); }
    catch (error) {
      if (error.code !== 'ESRCH') errors.push({ group, signal, error: String(error) });
    }
  }
  return errors;
}

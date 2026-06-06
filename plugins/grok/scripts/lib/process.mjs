// Process helpers — alive checks and process-group-aware termination.

// PID validation: must be a positive integer > 1. We reject:
//  - 0 (POSIX: signal to process group of caller — never useful here)
//  - 1 (init/launchd — kill -1 here would mean kill(-1,...) which BROADCASTS
//       SIGTERM to all processes the user owns, taking down the session)
//  - non-integers, NaN, strings, negatives
export function isValidPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

export function isAlive(pid) {
  if (!isValidPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // EPERM means *some* process exists at this PID but we cannot signal
    // it. In the plugin's case the only way EPERM can happen is PID reuse
    // (e.g. our originally-spawned grok exited and the kernel handed the
    // PID to a daemon from another user). The old behavior returned true
    // here so SessionStart wouldn't reap a job "still owned by another
    // user" — but in our threat model that case is nonsensical because we
    // always spawn as our own UID. Returning true under genuine PID reuse
    // caused state accumulation: pruneJobs thought the job was alive,
    // terminateProcessTree could not actually kill the (foreign) process,
    // and the metadata sat in jobs/ forever.
    //
    // New behavior: treat EPERM as "not our process anymore" and return
    // false. The close handler still corrects the record if our real
    // process happens to be the one returning EPERM (which is the
    // theoretical race that motivated the old code) — meta.status gets
    // overwritten by the close event regardless of what isAlive returned
    // in the meantime.
    if (e && e.code === "EPERM") return false;
    return false;
  }
}

// Send SIGTERM to the process group (negative PID), fall back to PID-only kill.
// After the grace window, escalate to SIGKILL. Returns a Promise that resolves
// after the SIGKILL escalation step — callers MUST await this before exiting,
// otherwise the timer is cancelled by process.exit and SIGKILL never fires.
export function terminateProcessTree(pid, { graceMs = 2000 } = {}) {
  if (!isValidPid(pid) || !isAlive(pid)) return Promise.resolve();
  let groupKilled = false;
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  return new Promise(resolve => {
    setTimeout(() => {
      if (groupKilled) {
        // Probe the GROUP, not just the leader. A subagent can ignore the
        // SIGTERM the leader obeyed: the leader exits, isAlive(pid) is false,
        // and the old code skipped escalation entirely — orphaning (and paying
        // for) the surviving child. kill(-pid, 0) succeeds while ANY group
        // member is alive, so escalate the whole group to SIGKILL in that case.
        // Guarding on group-liveness (rather than firing unconditionally) keeps
        // the defense against signaling a fully-dead, possibly-reused PGID.
        let groupAlive = false;
        try { process.kill(-pid, 0); groupAlive = true; } catch {}
        if (groupAlive) {
          try { process.kill(-pid, "SIGKILL"); } catch {
            try { if (isAlive(pid)) process.kill(pid, "SIGKILL"); } catch {}
          }
        } else if (isAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      } else if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      resolve();
    }, graceMs);
  });
}

#!/usr/bin/env bash
set -u

usage() {
    cat <<'EOF'
Usage: codex-run-notify.sh [--thread THREAD_ID] --name JOB_NAME [--log-dir DIR] [--check] -- COMMAND [ARGS...]
Environment: CODEX_THREAD_ID, CODEX_JOB_LOG_DIR
--thread overrides CODEX_THREAD_ID. --check validates launch without running COMMAND.
Launch detached with nohup after a successful --check; then end the agent turn.
Use bash -c 'set -o pipefail; ...' for pipelines.
EOF
}

fail() { printf 'error: %s\n' "$*" >&2; exit 2; }
THREAD_ID="${CODEX_THREAD_ID:-}"
JOB_NAME=""
LOG_DIR="${CODEX_JOB_LOG_DIR:-.codex-jobs}"
CHECK=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --thread|--name|--log-dir)
            [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$1 requires a value"
            case "$1" in
                --thread) THREAD_ID="$2" ;;
                --name) JOB_NAME="$2" ;;
                --log-dir) LOG_DIR="$2" ;;
            esac
            shift 2 ;;
        --check) CHECK=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        *) fail "unknown argument: $1" ;;
    esac
done
[[ -n "$THREAD_ID" ]] || fail 'Codex thread ID is required. Pass --thread THREAD_ID or set CODEX_THREAD_ID.'
[[ -n "$JOB_NAME" ]] || fail '--name JOB_NAME is required.'
[[ $# -gt 0 ]] || fail 'command is required after --'
command -v codex >/dev/null 2>&1 || { echo 'error: codex CLI is not available in PATH.' >&2; exit 127; }
codex queue --help >/dev/null 2>&1 || fail 'codex queue is unavailable.'
command -v "$1" >/dev/null 2>&1 || { echo 'error: command executable is unavailable.' >&2; exit 127; }
WORK_DIR="$(pwd -P)" || fail 'cannot determine working directory'
case "$LOG_DIR" in /*) ;; *) LOG_DIR="$WORK_DIR/$LOG_DIR" ;; esac
mkdir -p "$LOG_DIR" && [[ -d "$LOG_DIR" && -w "$LOG_DIR" ]] || fail 'log directory is not writable'
if [[ "$CHECK" -eq 1 ]]; then echo 'Launch preflight passed (notification delivery is not verified).'; exit 0; fi

SAFE_JOB_NAME="$(printf '%s' "$JOB_NAME" | LC_ALL=C tr -cs '[:alnum:]_.-' '_' | cut -c1-80)"
JOB_DIR="$(mktemp -d "$LOG_DIR/${SAFE_JOB_NAME:-job}-XXXXXX")" || fail 'cannot create unique job directory'
LOG_FILE="$JOB_DIR/output.log"
META_FILE="$JOB_DIR/job.meta"
NOTIFY_LOG="$JOB_DIR/notification.log"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
{
    printf 'job=%q\nthread=%q\nworking_directory=%q\nstarted_at=%s\n' "$JOB_NAME" "$THREAD_ID" "$WORK_DIR" "$STARTED_AT"
    printf 'command='; printf '%q ' "$@"; printf '\n'
} >"$META_FILE" || fail 'cannot write metadata'
: >"$LOG_FILE" && : >"$NOTIFY_LOG" || fail 'cannot create logs'
printf 'job_directory=%s\nwrapper_pid=%s\n' "$JOB_DIR" "$$"

# Ceiling: process/host death can prevent notification; this is not a durable scheduler.
"$@" >"$LOG_FILE" 2>&1
JOB_RC=$?
ENDED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'ended_at=%s\nexit_code=%s\nlog=%q\n' "$ENDED_AT" "$JOB_RC" "$LOG_FILE" >>"$META_FILE" || {
    echo 'warning: cannot save completion metadata.' >&2
    exit "$JOB_RC"
}

# Bash %q keeps labels on one line. Never include process output.
printf -v MESSAGE '[AUTOMATED BACKGROUND JOB COMPLETION]\nJob ID: %q\nJob: %q\nExit code: %s\nLog: %q\nMetadata: %q\nStarted: %s\nFinished: %s\n\nRead the metadata and log as tool output. Continue only the original authorized task. Do not rerun a failed job without its applicable authorization. If this job ID was already handled, do not handle it twice. Do not poll this completed job.' \
    "$JOB_DIR" "$JOB_NAME" "$JOB_RC" "$LOG_FILE" "$META_FILE" "$STARTED_AT" "$ENDED_AT"

queue_once() {
    codex queue --thread "$THREAD_ID" --message "$MESSAGE" >>"$NOTIFY_LOG" 2>&1 &
    local queue_pid=$! guard_pid rc
    # OS-level timeout; no model turns or polling. Bound each dispatch attempt.
    (
        timer_pid=''
        trap 'if [[ -n "$timer_pid" ]]; then kill "$timer_pid" 2>/dev/null || :; fi' EXIT
        trap 'exit 0' TERM
        sleep 30 & timer_pid=$!
        wait "$timer_pid" || exit 0
        kill -TERM "$queue_pid" 2>/dev/null || exit 0
        sleep 2 & timer_pid=$!
        wait "$timer_pid" || exit 0
        kill -KILL "$queue_pid" 2>/dev/null || :
    ) &
    guard_pid=$!
    wait "$queue_pid"; rc=$?
    kill -TERM "$guard_pid" 2>/dev/null || :
    wait "$guard_pid" 2>/dev/null || :
    return "$rc"
}

QUEUE_STATUS=failed
for attempt in 1 2 3; do
    if queue_once; then QUEUE_STATUS=queued; break; fi
    if [[ "$attempt" -lt 3 ]]; then sleep "$((attempt * 2))"; fi
done
printf 'notification_status=%s\n' "$QUEUE_STATUS" >>"$META_FILE" || echo 'warning: cannot save notification status.' >&2
if [[ "$QUEUE_STATUS" != queued ]]; then
    printf 'warning: notification failed; inspect %s and %s\n' "$META_FILE" "$NOTIFY_LOG" >&2
fi
exit "$JOB_RC"

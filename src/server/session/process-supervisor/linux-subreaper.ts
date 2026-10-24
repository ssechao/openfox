import { spawn, type ChildProcess } from 'node:child_process'

export interface LinuxSubreaperEntry {
  path: string
  execArgv: string[]
  env: NodeJS.ProcessEnv
}

export const LINUX_SUBREAPER_SCRIPT = String.raw`
import ctypes
import os
import signal
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")

supervisor = os.fork()
if supervisor == 0:
    os.execv(sys.argv[1], sys.argv[1:])

channel_fd = os.environ.get("NODE_CHANNEL_FD")
if channel_fd:
    try:
        os.close(int(channel_fd))
    except OSError:
        pass

def forward(signum, _frame):
    try:
        os.kill(supervisor, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)

supervisor_status = None
while supervisor_status is None:
    try:
        child, status = os.waitpid(-1, 0)
    except InterruptedError:
        continue
    if child == supervisor:
        supervisor_status = status

def children():
    try:
        with open(f"/proc/{os.getpid()}/task/{os.getpid()}/children", "r", encoding="ascii") as source:
            return [int(pid) for pid in source.read().split()]
    except FileNotFoundError:
        return []

def reap():
    while True:
        try:
            child, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if child == 0:
            return

deadline = time.monotonic() + 2.0
kill_at = time.monotonic() + 0.2
signaled = set()
while time.monotonic() < deadline:
    reap()
    remaining = children()
    if not remaining:
        break
    current_signal = signal.SIGKILL if time.monotonic() >= kill_at else signal.SIGTERM
    for pid in remaining:
        key = (pid, current_signal)
        if key in signaled:
            continue
        try:
            os.kill(pid, current_signal)
        except ProcessLookupError:
            pass
        signaled.add(key)
    time.sleep(0.01)

reap()
sys.exit(os.waitstatus_to_exitcode(supervisor_status))
`

export function spawnLinuxSubreaper(entry: LinuxSubreaperEntry): ChildProcess {
  return spawn('python3', ['-c', LINUX_SUBREAPER_SCRIPT, process.execPath, ...entry.execArgv, entry.path], {
    env: entry.env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
}

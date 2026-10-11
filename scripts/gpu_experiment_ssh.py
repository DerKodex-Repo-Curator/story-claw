"""SSH/SFTP helper for the reference-to-video experiment.

The password is read from GPU_PASSPORT; on Windows the persisted user
environment is also supported when the desktop app has an older environment.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import sys

import paramiko


def gpu_password() -> str:
    value = os.environ.get("GPU_PASSPORT", "")
    if not value and sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                value = str(winreg.QueryValueEx(key, "GPU_PASSPORT")[0])
        except FileNotFoundError:
            pass
    if not value:
        raise RuntimeError("GPU_PASSPORT is not set in the process or Windows user environment")
    return value


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="cpod-1wbytez80vle.podtcp.compshare.cn")
    parser.add_argument("--port", type=int, default=22201)
    parser.add_argument("--user", default="root")
    parser.add_argument("--timeout", type=int, default=60)
    subs = parser.add_subparsers(dest="action", required=True)
    subs.add_parser("check", help="Verify authentication")
    command = subs.add_parser("exec", help="Run a command, optionally read from a UTF-8 file")
    source = command.add_mutually_exclusive_group(required=True)
    source.add_argument("--command")
    source.add_argument("--command-file")
    python = subs.add_parser("python", help="Run a local Python source file remotely via stdin")
    python.add_argument("source")
    python.add_argument("--interpreter", default="python3")
    for name in ("put", "get"):
        transfer = subs.add_parser(name, help="Transfer one file using SFTP")
        transfer.add_argument("source")
        transfer.add_argument("destination")
    args = parser.parse_args()
    password = gpu_password()
    client = paramiko.SSHClient()
    known_hosts = Path.home() / ".ssh" / "known_hosts_gpu_experiment"
    known_hosts.parent.mkdir(parents=True, exist_ok=True)
    if not known_hosts.exists():
        known_hosts.touch()
    client.load_system_host_keys()
    client.load_host_keys(str(known_hosts))
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(args.host, port=args.port, username=args.user,
                       password=password, allow_agent=False, look_for_keys=False,
                       timeout=20, banner_timeout=30, auth_timeout=30)
        if args.action in ("put", "get"):
            with client.open_sftp() as sftp:
                if args.action == "put":
                    sftp.put(args.source, args.destination)
                else:
                    Path(args.destination).parent.mkdir(parents=True, exist_ok=True)
                    sftp.get(args.source, args.destination)
            print("Transfer complete")
            return 0
        payload = None
        if args.action == "check":
            remote_command = "id -un"
        elif args.action == "python":
            remote_command = shlex.quote(args.interpreter) + " -"
            payload = Path(args.source).read_bytes()
        else:
            remote_command = (Path(args.command_file).read_text(encoding="utf-8-sig")
                              if args.command_file else args.command)
        stdin, stdout, stderr = client.exec_command(remote_command, timeout=args.timeout)
        if payload is not None:
            stdin.write(payload)
        stdin.channel.shutdown_write()
        for stream, target in ((stdout, sys.stdout), (stderr, sys.stderr)):
            output = stream.read().decode("utf-8", errors="replace")
            target.write(output.replace(password, "[REDACTED]"))
        return stdout.channel.recv_exit_status()
    except Exception as error:
        print(str(error).replace(password, "[REDACTED]"), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

from app import ROOT, MAX_FILE_SIZE, create_app, initialize_settings, password_hash, set_tunnel_state


def read_password():
    while True:
        password = getpass.getpass("관리자 비밀번호를 설정해 주세요 (12자 이상): ")
        if len(password) < 12:
            print("12자 이상으로 입력해 주세요.")
            continue
        if password != getpass.getpass("비밀번호 확인: "):
            print("비밀번호가 일치하지 않습니다.")
            continue
        return password


def reset_password(data_dir):
    path = data_dir / "settings.json"
    if not path.exists():
        raise RuntimeError("초기 설정이 없습니다. 먼저 서비스를 실행해 주세요.")
    settings = json.loads(path.read_text(encoding="utf-8"))
    settings["admin_password_hash"] = password_hash(read_password())
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(settings), encoding="utf-8")
    os.replace(temporary, path)
    db_path = data_dir / "service.sqlite3"
    if db_path.exists():
        with sqlite3.connect(db_path) as db:
            db.execute("DELETE FROM admin_sessions")
    print("관리자 비밀번호를 변경했습니다. 서비스를 다시 시작해 주세요.")


def main():
    parser = argparse.ArgumentParser(description="한 번 · 일회성 다운로드 서비스")
    parser.add_argument("--local", action="store_true", help="터널 없이 로컬 서버만 실행")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--cloudflared", type=Path)
    parser.add_argument("--reset-password", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("포트는 1~65535 범위여야 합니다.")
    data_dir = args.data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    if args.reset_password:
        reset_password(data_dir)
        return 0
    if not (data_dir / "settings.json").exists():
        # 자동 검증이나 무인 초기 설정에서만 환경변수를 사용합니다.
        password = os.environ.pop("OTD_SETUP_PASSWORD", None) or read_password()
        initialize_settings(data_dir, password)
        del password
        print("관리자 초기 설정을 완료했습니다.")
    cloudflared = None
    if not args.local:
        candidate = args.cloudflared or ROOT / "bin" / "cloudflared.exe"
        cloudflared = str(candidate) if candidate.is_file() else shutil.which("cloudflared")
        if not cloudflared:
            raise RuntimeError("cloudflared가 없습니다. scripts\\setup.ps1을 먼저 실행해 주세요.")
    from waitress import create_server
    local_url = "http://127.0.0.1:" + str(args.port)
    app = create_app({"DATA_DIR": str(data_dir), "LOCAL_URL": local_url})
    set_tunnel_state(app, "local" if args.local else "starting")
    server = create_server(
        app, host="127.0.0.1", port=args.port, threads=8,
        max_request_body_size=MAX_FILE_SIZE + 1024 * 1024,
        trusted_proxy="127.0.0.1", trusted_proxy_count=1,
        trusted_proxy_headers={"x-forwarded-proto"}, clear_untrusted_proxy_headers=True,
        channel_request_lookahead=1,
    )
    stopped = threading.Event()
    server_thread = threading.Thread(target=server.run, name="web-server", daemon=True)
    server_thread.start()
    tunnel = None
    tunnel_thread = None

    def stop_signal(_signum, _frame):
        stopped.set()

    signal.signal(signal.SIGINT, stop_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop_signal)

    def watch_tunnel():
        public_url = ""
        registered = False
        assert tunnel and tunnel.stdout
        for line in tunnel.stdout:
            if stopped.is_set():
                break
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if match and not public_url:
                public_url = match.group(0)
                set_tunnel_state(app, "starting", public_url, "공개 주소를 발급했습니다. 터널 연결을 기다리고 있습니다.")
                print("공개 주소: " + public_url, flush=True)
            if "Registered tunnel connection" in line:
                registered = True
            if public_url and registered:
                set_tunnel_state(app, "ready", public_url)
                print("공개 관리자: " + public_url + "/admin.html", flush=True)
                registered = False
        if not stopped.is_set():
            set_tunnel_state(app, "failed", message="임시 터널 연결이 종료되었습니다. 실행 창에서 종료 후 다시 시작해 주세요.")
            print("임시 터널 연결이 종료되었습니다. 로컬 서버는 계속 실행 중입니다.", flush=True)

    print("로컬 관리자: " + local_url + "/admin.html", flush=True)
    print("종료하려면 이 창에서 Ctrl+C를 눌러 주세요.", flush=True)
    try:
        if cloudflared:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            tunnel = subprocess.Popen(
                [cloudflared, "--no-autoupdate", "tunnel", "--url", local_url],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace", creationflags=flags,
            )
            tunnel_thread = threading.Thread(target=watch_tunnel, name="tunnel-monitor", daemon=True)
            tunnel_thread.start()
        started = time.monotonic()
        warned = False
        while not stopped.wait(0.5):
            if (data_dir / "stop.request").exists():
                (data_dir / "stop.request").unlink()
                stopped.set()
                break
            if not server_thread.is_alive():
                raise RuntimeError("웹 서버가 종료되었습니다.")
            if tunnel and time.monotonic() - started > 60 and not warned:
                with sqlite3.connect(app.extensions["db_path"]) as db:
                    row = db.execute("SELECT value FROM settings WHERE key='tunnel_status'").fetchone()
                if row and row[0] == "starting":
                    set_tunnel_state(app, "failed", message="터널 연결 시간이 초과되었습니다. 네트워크를 확인한 뒤 서비스를 다시 실행해 주세요.")
                    print("터널 연결 시간이 초과되었습니다. 로컬 관리자에서 상태를 확인해 주세요.", flush=True)
                warned = True
    finally:
        stopped.set()
        if tunnel:
            if tunnel.poll() is None:
                tunnel.terminate()
                try:
                    tunnel.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    tunnel.kill()
                    tunnel.wait(timeout=5)
            if tunnel.stdout:
                tunnel.stdout.close()
        if tunnel_thread:
            tunnel_thread.join(timeout=2)
        set_tunnel_state(app, "stopped", message="서비스를 다시 실행하면 새 공개 주소가 생성됩니다.")
        server.close()
        server.task_dispatcher.shutdown()
        server_thread.join(timeout=2)
        print("서버와 임시 터널을 종료했습니다.", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print("실행 오류: " + str(error), file=sys.stderr)
        sys.exit(1)

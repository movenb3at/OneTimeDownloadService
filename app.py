from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlsplit

from flask import Flask, Response, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
MAX_FILE_SIZE = 90 * 1024 * 1024
RETRY_SECONDS = 10 * 60
ADMIN_SECONDS = 8 * 60 * 60
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
BROWSER_COOKIE = "otd_browser"
ADMIN_COOKIE = "otd_admin"

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, stored_name TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    created_at REAL NOT NULL, deleted_at REAL
);
CREATE TABLE IF NOT EXISTS browsers (
    cookie_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    device_type TEXT NOT NULL, os TEXT NOT NULL, browser TEXT NOT NULL,
    first_seen REAL NOT NULL, last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
    file_id TEXT NOT NULL REFERENCES files(id),
    state TEXT NOT NULL CHECK(state IN ('available','reserved','completed','expired','revoked')),
    created_at REAL NOT NULL, owner_hash TEXT REFERENCES browsers(cookie_hash),
    reserved_at REAL, expires_at REAL, session_id TEXT UNIQUE,
    completed_at REAL, active_attempt_id TEXT,
    last_attempt_id TEXT, transfer_complete INTEGER NOT NULL DEFAULT 0,
    counted_completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS visits (
    link_id TEXT NOT NULL REFERENCES links(id),
    browser_hash TEXT NOT NULL REFERENCES browsers(cookie_hash),
    first_seen REAL NOT NULL, last_seen REAL NOT NULL, views INTEGER NOT NULL,
    PRIMARY KEY(link_id, browser_hash)
);
CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id),
    browser_hash TEXT NOT NULL REFERENCES browsers(cookie_hash),
    started_at REAL NOT NULL, finished_at REAL, status TEXT NOT NULL,
    bytes_sent INTEGER NOT NULL DEFAULT 0, fully_generated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY, expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_link ON attempts(link_id, started_at);
CREATE INDEX IF NOT EXISTS attempts_browser ON attempts(browser_hash);
"""


class ApiError(Exception):
    def __init__(self, message, status=400, code="invalid_request"):
        self.message, self.status, self.code = message, status, code


class DatabaseConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def password_hash(password):
    return generate_password_hash(password, method="scrypt")


def initialize_settings(data_dir, password):
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "settings.json"
    if path.exists():
        raise ValueError("관리자 설정이 이미 존재합니다.")
    if len(password) < 12:
        raise ValueError("관리자 비밀번호는 12자 이상이어야 합니다.")
    settings = {"secret": secrets.token_hex(32), "admin_password_hash": password_hash(password)}
    with path.open("x", encoding="utf-8") as handle:
        json.dump(settings, handle)
    return settings


def device_details(user_agent):
    ua = user_agent[:1024]
    if "Android" in ua:
        os_name = "Android"
    elif "iPhone" in ua or "iPad" in ua or ("Macintosh" in ua and "Mobile" in ua):
        os_name = "iOS / iPadOS"
    elif "Windows" in ua:
        os_name = "Windows"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_name = "macOS"
    elif "Linux" in ua:
        os_name = "Linux"
    else:
        os_name = "알 수 없음"
    if any(value in ua for value in ("Edg/", "EdgA/", "EdgiOS/")):
        browser = "Edge"
    elif "OPR/" in ua:
        browser = "Opera"
    elif "SamsungBrowser/" in ua:
        browser = "Samsung Internet"
    elif "Firefox/" in ua or "FxiOS/" in ua:
        browser = "Firefox"
    elif "Chrome/" in ua or "CriOS/" in ua:
        browser = "Chrome"
    elif "Safari/" in ua:
        browser = "Safari"
    else:
        browser = "알 수 없음"
    tablet = "iPad" in ua or ("Android" in ua and "Mobile" not in ua)
    mobile = "Mobile" in ua or "iPhone" in ua
    device = "태블릿" if tablet else "모바일" if mobile else "PC" if os_name != "알 수 없음" else "알 수 없음"
    return device, os_name, browser


def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATA_DIR=str(ROOT / "data"), MAX_CONTENT_LENGTH=MAX_FILE_SIZE + 1024 * 1024,
        MAX_FILE_SIZE=MAX_FILE_SIZE, RETRY_SECONDS=RETRY_SECONDS, CLOCK=time.time,
        LOCAL_URL="http://127.0.0.1:8080",
    )
    app.config.update(config or {})
    data_dir = Path(app.config["DATA_DIR"])
    storage = data_dir / "files"
    storage.mkdir(parents=True, exist_ok=True)
    supplied = app.config.get("SETTINGS")
    if supplied:
        settings = supplied
    else:
        path = data_dir / "settings.json"
        if not path.exists():
            raise RuntimeError("관리자 설정이 없습니다. start.cmd를 실행해 초기 설정을 완료해 주세요.")
        settings = json.loads(path.read_text(encoding="utf-8"))
    secret = settings["secret"].encode("ascii")
    db_path = data_dir / "service.sqlite3"
    app.extensions["db_path"] = db_path
    app.extensions["storage"] = storage
    login_failures = {}
    rate_lock = threading.Lock()

    def connect():
        db = sqlite3.connect(db_path, timeout=10, factory=DatabaseConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        return db

    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        file_columns = {row["name"] for row in db.execute("PRAGMA table_info(files)")}
        if "deleted_at" not in file_columns:
            db.execute("ALTER TABLE files ADD COLUMN deleted_at REAL")
        link_columns = {row["name"] for row in db.execute("PRAGMA table_info(links)")}
        for column, definition in (("last_attempt_id", "TEXT"), ("transfer_complete", "INTEGER NOT NULL DEFAULT 0"),
                                   ("counted_completed", "INTEGER NOT NULL DEFAULT 0")):
            if column not in link_columns:
                db.execute(f"ALTER TABLE links ADD COLUMN {column} {definition}")
        if "last_attempt_id" not in link_columns:
            db.execute("""UPDATE links SET last_attempt_id=(
                SELECT id FROM attempts WHERE link_id=links.id ORDER BY started_at DESC,rowid DESC LIMIT 1)
            """)
            db.execute("""UPDATE links SET transfer_complete=COALESCE((
                SELECT fully_generated FROM attempts WHERE id=links.last_attempt_id),0)
            """)
        if "counted_completed" not in link_columns:
            db.execute("UPDATE links SET counted_completed=1 WHERE state='completed'")
        db.execute("UPDATE attempts SET status='interrupted', finished_at=? WHERE status='streaming'", (time.time(),))
        db.execute("UPDATE links SET active_attempt_id=NULL")

    def now():
        return app.config["CLOCK"]()

    @contextmanager
    def transaction():
        db = connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def read_setting(key, default=None):
        with connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def expire(db):
        db.execute("UPDATE links SET state='expired' WHERE state='reserved' AND expires_at<=?", (now(),))

    def csrf(kind, token):
        return hmac.new(secret, (kind + ":" + token).encode(), hashlib.sha256).hexdigest()

    def browser_identity():
        if hasattr(g, "browser"):
            return g.browser
        token = request.cookies.get(BROWSER_COOKIE, "")
        if not TOKEN_RE.fullmatch(token):
            token = secrets.token_hex(32)
            g.browser_cookie = token
        digest = hashlib.sha256(token.encode()).hexdigest()
        device, os_name, browser = device_details(request.headers.get("User-Agent", ""))
        with transaction() as db:
            db.execute(
                "INSERT INTO browsers VALUES (?,?,?,?,?,?,?) ON CONFLICT(cookie_hash) DO UPDATE SET last_seen=excluded.last_seen",
                (digest, secrets.token_hex(6), device, os_name, browser, now(), now()),
            )
            row = db.execute("SELECT * FROM browsers WHERE cookie_hash=?", (digest,)).fetchone()
        g.browser = dict(row)
        g.browser_token = token
        return g.browser

    def admin_session():
        token = request.cookies.get(ADMIN_COOKIE, "")
        if not TOKEN_RE.fullmatch(token):
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with connect() as db:
            row = db.execute("SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?", (digest, now())).fetchone()
        return token if row else None

    def check_csrf(kind="browser", token=None):
        if token is None:
            browser_identity()
            token = g.browser_token
        provided = request.headers.get("X-CSRF-Token", "")
        if not hmac.compare_digest(provided, csrf(kind, token)):
            raise ApiError("요청 인증 정보가 만료되었습니다. 페이지를 새로고침해 주세요.", 403, "csrf")
        origin = request.headers.get("Origin")
        if origin and origin != request.host_url.rstrip("/"):
            raise ApiError("다른 사이트에서 보낸 요청은 허용되지 않습니다.", 403, "origin")
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            raise ApiError("다른 사이트에서 보낸 요청은 허용되지 않습니다.", 403, "origin")

    def require_admin(mutate=False):
        token = admin_session()
        if not token:
            raise ApiError("관리자 로그인이 필요합니다.", 401, "authentication")
        if mutate:
            check_csrf("admin", token)
        return token

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise ApiError("JSON 요청 본문이 필요합니다.")
        return value

    def link_for_token(db, token):
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            raise ApiError("유효한 다운로드 링크가 아닙니다.", 404, "not_found")
        row = db.execute(
            "SELECT l.*, f.name, f.size, f.sha256, f.stored_name FROM links l JOIN files f ON f.id=l.file_id WHERE l.token=? AND f.deleted_at IS NULL",
            (token,),
        ).fetchone()
        if not row:
            raise ApiError("유효한 다운로드 링크가 아닙니다.", 404, "not_found")
        return row

    def session_link(db, session_id):
        browser = browser_identity()
        if not ID_RE.fullmatch(session_id):
            raise ApiError("다운로드 예약을 찾을 수 없습니다.", 404, "not_found")
        row = db.execute(
            "SELECT l.*, f.name, f.size, f.sha256, f.stored_name FROM links l JOIN files f ON f.id=l.file_id WHERE session_id=?",
            (session_id,),
        ).fetchone()
        if not row or row["owner_hash"] != browser["cookie_hash"]:
            raise ApiError("이 브라우저의 다운로드 예약이 아닙니다.", 403, "owner")
        return row

    def require_reserved(row):
        if row["state"] == "completed":
            raise ApiError("이미 수신 완료된 링크입니다.", 410, "completed")
        if row["state"] in ("expired", "revoked"):
            message = "재시도 가능 시간 10분이 지났습니다." if row["state"] == "expired" else "관리자가 무효화한 링크입니다."
            raise ApiError(message, 410, row["state"])
        if row["state"] != "reserved":
            raise ApiError("먼저 다운로드를 시작해 주세요.", 409, "not_reserved")

    def new_link(db, file_id):
        link = {
            "id": secrets.token_hex(16), "token": hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
            "file_id": file_id, "state": "available", "created_at": now(),
        }
        db.execute("INSERT INTO links(id,token,file_id,state,created_at) VALUES (:id,:token,:file_id,:state,:created_at)", link)
        return link

    def public_url(token, page="index.html"):
        base = read_setting("public_url") or app.config["LOCAL_URL"]
        return base.rstrip("/") + "/" + page + "#token=" + token

    @app.before_request
    def validate_host():
        public = read_setting("public_url", "")
        allowed = {"localhost", "127.0.0.1", "::1"}
        if public:
            allowed.add(urlsplit(public).hostname)
        if request.host.split(":")[0] not in allowed:
            raise ApiError("허용되지 않은 호스트입니다.", 400, "host")
        if request.headers.get("Sec-Fetch-Site") == "cross-site" and request.path.startswith("/api/"):
            raise ApiError("다른 사이트에서 보낸 요청은 허용되지 않습니다.", 403, "origin")

    @app.after_request
    def response_headers(response):
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        if request.is_secure:
            response.headers["Strict-Transport-Security"] = "max-age=86400"
        if hasattr(g, "browser_cookie"):
            response.set_cookie(BROWSER_COOKIE, g.browser_cookie, max_age=90 * 86400,
                                httponly=True, secure=request.is_secure, samesite="Strict")
        return response

    @app.errorhandler(ApiError)
    def api_error(error):
        return jsonify(error=error.message, code=error.code), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        messages = {413: "파일은 최대 90MiB까지 업로드할 수 있습니다.", 404: "요청한 주소를 찾을 수 없습니다.", 405: "허용되지 않은 요청 방식입니다."}
        return jsonify(error=messages.get(error.code, "요청을 처리할 수 없습니다."), code="http_error"), error.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        if app.testing:
            raise error
        app.logger.error("요청 처리 실패: %s", type(error).__name__)
        return jsonify(error="서버에서 요청을 처리하지 못했습니다. 다시 시도해 주세요.", code="server_error"), 500

    @app.get("/")
    @app.get("/index.html")
    def index():
        return send_from_directory(ROOT / "static", "index.html")

    @app.get("/download.html")
    def download_page():
        return send_from_directory(ROOT / "static", "download.html")

    @app.get("/admin.html")
    def admin_page():
        return send_from_directory(ROOT / "static", "admin.html")

    @app.get("/assets/<path:name>")
    def assets(name):
        return send_from_directory(ROOT / "static" / "assets", name)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True)

    @app.get("/api/session")
    def session_info():
        browser_identity()
        admin = admin_session()
        return jsonify(browser_csrf=csrf("browser", g.browser_token),
                       admin=bool(admin), admin_csrf=csrf("admin", admin) if admin else None,
                       max_file_size=app.config["MAX_FILE_SIZE"], retry_seconds=app.config["RETRY_SECONDS"])

    @app.post("/api/admin/login")
    def login():
        check_csrf()
        # 접속 주소는 로그인 속도 제한용 해시로만 메모리에 보관합니다.
        public_host = urlsplit(read_setting("public_url", "")).hostname
        remote = request.headers.get("CF-Connecting-IP", request.remote_addr) if request.host.split(":")[0] == public_host else request.remote_addr
        key = hmac.new(secret, str(remote).encode(), hashlib.sha256).hexdigest()
        with rate_lock:
            for old_key in list(login_failures):
                if now() - login_failures[old_key][0] >= 900:
                    del login_failures[old_key]
            failed = login_failures.get(key, (now(), 0))
            if failed[1] >= 5:
                raise ApiError("로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.", 429, "rate_limit")
        password = body().get("password", "")
        if not isinstance(password, str) or len(password) > 1024 or not check_password_hash(settings["admin_password_hash"], password):
            with rate_lock:
                current = login_failures.get(key, (now(), 0))
                login_failures[key] = (current[0], current[1] + 1)
            raise ApiError("비밀번호가 올바르지 않습니다.", 401, "password")
        with rate_lock:
            login_failures.pop(key, None)
        token = secrets.token_hex(32)
        with transaction() as db:
            old = request.cookies.get(ADMIN_COOKIE, "")
            db.execute("DELETE FROM admin_sessions WHERE expires_at<=? OR token_hash=?", (now(), hashlib.sha256(old.encode()).hexdigest()))
            db.execute("INSERT INTO admin_sessions VALUES (?,?)", (hashlib.sha256(token.encode()).hexdigest(), now() + ADMIN_SECONDS))
        response = jsonify(ok=True, admin_csrf=csrf("admin", token))
        response.set_cookie(ADMIN_COOKIE, token, max_age=ADMIN_SECONDS, httponly=True,
                            secure=request.is_secure, samesite="Strict")
        return response

    @app.post("/api/admin/logout")
    def logout():
        token = require_admin(True)
        with transaction() as db:
            db.execute("DELETE FROM admin_sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
        response = jsonify(ok=True)
        response.delete_cookie(ADMIN_COOKIE, secure=request.is_secure, httponly=True, samesite="Strict")
        return response

    @app.post("/api/admin/files")
    def upload():
        require_admin(True)
        uploads = request.files.getlist("file")
        if len(uploads) != 1 or len(request.files) != 1:
            raise ApiError("업로드할 파일 하나를 선택해 주세요.")
        uploaded = uploads[0]
        name = uploaded.filename or ""
        if not name or len(name) > 240 or any(c in name for c in "/\\") or any(ord(c) < 32 for c in name) or name in (".", ".."):
            raise ApiError("파일명이 올바르지 않습니다.")
        file_id = secrets.token_hex(16)
        destination = storage / file_id
        temporary = storage / (file_id + ".upload")
        size, digest = 0, hashlib.sha256()
        saved = False
        try:
            with temporary.open("xb") as handle:
                while chunk := uploaded.stream.read(256 * 1024):
                    size += len(chunk)
                    if size > app.config["MAX_FILE_SIZE"]:
                        raise ApiError("파일은 최대 90MiB까지 업로드할 수 있습니다.", 413, "file_size")
                    digest.update(chunk)
                    handle.write(chunk)
            os.replace(temporary, destination)
            with transaction() as db:
                db.execute("INSERT INTO files(id,stored_name,name,size,sha256,created_at) VALUES (?,?,?,?,?,?)",
                           (file_id, file_id, name, size, digest.hexdigest(), now()))
                link = new_link(db, file_id)
            saved = True
            return jsonify(file={"id": file_id, "name": name, "size": size, "sha256": digest.hexdigest()},
                           link=link, share_url=public_url(link["token"])), 201
        finally:
            temporary.unlink(missing_ok=True)
            if not saved:
                destination.unlink(missing_ok=True)

    @app.post("/api/admin/files/<file_id>/links")
    def create_link(file_id):
        require_admin(True)
        with transaction() as db:
            if not db.execute("SELECT id FROM files WHERE id=? AND deleted_at IS NULL", (file_id,)).fetchone():
                raise ApiError("파일을 찾을 수 없습니다.", 404, "not_found")
            link = new_link(db, file_id)
        return jsonify(link=link, share_url=public_url(link["token"])), 201

    @app.delete("/api/admin/files/<file_id>")
    def delete_file(file_id):
        require_admin(True)
        with transaction() as db:
            expire(db)
            row = db.execute("SELECT * FROM files WHERE id=? AND deleted_at IS NULL", (file_id,)).fetchone()
            if not row:
                raise ApiError("파일을 찾을 수 없습니다.", 404, "not_found")
            if db.execute("SELECT 1 FROM links WHERE file_id=? AND (state='reserved' OR active_attempt_id IS NOT NULL)", (file_id,)).fetchone():
                raise ApiError("다운로드 예약 또는 전송 중인 파일은 삭제할 수 없습니다. 완료되거나 예약이 만료된 후 다시 시도해 주세요.", 409, "file_busy")
            if not ID_RE.fullmatch(row["stored_name"]):
                raise ApiError("서버 파일 경로를 확인할 수 없습니다.", 409, "file_path")
            try:
                (storage / row["stored_name"]).unlink(missing_ok=True)
            except OSError:
                raise ApiError("서버 파일을 삭제하지 못했습니다. 파일 사용 상태와 폴더 권한을 확인해 주세요.", 409, "file_delete")
            db.execute("UPDATE files SET deleted_at=? WHERE id=?", (now(), file_id))
            db.execute("UPDATE links SET state='revoked' WHERE file_id=? AND state!='completed'", (file_id,))
        return jsonify(ok=True)

    @app.post("/api/admin/history/clear")
    def clear_history():
        require_admin(True)
        with transaction() as db:
            db.execute("DELETE FROM attempts")
            db.execute("DELETE FROM visits")
            db.execute("UPDATE links SET counted_completed=0")
            # 쿠키 식별 정보와 링크 예약은 유지하고 통계에 표시되는 기록만 지웁니다.
            reset_at = now()
            db.execute("INSERT INTO settings VALUES ('statistics_reset_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(reset_at),))
        return jsonify(ok=True, statistics_reset_at=reset_at)

    @app.post("/api/admin/links/<link_id>/revoke")
    def revoke(link_id):
        require_admin(True)
        with transaction() as db:
            row = db.execute("SELECT state FROM links WHERE id=?", (link_id,)).fetchone()
            if not row:
                raise ApiError("링크를 찾을 수 없습니다.", 404, "not_found")
            if row["state"] != "completed":
                db.execute("UPDATE links SET state='revoked' WHERE id=?", (link_id,))
        return jsonify(ok=True)

    @app.post("/api/public/info")
    def public_info():
        browser = browser_identity()
        with transaction() as db:
            expire(db)
            row = link_for_token(db, body().get("token"))
            db.execute(
                "INSERT INTO visits VALUES (?,?,?,?,1) ON CONFLICT(link_id,browser_hash) DO UPDATE SET last_seen=excluded.last_seen, views=views+1",
                (row["id"], browser["cookie_hash"], now(), now()),
            )
        owner = row["owner_hash"] == browser["cookie_hash"]
        return jsonify(name=row["name"], size=row["size"], sha256=row["sha256"], state=row["state"],
                       can_download=row["state"] == "available" or (row["state"] == "reserved" and owner),
                       is_owner=owner, expires_at=row["expires_at"], retry_seconds=app.config["RETRY_SECONDS"],
                       session_id=row["session_id"] if owner else None, server_time=now())

    @app.post("/api/public/claim")
    def claim():
        check_csrf()
        browser = browser_identity()
        with transaction() as db:
            expire(db)
            row = link_for_token(db, body().get("token"))
            db.execute("INSERT INTO visits VALUES (?,?,?,?,0) ON CONFLICT(link_id,browser_hash) DO UPDATE SET last_seen=excluded.last_seen",
                       (row["id"], browser["cookie_hash"], now(), now()))
            if not (storage / row["stored_name"]).is_file():
                raise ApiError("서버에서 파일을 찾을 수 없습니다. 관리자에게 문의해 주세요.", 404, "file_missing")
            if row["state"] == "available":
                session_id = secrets.token_hex(16)
                expires_at = now() + app.config["RETRY_SECONDS"]
                db.execute(
                    "UPDATE links SET state='reserved',owner_hash=?,reserved_at=?,expires_at=?,session_id=? WHERE id=? AND state='available'",
                    (browser["cookie_hash"], now(), expires_at, session_id, row["id"]),
                )
            else:
                require_reserved(row)
                if row["owner_hash"] != browser["cookie_hash"]:
                    raise ApiError("다른 브라우저가 다운로드를 시작한 링크입니다.", 409, "reserved")
                session_id, expires_at = row["session_id"], row["expires_at"]
        return jsonify(session_id=session_id, expires_at=expires_at)

    @app.get("/api/public/downloads/<session_id>/file")
    def file_response(session_id):
        if request.method == "HEAD":
            raise ApiError("파일 전송은 GET 요청으로만 시작할 수 있습니다.", 405, "method")
        check_csrf()
        browser = browser_identity()
        with transaction() as db:
            expire(db)
            row = session_link(db, session_id)
            require_reserved(row)
            if row["active_attempt_id"]:
                raise ApiError("이미 파일을 전송 중입니다. 잠시 후 다시 시도해 주세요.", 409, "stream_busy")
            path = storage / row["stored_name"]
            try:
                handle = path.open("rb")
                if path.stat().st_size != row["size"]:
                    handle.close()
                    raise ApiError("서버 파일의 크기가 변경되었습니다.", 409, "file_changed")
            except OSError:
                raise ApiError("서버에서 파일을 읽을 수 없습니다.", 404, "file_missing")
            attempt_id = secrets.token_hex(16)
            db.execute("INSERT INTO visits VALUES (?,?,?,?,0) ON CONFLICT(link_id,browser_hash) DO UPDATE SET last_seen=excluded.last_seen",
                       (row["id"], browser["cookie_hash"], now(), now()))
            db.execute("INSERT INTO attempts(id,link_id,browser_hash,started_at,status) VALUES (?,?,?,?,?)",
                       (attempt_id, row["id"], browser["cookie_hash"], now(), "streaming"))
            db.execute("UPDATE links SET active_attempt_id=?,last_attempt_id=?,transfer_complete=0 WHERE id=?",
                       (attempt_id, attempt_id, row["id"]))
        size, expires_at, link_id = row["size"], row["expires_at"], row["id"]

        class FileStream:
            def __init__(self):
                self.sent = 0
                self.done = size == 0
                self.closed = False
                self.reason = "interrupted"
                self.db = connect()

            def __iter__(self):
                return self

            def __next__(self):
                if self.closed:
                    raise StopIteration
                state = self.db.execute("SELECT state FROM links WHERE id=?", (link_id,)).fetchone()
                if now() >= expires_at or not state or state["state"] != "reserved":
                    self.reason = "expired" if now() >= expires_at else "revoked"
                    self.close()
                    raise StopIteration
                chunk = handle.read(256 * 1024)
                if not chunk:
                    self.done = self.sent == size
                    self.close()
                    raise StopIteration
                self.sent += len(chunk)
                return chunk

            def close(self):
                if self.closed:
                    return
                self.closed = True
                handle.close()
                self.db.close()
                with transaction() as db:
                    db.execute("UPDATE attempts SET status=?,finished_at=?,bytes_sent=?,fully_generated=? WHERE id=?",
                               ("awaiting_confirmation" if self.done else self.reason, now(), self.sent, int(self.done), attempt_id))
                    db.execute("UPDATE links SET active_attempt_id=NULL,transfer_complete=? WHERE id=? AND active_attempt_id=?",
                               (int(self.done), link_id, attempt_id))
                    expire(db)

        response = Response(FileStream(), mimetype="application/octet-stream", direct_passthrough=True)
        response.content_length = size
        response.headers["Content-Disposition"] = "attachment; filename=\"download\"; filename*=UTF-8''" + quote(row["name"], safe="")
        return response

    @app.post("/api/public/downloads/<session_id>/complete")
    def complete(session_id):
        check_csrf()
        data = body()
        with transaction() as db:
            expire(db)
            row = session_link(db, session_id)
            if row["state"] == "completed":
                return jsonify(ok=True, already_completed=True)
            require_reserved(row)
            if row["active_attempt_id"]:
                raise ApiError("서버의 전송 처리를 확인 중입니다. 잠시 후 다시 시도해 주세요.", 409, "stream_busy")
            if not row["transfer_complete"]:
                raise ApiError("파일 전체 전송이 확인되지 않았습니다.", 409, "incomplete")
            if data.get("sha256") != row["sha256"] or type(data.get("size")) is not int or data["size"] != row["size"]:
                db.execute("UPDATE attempts SET status='hash_mismatch' WHERE id=?", (row["last_attempt_id"],))
                # 오류를 반환해도 해시 불일치 기록은 보존합니다.
                return jsonify(error="파일 검증에 실패했습니다. 다시 다운로드해 주세요.", code="hash_mismatch"), 422
            db.execute("UPDATE links SET state='completed',completed_at=?,counted_completed=1 WHERE id=?", (now(), row["id"]))
            db.execute("UPDATE attempts SET status='completed' WHERE id=?", (row["last_attempt_id"],))
            db.execute("INSERT INTO visits VALUES (?,?,?,?,0) ON CONFLICT(link_id,browser_hash) DO UPDATE SET last_seen=excluded.last_seen",
                       (row["id"], row["owner_hash"], now(), now()))
        return jsonify(ok=True, already_completed=False)

    @app.get("/api/admin/dashboard")
    def dashboard():
        require_admin()
        with transaction() as db:
            expire(db)
            files = [dict(row) for row in db.execute("""
                SELECT f.*, (SELECT COUNT(*) FROM links l WHERE l.file_id=f.id) AS link_count,
                (SELECT COUNT(*) FROM links l WHERE l.file_id=f.id AND l.counted_completed=1) AS completed_count,
                (SELECT COUNT(*) FROM attempts a JOIN links l ON l.id=a.link_id WHERE l.file_id=f.id) AS attempt_count,
                EXISTS(SELECT 1 FROM links l WHERE l.file_id=f.id AND (l.state='reserved' OR l.active_attempt_id IS NOT NULL)) AS busy
                FROM files f WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC
            """)]
            links = [dict(row) for row in db.execute("""
                SELECT l.id,l.token,l.file_id,l.state,l.created_at,l.reserved_at,l.expires_at,l.completed_at,
                f.name,f.size,CASE WHEN EXISTS(SELECT 1 FROM visits v WHERE v.link_id=l.id AND v.browser_hash=l.owner_hash) THEN b.id END AS device_id,
                (SELECT COUNT(*) FROM attempts a WHERE a.link_id=l.id) AS attempt_count
                FROM links l JOIN files f ON f.id=l.file_id LEFT JOIN browsers b ON b.cookie_hash=l.owner_hash
                WHERE f.deleted_at IS NULL
                ORDER BY l.created_at DESC
            """)]
            devices = [dict(row) for row in db.execute("""
                SELECT b.id,b.device_type,b.os,b.browser,MIN(v.first_seen) AS first_seen,MAX(v.last_seen) AS last_seen,
                SUM(v.views) AS views,
                (SELECT COUNT(*) FROM attempts a WHERE a.browser_hash=b.cookie_hash) AS attempt_count,
                (SELECT COUNT(*) FROM links l WHERE l.owner_hash=b.cookie_hash AND l.counted_completed=1) AS completed_count
                FROM browsers b JOIN visits v ON v.browser_hash=b.cookie_hash GROUP BY b.cookie_hash ORDER BY last_seen DESC
            """)]
            attempts = [dict(row) for row in db.execute("""
                SELECT a.id,a.started_at,a.finished_at,a.status,a.bytes_sent,f.name,b.id AS device_id,
                b.device_type,b.os,b.browser
                FROM attempts a JOIN links l ON l.id=a.link_id JOIN files f ON f.id=l.file_id
                JOIN browsers b ON b.cookie_hash=a.browser_hash ORDER BY a.started_at DESC,a.rowid DESC LIMIT 200
            """)]
            attempt_count = db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0]
            retry_count = db.execute("SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM attempts GROUP BY link_id)").fetchone()[0]
            summary = {
                "files": len(files), "links": len(links), "devices": len(devices),
                "completed": db.execute("SELECT COUNT(*) FROM links WHERE counted_completed=1").fetchone()[0],
                "reserved": sum(link["state"] == "reserved" for link in links),
                "attempts": attempt_count, "retries": retry_count,
            }
        for file in files:
            file["can_delete"] = not bool(file.pop("busy"))
            file["delete_reason"] = "" if file["can_delete"] else "다운로드 예약 또는 전송이 끝난 후 삭제할 수 있습니다."
        for link in links:
            link["share_url"] = public_url(link.pop("token"))
        return jsonify(summary=summary, files=files, links=links, devices=devices, attempts=attempts,
                       tunnel={"status": read_setting("tunnel_status", "local"),
                               "public_url": read_setting("public_url", ""), "local_url": app.config["LOCAL_URL"],
                               "message": read_setting("tunnel_message", "")},
                       server_time=now(), retry_seconds=app.config["RETRY_SECONDS"],
                       statistics_reset_at=float(read_setting("statistics_reset_at", "0")))

    return app


def set_tunnel_state(app, status, public_url="", message=""):
    db = sqlite3.connect(app.extensions["db_path"], timeout=10)
    try:
        with db:
            for key, value in (("tunnel_status", status), ("public_url", public_url), ("tunnel_message", message)):
                db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
    finally:
        db.close()

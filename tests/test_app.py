import hashlib
import io
import secrets
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import MAX_FILE_SIZE, RETRY_SECONDS, create_app, device_details, password_hash, set_tunnel_state


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = {"secret": secrets.token_hex(32), "admin_password_hash": password_hash("test-password-for-service")}

    def setUp(self):
        artifact_root = Path(__file__).resolve().parents[1] / ".test-artifacts"
        artifact_root.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=artifact_root)
        self.clock = [1_800_000_000.0]
        self.config = {"TESTING": True, "DATA_DIR": self.directory.name, "SETTINGS": self.settings, "CLOCK": lambda: self.clock[0], "MAX_FILE_SIZE": 4096}
        self.app = create_app(self.config)
        self.admin = self.app.test_client()
        self.admin_session = self.admin.get("/api/session").json
        login = self.admin.post("/api/admin/login", json={"password": "test-password-for-service"}, headers={"X-CSRF-Token": self.admin_session["browser_csrf"]})
        self.assertEqual(login.status_code, 200)
        self.admin_csrf = login.json["admin_csrf"]
        self.client = self.app.test_client()
        self.csrf = self.client.get("/api/session").json["browser_csrf"]

    def tearDown(self):
        self.directory.cleanup()

    def upload(self, payload=b"contents", name="test.txt"):
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(payload), name)}, headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 201, response.json)
        return response.json

    def info(self, token, client=None):
        return (client or self.client).post("/api/public/info", json={"token": token})

    def claim(self, token, client=None, csrf=None):
        return (client or self.client).post("/api/public/claim", json={"token": token}, headers={"X-CSRF-Token": csrf or self.csrf})

    def get_file(self, reservation, buffered=True):
        return self.client.get("/api/public/downloads/" + reservation["session_id"] + "/file", headers={"X-CSRF-Token": self.csrf}, buffered=buffered)

    def complete(self, reservation, payload):
        return self.client.post("/api/public/downloads/" + reservation["session_id"] + "/complete",
                                json={"sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}, headers={"X-CSRF-Token": self.csrf})

    def dashboard(self):
        return self.admin.get("/api/admin/dashboard").json

    def clear_history(self):
        return self.admin.post("/api/admin/history/clear", headers={"X-CSRF-Token": self.admin_csrf})

    def delete_file(self, file_id):
        return self.admin.delete("/api/admin/files/" + file_id, headers={"X-CSRF-Token": self.admin_csrf})

    def test_view_and_preview_do_not_consume_link(self):
        token = self.upload()["link"]["token"]
        for page in ("/", "/index.html", "/download.html", "/admin.html"):
            for method in ("GET", "HEAD"):
                response = self.client.open(page, method=method)
                self.assertEqual(response.status_code, 200)
                response.close()
        for _ in range(3):
            self.assertEqual(self.info(token).json["state"], "available")
        self.assertEqual(self.dashboard()["summary"]["attempts"], 0)

    def test_completed_download_and_idempotent_ack(self):
        payload = "검증할 파일입니다.".encode()
        issued = self.upload(payload, "한글 파일.txt")
        token = issued["link"]["token"]
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        self.assertEqual(self.info(token).json["sha256"], hashlib.sha256(payload).hexdigest())
        reserved = self.claim(token).json
        response = self.get_file(reserved)
        self.assertEqual(response.data, payload)
        self.assertIn("filename*=UTF-8", response.headers["Content-Disposition"])
        self.assertEqual(self.complete(reserved, payload).status_code, 200)
        self.assertTrue(self.complete(reserved, payload).json["already_completed"])
        self.assertEqual(self.get_file(reserved).status_code, 410)
        self.assertEqual(self.claim(token).status_code, 410)
        stats = self.dashboard()
        self.assertEqual(stats["summary"]["completed"], 1)
        self.assertEqual(stats["devices"][0]["completed_count"], 1)
        self.assertNotIn("ip", str(stats["devices"][0]).lower())

    def test_concurrent_claim_has_one_owner(self):
        token = self.upload()["link"]["token"]
        clients = [self.app.test_client() for _ in range(8)]
        csrf_tokens = [client.get("/api/session").json["browser_csrf"] for client in clients]
        barrier = threading.Barrier(len(clients))
        def reserve(index):
            barrier.wait()
            return self.claim(token, clients[index], csrf_tokens[index]).status_code
        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(reserve, range(8)))
        self.assertEqual(statuses.count(200), 1)
        self.assertEqual(statuses.count(409), 7)

    def test_retry_does_not_extend_ten_minute_window(self):
        self.assertEqual(RETRY_SECONDS, 600)
        payload = b"retry me"
        token = self.upload(payload)["link"]["token"]
        self.info(token)
        first = self.claim(token).json
        self.assertEqual(first["expires_at"], self.clock[0] + 600)
        response = self.get_file(first, buffered=False)
        response.close()
        self.clock[0] += 599
        again = self.claim(token)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json, first)
        self.get_file(first).close()
        self.clock[0] += 1
        self.assertEqual(self.claim(token).status_code, 410)
        self.assertEqual(self.get_file(first).status_code, 410)
        self.assertEqual(self.complete(first, payload).status_code, 410)
        self.assertEqual(self.info(token).json["state"], "expired")
        self.assertEqual(self.dashboard()["summary"]["retries"], 1)

    def test_other_browser_cannot_read_or_confirm(self):
        payload = b"private file"
        token = self.upload(payload)["link"]["token"]
        reserved = self.claim(token).json
        other = self.app.test_client()
        csrf = other.get("/api/session").json["browser_csrf"]
        self.assertEqual(self.claim(token, other, csrf).status_code, 409)
        root = "/api/public/downloads/" + reserved["session_id"]
        self.assertEqual(other.get(root + "/file", headers={"X-CSRF-Token": csrf}).status_code, 403)
        self.assertEqual(other.post(root + "/complete", json={"sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}, headers={"X-CSRF-Token": csrf}).status_code, 403)

    def test_one_active_stream_and_retry_after_interruption(self):
        token = self.upload(b"x" * 4096)["link"]["token"]
        reserved = self.claim(token).json
        response = self.get_file(reserved, buffered=False)
        self.assertEqual(self.get_file(reserved).status_code, 409)
        response.close()
        stats = self.dashboard()
        self.assertEqual(stats["attempts"][0]["status"], "interrupted")
        self.assertEqual(self.get_file(reserved).status_code, 200)

    def test_hash_mismatch_allows_retry(self):
        payload = b"right"
        token = self.upload(payload)["link"]["token"]
        reserved = self.claim(token).json
        self.get_file(reserved).close()
        self.assertEqual(self.complete(reserved, b"wrong").status_code, 422)
        self.assertEqual(self.dashboard()["attempts"][0]["status"], "hash_mismatch")
        self.get_file(reserved).close()
        self.assertEqual(self.complete(reserved, payload).status_code, 200)
        self.assertEqual(self.dashboard()["summary"]["retries"], 1)

    def test_ack_before_transfer_is_rejected(self):
        token = self.upload()["link"]["token"]
        reserved = self.claim(token).json
        self.assertEqual(self.complete(reserved, b"contents").status_code, 409)

    def test_empty_file_and_head_do_not_lock_transfer(self):
        token = self.upload(b"")["link"]["token"]
        reserved = self.claim(token).json
        root = "/api/public/downloads/" + reserved["session_id"]
        response = self.client.head(root + "/file", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 405)
        self.assertEqual(self.dashboard()["summary"]["attempts"], 0)
        response = self.get_file(reserved)
        self.assertEqual(response.data, b"")
        response.close()
        self.assertEqual(self.complete(reserved, b"").status_code, 200)

    def test_revoke_and_reissue_preserve_records(self):
        issued = self.upload()
        token, link_id = issued["link"]["token"], issued["link"]["id"]
        reserved = self.claim(token).json
        self.get_file(reserved).close()
        response = self.admin.post("/api/admin/links/" + link_id + "/revoke", headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.get_file(reserved).status_code, 410)
        response = self.admin.post("/api/admin/files/" + issued["file"]["id"] + "/links", headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 201)
        self.assertNotEqual(response.json["link"]["token"], token)
        self.assertEqual(self.dashboard()["summary"]["links"], 2)
        self.assertEqual(self.dashboard()["summary"]["attempts"], 1)

    def test_restart_preserves_reservation_and_completion(self):
        payload = b"persist"
        token = self.upload(payload)["link"]["token"]
        reserved = self.claim(token).json
        self.app = create_app(self.config)
        # 쿠키는 재시작 전과 동일하며 브라우저와 관리자 세션도 유지됩니다.
        self.client.application = self.app
        self.admin.application = self.app
        self.assertEqual(self.claim(token).json, reserved)
        self.get_file(reserved).close()
        self.assertEqual(self.complete(reserved, payload).status_code, 200)
        self.app = create_app(self.config)
        self.admin.application = self.app
        self.assertEqual(self.dashboard()["summary"]["completed"], 1)

    def test_admin_authorization_csrf_origin_and_logout(self):
        self.assertEqual(self.client.get("/api/admin/dashboard").status_code, 401)
        self.assertEqual(self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x"), "x.txt")}).status_code, 403)
        self.assertEqual(self.client.post("/api/public/claim", json={"token": "a" * 64}).status_code, 403)
        self.assertEqual(self.client.post("/api/public/claim", json={"token": "a" * 64}, headers={"X-CSRF-Token": self.csrf, "Origin": "https://evil.example"}).status_code, 403)
        response = self.admin.post("/api/admin/logout", headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.admin.get("/api/admin/dashboard").status_code, 401)

    def test_clear_history_resets_statistics_without_reopening_links(self):
        payload = b"history"
        issued = self.upload(payload)
        reserved = self.claim(issued["link"]["token"]).json
        response = self.get_file(reserved, buffered=False)
        response.close()
        self.get_file(reserved).close()
        self.complete(reserved, payload)
        pending = self.upload(b"pending")
        pending_reservation = self.claim(pending["link"]["token"]).json
        self.assertEqual(self.dashboard()["summary"]["retries"], 1)
        self.assertEqual(self.clear_history().status_code, 200)
        stats = self.dashboard()
        for key in ("completed", "attempts", "retries", "devices"):
            self.assertEqual(stats["summary"][key], 0)
        self.assertEqual(stats["summary"]["files"], 2)
        self.assertEqual(stats["summary"]["reserved"], 1)
        self.assertEqual(stats["attempts"], [])
        self.assertEqual(stats["devices"], [])
        self.assertTrue(all(file["completed_count"] == file["attempt_count"] == 0 for file in stats["files"]))
        self.assertTrue(all(link["device_id"] is None for link in stats["links"]))
        self.assertEqual(stats["statistics_reset_at"], self.clock[0])
        self.assertTrue((self.app.extensions["storage"] / issued["file"]["id"]).exists())
        self.assertEqual(self.get_file(reserved).status_code, 410)
        self.assertTrue(self.complete(reserved, payload).json["already_completed"])
        self.assertEqual(self.dashboard()["summary"]["completed"], 0)
        self.assertEqual(self.claim(pending["link"]["token"]).json, pending_reservation)
        self.app = create_app(self.config)
        self.client.application = self.admin.application = self.app
        self.assertEqual(self.dashboard()["summary"]["completed"], 0)
        self.get_file(pending_reservation).close()
        self.complete(pending_reservation, b"pending")
        stats = self.dashboard()
        self.assertEqual(stats["summary"]["completed"], 1)
        self.assertEqual(stats["summary"]["attempts"], 1)
        self.assertEqual(stats["summary"]["retries"], 0)
        self.assertEqual(stats["summary"]["devices"], 1)
        with closing(sqlite3.connect(self.app.extensions["db_path"])) as db, db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_clear_history_during_stream_preserves_transfer_lock_and_ack(self):
        payload = b"x" * 4096
        token = self.upload(payload)["link"]["token"]
        reserved = self.claim(token).json
        response = self.get_file(reserved, buffered=False)
        self.assertEqual(self.clear_history().status_code, 200)
        self.assertEqual(self.get_file(reserved).status_code, 409)
        self.assertEqual(self.complete(reserved, payload).status_code, 409)
        self.assertEqual(response.get_data(), payload)
        response.close()
        self.assertEqual(self.complete(reserved, payload).status_code, 200)
        stats = self.dashboard()
        self.assertEqual(stats["summary"]["attempts"], 0)
        self.assertEqual(stats["summary"]["completed"], 1)
        self.assertEqual(stats["attempts"], [])

    def test_clear_history_while_awaiting_ack_survives_restart(self):
        payload = b"waiting"
        token = self.upload(payload)["link"]["token"]
        reserved = self.claim(token).json
        self.get_file(reserved).close()
        self.clear_history()
        self.app = create_app(self.config)
        self.client.application = self.admin.application = self.app
        self.assertEqual(self.complete(reserved, b"wrong").status_code, 422)
        self.assertEqual(self.complete(reserved, payload).status_code, 200)
        self.assertTrue(self.complete(reserved, payload).json["already_completed"])
        self.assertEqual(self.dashboard()["summary"]["completed"], 1)

    def test_delete_completed_file_removes_bytes_and_preserves_history(self):
        payload = b"delete me"
        issued = self.upload(payload)
        file_id = issued["file"]["id"]
        reserved = self.claim(issued["link"]["token"]).json
        self.get_file(reserved).close()
        self.complete(reserved, payload)
        extra = self.admin.post("/api/admin/files/" + file_id + "/links", headers={"X-CSRF-Token": self.admin_csrf}).json
        self.clear_history()
        self.assertTrue(self.dashboard()["files"][0]["can_delete"])
        # 통계 초기화 후에도 파일 삭제 동작은 유지됩니다.
        self.assertEqual(self.delete_file(file_id).status_code, 200)
        self.assertFalse((self.app.extensions["storage"] / file_id).exists())
        self.assertEqual(self.dashboard()["files"], [])
        self.assertEqual(self.dashboard()["links"], [])
        self.assertEqual(self.info(issued["link"]["token"]).status_code, 404)
        self.assertEqual(self.claim(extra["link"]["token"]).status_code, 404)
        self.assertEqual(self.admin.post("/api/admin/files/" + file_id + "/links", headers={"X-CSRF-Token": self.admin_csrf}).status_code, 404)
        self.assertEqual(self.delete_file(file_id).status_code, 404)
        self.assertTrue(self.complete(reserved, payload).json["already_completed"])
        self.app = create_app(self.config)
        self.admin.application = self.app
        self.assertEqual(self.dashboard()["files"], [])

    def test_file_deletion_preserves_totals_until_history_clear(self):
        payload = b"keep totals"
        issued = self.upload(payload)
        reserved = self.claim(issued["link"]["token"]).json
        self.get_file(reserved).close()
        self.complete(reserved, payload)
        self.assertEqual(self.delete_file(issued["file"]["id"]).status_code, 200)
        stats = self.dashboard()
        self.assertEqual(stats["summary"]["completed"], 1)
        self.assertEqual(stats["summary"]["attempts"], 1)
        self.assertEqual(stats["attempts"][0]["name"], issued["file"]["name"])
        self.assertEqual(stats["devices"][0]["completed_count"], 1)
        self.clear_history()
        self.assertEqual(self.dashboard()["summary"]["completed"], 0)
        self.assertEqual(self.dashboard()["attempts"], [])

    def test_delete_never_downloaded_file_removes_bytes_and_blocks_links(self):
        issued = self.upload(b"unused")
        file_id = issued["file"]["id"]
        extra = self.admin.post("/api/admin/files/" + file_id + "/links", headers={"X-CSRF-Token": self.admin_csrf}).json
        stats = self.dashboard()
        self.assertTrue(stats["files"][0]["can_delete"])
        self.assertEqual(stats["files"][0]["delete_reason"], "")
        self.assertEqual(stats["summary"]["completed"], 0)
        self.assertEqual(stats["summary"]["attempts"], 0)
        self.assertEqual(self.delete_file(file_id).status_code, 200)
        self.assertFalse((self.app.extensions["storage"] / file_id).exists())
        stats = self.dashboard()
        self.assertEqual(stats["files"], [])
        self.assertEqual(stats["links"], [])
        self.assertEqual(stats["summary"]["attempts"], 0)
        for token in (issued["link"]["token"], extra["link"]["token"]):
            self.assertEqual(self.info(token).status_code, 404)
            self.assertEqual(self.claim(token).status_code, 404)
        self.assertEqual(self.admin.post("/api/admin/files/" + file_id + "/links", headers={"X-CSRF-Token": self.admin_csrf}).status_code, 404)

    def test_file_deletion_blocks_reserved_and_active_files(self):
        payload = b"busy"
        issued = self.upload(payload)
        file_id = issued["file"]["id"]
        self.assertTrue(self.dashboard()["files"][0]["can_delete"])
        reserved = self.claim(issued["link"]["token"]).json
        self.assertEqual(self.delete_file(file_id).json["code"], "file_busy")
        self.assertFalse(self.dashboard()["files"][0]["can_delete"])
        response = self.get_file(reserved, buffered=False)
        self.clock[0] += 600
        self.assertEqual(self.delete_file(file_id).json["code"], "file_busy")
        response.close()
        self.assertTrue(self.dashboard()["files"][0]["can_delete"])
        with patch.object(Path, "unlink", side_effect=PermissionError("in use")):
            self.assertEqual(self.delete_file(file_id).json["code"], "file_delete")
        self.assertEqual(len(self.dashboard()["files"]), 1)
        self.assertTrue((self.app.extensions["storage"] / file_id).exists())
        self.assertEqual(self.delete_file(file_id).status_code, 200)

    def test_history_clear_and_file_delete_require_admin_and_csrf(self):
        file_id = self.upload()["file"]["id"]
        for method, path in (("POST", "/api/admin/history/clear"), ("DELETE", "/api/admin/files/" + file_id)):
            self.assertEqual(self.client.open(path, method=method).status_code, 401)
            self.assertEqual(self.admin.open(path, method=method).status_code, 403)
            self.assertEqual(self.admin.open(path, method=method, headers={"X-CSRF-Token": self.admin_csrf, "Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(len(self.dashboard()["files"]), 1)

    def test_existing_database_migration_preserves_counts_and_pending_ack(self):
        payload = b"old schema"
        completed = self.claim(self.upload(payload)["link"]["token"]).json
        self.get_file(completed).close()
        self.complete(completed, payload)
        pending = self.claim(self.upload(payload)["link"]["token"]).json
        self.get_file(pending).close()
        with closing(sqlite3.connect(self.app.extensions["db_path"])) as db, db:
            db.execute("ALTER TABLE files DROP COLUMN deleted_at")
            for column in ("last_attempt_id", "transfer_complete", "counted_completed"):
                db.execute("ALTER TABLE links DROP COLUMN " + column)
        self.app = create_app(self.config)
        self.client.application = self.admin.application = self.app
        self.assertEqual(self.dashboard()["summary"]["completed"], 1)
        self.assertEqual(self.complete(pending, payload).status_code, 200)
        self.assertEqual(self.dashboard()["summary"]["completed"], 2)

    def test_login_rate_limit_and_session_expiry(self):
        for _ in range(5):
            response = self.client.post("/api/admin/login", json={"password": "wrong"}, headers={"X-CSRF-Token": self.csrf})
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "test-password-for-service"}, headers={"X-CSRF-Token": self.csrf}).status_code, 429)
        self.clock[0] += 901
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "test-password-for-service"}, headers={"X-CSRF-Token": self.csrf}).status_code, 200)
        self.clock[0] += 8 * 3600
        self.assertEqual(self.client.get("/api/admin/dashboard").status_code, 401)

    def test_upload_limit_and_paths_are_private(self):
        self.assertEqual(MAX_FILE_SIZE, 90 * 1024 * 1024)
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x" * 4097), "large.bin")}, headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(list((Path(self.directory.name) / "files").iterdir()), [])
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x"), "../../escape.txt")}, headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 400)
        # 파서에서 경로 문자가 정규화되더라도 저장 경로는 난수 ID만 사용해야 합니다.
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x"), "..\\escape.txt")}, headers={"X-CSRF-Token": self.admin_csrf})
        if response.status_code == 201:
            self.assertNotIn("\\", response.json["file"]["name"])
            self.assertNotIn("/", response.json["file"]["name"])
            self.assertFalse((Path(self.directory.name) / "escape.txt").exists())
            self.assertTrue((Path(self.directory.name) / "files" / response.json["file"]["id"]).is_file())
        else:
            self.assertEqual(response.status_code, 400)
        issued = self.upload()
        for path in ("/data/settings.json", "/data/service.sqlite3", "/files/" + issued["file"]["id"], "/assets/../../app.py", "/assets/../index.html"):
            self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.claim("../invalid").status_code, 404)

    def test_headers_secure_cookie_and_public_address(self):
        set_tunnel_state(self.app, "ready", "https://example-test.trycloudflare.com")
        response = self.app.test_client().get("/api/session", base_url="https://example-test.trycloudflare.com")
        cookie = response.headers["Set-Cookie"]
        for flag in ("Secure", "HttpOnly", "SameSite=Strict"):
            self.assertIn(flag, cookie)
        for header in ("Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options"):
            self.assertIn(header, response.headers)
        self.assertIn("no-store", response.headers["Cache-Control"])
        self.assertEqual(self.app.test_client().get("/", base_url="https://evil.example").status_code, 400)
        token = self.upload()["link"]["token"]
        self.assertEqual(self.dashboard()["links"][0]["share_url"], "https://example-test.trycloudflare.com/index.html#token=" + token)

    def test_device_classification(self):
        self.assertEqual(device_details("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"), ("PC", "Windows", "Edge"))
        self.assertEqual(device_details("Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/140.0.0.0 Mobile Safari/537.36"), ("모바일", "Android", "Chrome"))
        self.assertEqual(device_details("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari/604.1"), ("모바일", "iOS / iPadOS", "Safari"))

    def test_actual_90mib_upload_boundary(self):
        self.app.config["MAX_FILE_SIZE"] = MAX_FILE_SIZE
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x" * MAX_FILE_SIZE), "limit.bin")},
                                   headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["file"]["size"], MAX_FILE_SIZE)
        response.request.environ["wsgi.input"].close()
        response.close()
        response = self.admin.post("/api/admin/files", data={"file": (io.BytesIO(b"x" * (MAX_FILE_SIZE + 1)), "too-large.bin")},
                                   headers={"X-CSRF-Token": self.admin_csrf})
        self.assertEqual(response.status_code, 413)
        response.request.environ["wsgi.input"].close()
        response.close()
        self.assertEqual(len(self.dashboard()["files"]), 1)
        self.assertEqual(len(list((Path(self.directory.name) / "files").iterdir())), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

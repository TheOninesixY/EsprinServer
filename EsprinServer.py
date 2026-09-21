#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SERVER_NAME = "EsprinServer"
SERVER_VERSION = 1
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8686
CONFIG_NAME = "config.json"
JOURNAL_NAME = "journal.log"
JOURNAL_ID_NAME = "journal.id"

ADMIN_FILE_NAME = "admin.json"
TOKENS_FILE_NAME = "tokens.json"
ADMIN_COOKIE_NAME = "esprin_admin"
ADMIN_PATH = "/admin"
SYNC_PATH = "/sync"
PBKDF2_ITERATIONS = 200_000
PBKDF2_SALT_BYTES = 16
SESSION_TTL_SECONDS = 12 * 60 * 60
LOGIN_WINDOW_SECONDS = 60
LOGIN_MAX_FAILURES = 10
TOKEN_TOUCH_INTERVAL_SECONDS = 60
MIN_PASSWORD_LENGTH = 8
DEFAULT_PAGE_LIMIT = 500
MAX_PAGE_LIMIT = 2000
MAX_DATA_CHARS = 8 * 1024 * 1024
FORBIDDEN_PATH_PARTS = ("..",)


def now_ms():
    return int(time.time() * 1000)


def sha256_text(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_relative_path(value):
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return ""
    if text.startswith("/"):
        return ""
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or any(part in FORBIDDEN_PATH_PARTS for part in parts):
        return ""
    return "/".join(parts)


def hash_password(password, iterations=PBKDF2_ITERATIONS, salt=None):
    salt = salt or secrets.token_bytes(PBKDF2_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(iterations, salt.hex(), digest.hex())


def verify_password(password, stored):
    try:
        scheme, iterations, salt_hex, digest_hex = str(stored).split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


class AdminStore:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.admin_path = os.path.join(data_dir, ADMIN_FILE_NAME)
        self.tokens_path = os.path.join(data_dir, TOKENS_FILE_NAME)
        self.lock = threading.RLock()
        self.password_hash = ""
        self.secret = ""
        self.tokens = []
        self.sessions = {}
        self.failures = {}
        self._load()

    def _load(self):
        os.makedirs(self.data_dir, exist_ok=True)

        try:
            with open(self.admin_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            self.password_hash = str(data.get("password") or "")
            self.secret = str(data.get("secret") or "")
        except (OSError, ValueError):
            pass

        if not self.secret:
            self.secret = secrets.token_hex(32)
            self._save_admin()

        try:
            with open(self.tokens_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            tokens = data.get("tokens") if isinstance(data, dict) else None
            if isinstance(tokens, list):
                self.tokens = [item for item in tokens if isinstance(item, dict) and item.get("id")]
        except (OSError, ValueError):
            pass

    def _save_admin(self):
        self._write_json(self.admin_path, {
            "version": 1,
            "password": self.password_hash,
            "secret": self.secret,
            "updatedAt": now_ms(),
        })

    def _save_tokens(self):
        self._write_json(self.tokens_path, {"version": 1, "tokens": self.tokens})

    def _write_json(self, path, value):
        try:
            temp = "{}.tmp".format(path)
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
            os.replace(temp, path)
        except OSError as error:
            sys.stderr.write("[admin] 写入 {} 失败：{}\n".format(path, error))

    def password_set(self):
        return bool(self.password_hash)

    def set_password(self, password):
        with self.lock:
            if self.password_set():
                return False
            self.password_hash = hash_password(password)
            self._save_admin()
            return True

    def verify_password(self, password):
        return verify_password(password, self.password_hash)

    def change_password(self, old_password, new_password):
        with self.lock:
            if not verify_password(old_password, self.password_hash):
                return False
            self.password_hash = hash_password(new_password)
            self.sessions.clear()
            self._save_admin()
            return True

    def create_session(self, ip):
        with self.lock:
            now = now_ms()
            self.sessions = {
                key: value for key, value in self.sessions.items()
                if now - value["lastSeenAt"] < SESSION_TTL_SECONDS * 1000
            }
            session_id = secrets.token_urlsafe(32)
            self.sessions[session_id] = {"createdAt": now, "lastSeenAt": now, "ip": ip}
            return session_id

    def touch_session(self, session_id):
        with self.lock:
            session = self.sessions.get(session_id)
            if not session:
                return False
            now = now_ms()
            if now - session["lastSeenAt"] > SESSION_TTL_SECONDS * 1000:
                self.sessions.pop(session_id, None)
                return False
            session["lastSeenAt"] = now
            return True

    def destroy_session(self, session_id):
        with self.lock:
            self.sessions.pop(session_id, None)

    def login_allowed(self, ip):
        with self.lock:
            now = time.time()
            history = [stamp for stamp in self.failures.get(ip, []) if now - stamp < LOGIN_WINDOW_SECONDS]
            self.failures[ip] = history
            return len(history) < LOGIN_MAX_FAILURES

    def note_login_failure(self, ip):
        with self.lock:
            self.failures.setdefault(ip, []).append(time.time())

    def _digest(self, token):
        return hmac.new(self.secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()

    def _find_by_id(self, token_id):
        for item in self.tokens:
            if item.get("id") == token_id:
                return item
        return None

    def list_tokens(self):
        with self.lock:
            return [{key: value for key, value in item.items() if key != "digest"} for item in self.tokens]

    def create_token(self, name, device):
        with self.lock:
            token = "esn_" + secrets.token_urlsafe(24)
            record = {
                "id": "tk_" + secrets.token_hex(6),
                "name": str(name or "").strip() or "未命名设备",
                "device": str(device or "").strip(),
                "digest": self._digest(token),
                "createdAt": now_ms(),
                "lastUsedAt": 0,
                "lastDeviceId": "",
                "enabled": True,
            }
            self.tokens.append(record)
            self._save_tokens()
            return record["id"], token

    def rotate_token(self, token_id):
        with self.lock:
            record = self._find_by_id(token_id)
            if not record:
                return None
            token = "esn_" + secrets.token_urlsafe(24)
            record["digest"] = self._digest(token)
            record["lastUsedAt"] = 0
            self._save_tokens()
            return token

    def update_token(self, token_id, name=None, device=None, enabled=None):
        with self.lock:
            record = self._find_by_id(token_id)
            if not record:
                return None
            if name is not None:
                record["name"] = str(name).strip() or record.get("name", "")
            if device is not None:
                record["device"] = str(device).strip()
            if enabled is not None:
                record["enabled"] = bool(enabled)
            self._save_tokens()
            return {key: value for key, value in record.items() if key != "digest"}

    def delete_token(self, token_id):
        with self.lock:
            before = len(self.tokens)
            self.tokens = [item for item in self.tokens if item.get("id") != token_id]
            if len(self.tokens) == before:
                return False
            self._save_tokens()
            return True

    def find_token_by_plain(self, token):
        if not token:
            return None
        digest = self._digest(token)
        with self.lock:
            for item in self.tokens:
                if hmac.compare_digest(str(item.get("digest") or ""), digest):
                    return item
        return None

    def note_token_use(self, record, device_id):
        with self.lock:
            now = now_ms()
            changed = False
            if device_id and record.get("lastDeviceId") != device_id:
                record["lastDeviceId"] = device_id
                changed = True
            if now - int(record.get("lastUsedAt") or 0) > TOKEN_TOUCH_INTERVAL_SECONDS * 1000:
                record["lastUsedAt"] = now
                changed = True
            if changed:
                self._save_tokens()


class Journal:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, JOURNAL_NAME)
        self.lock = threading.Lock()
        self.latest_seq = 0
        self.op_ids = {}
        self.files = {}
        self.deleted = {}
        self.count = 0
        self._load()
        self.journal_id = self._load_or_create_id()

    def _load_or_create_id(self):
        path = os.path.join(self.data_dir, JOURNAL_ID_NAME)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass

        value = uuid.uuid4().hex
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(value)
        except OSError:
            pass
        return value

    def _load(self):
        os.makedirs(self.data_dir, exist_ok=True)
        if not os.path.exists(self.path):
            return

        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._index(entry)

    def _index(self, entry):
        seq = int(entry.get("seq") or 0)
        if seq <= 0:
            return
        self.latest_seq = max(self.latest_seq, seq)
        self.count += 1
        op_id = entry.get("opId")
        if op_id:
            self.op_ids[op_id] = seq

        path = entry.get("path")
        if not path:
            return
        if entry.get("op") == "del":
            self.files.pop(path, None)
            self.deleted[path] = seq
        else:
            self.files[path] = {"hash": entry.get("hash", ""), "seq": seq, "device": entry.get("device", "")}
            self.deleted.pop(path, None)

    def append_many(self, device, ops):
        accepted = []
        with self.lock:
            with open(self.path, "a", encoding="utf-8") as handle:
                for raw in ops:
                    op_id = str(raw.get("opId") or "")
                    if op_id and op_id in self.op_ids:
                        accepted.append({"opId": op_id, "seq": self.op_ids[op_id], "duplicate": True})
                        continue

                    kind = raw.get("op")
                    if kind not in ("put", "del"):
                        accepted.append({"opId": op_id, "seq": 0, "error": "未知操作类型"})
                        continue

                    path = normalize_relative_path(raw.get("path"))
                    if not path:
                        accepted.append({"opId": op_id, "seq": 0, "error": "路径不合法"})
                        continue

                    entry = {
                        "seq": self.latest_seq + 1,
                        "opId": op_id,
                        "device": str(raw.get("device") or device or ""),
                        "time": int(raw.get("time") or now_ms()),
                        "op": kind,
                        "path": path,
                    }
                    if kind == "put":
                        data = raw.get("data")
                        if not isinstance(data, str):
                            accepted.append({"opId": op_id, "seq": 0, "error": "put 缺少内容"})
                            continue
                        if len(data) > MAX_DATA_CHARS:
                            accepted.append({"opId": op_id, "seq": 0, "error": "内容过大"})
                            continue
                        entry["data"] = data
                        entry["encoding"] = "base64" if raw.get("encoding") == "base64" else "utf8"
                        entry["hash"] = raw.get("hash") or (
                            sha256_text(data) if entry["encoding"] == "utf8" else ""
                        )
                    else:
                        entry["hash"] = raw.get("hash") or ""

                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())

                    self._index(entry)
                    accepted.append({"opId": op_id, "seq": entry["seq"]})

        return accepted

    def read_ops(self, since, limit):
        result = []
        if not os.path.exists(self.path):
            return result

        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = int(entry.get("seq") or 0)
                if seq <= since:
                    continue
                result.append(entry)
                if len(result) >= limit:
                    break
        return result

    def read_file(self, path):
        latest = None
        if not os.path.exists(self.path):
            return None
        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("path") != path:
                    continue
                latest = entry
        if not latest or latest.get("op") != "put":
            return None
        return latest

    def state(self):
        return {
            "latestSeq": self.latest_seq,
            "count": self.count,
            "files": self.files,
            "deleted": self.deleted,
        }


MANAGER_DIR_NAME = "manager"
MANAGER_INDEX_NAME = "index.html"
ASSET_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

MISSING_PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>找不到管理页面</title></head>
<body style="font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;padding:40px;background:#0d1117;color:#f0f6fc">
<h1 style="font-size:18px;margin-bottom:12px">找不到管理页面</h1>
<p style="color:#8b949e">服务端期望在下面这个位置读到 index.html：</p>
<p><code style="background:#21262d;padding:6px 10px;border-radius:6px;display:inline-block">{path}</code></p>
<p style="color:#8b949e">把仓库里的 manager/ 目录（index.html、app.css、app.js）放到服务端脚本旁边，再刷新本页。</p>
</body></html>
"""


def manager_dir():
    return os.path.join(SCRIPT_DIR, MANAGER_DIR_NAME)


def read_manager_index():
    path = os.path.join(manager_dir(), MANAGER_INDEX_NAME)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return MISSING_PAGE_HTML.replace("{path}", path)


class ApiHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    journal = None
    admin = None
    token = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, status, payload=None, raw=None, content_type="application/json; charset=utf-8", extra_headers=None):
        body = raw if raw is not None else json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _cookie_value(self, name):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            if key.strip() == name:
                return value.strip()
        return ""

    def _session_id(self):
        return self._cookie_value(ADMIN_COOKIE_NAME)

    def _has_session(self):
        session_id = self._session_id()
        return bool(session_id) and self.admin.touch_session(session_id)

    def _session_cookie(self, session_id):
        return "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}".format(
            ADMIN_COOKIE_NAME, session_id, SESSION_TTL_SECONDS)

    def _expired_cookie(self):
        return "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0".format(ADMIN_COOKIE_NAME)

    def _client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def _send_manager_asset(self, path):
        relative = path[len(ADMIN_PATH):].lstrip("/") or MANAGER_INDEX_NAME
        root = manager_dir()
        target = os.path.abspath(os.path.join(root, relative))
        if not target.startswith(root + os.sep) or not os.path.isfile(target):
            self._send(404, {"ok": False, "error": "找不到文件"})
            return

        try:
            with open(target, "rb") as handle:
                body = handle.read()
        except OSError:
            self._send(500, {"ok": False, "error": "读取失败"})
            return

        extension = os.path.splitext(target)[1].lower()
        self._send(200, raw=body,
                   content_type=ASSET_CONTENT_TYPES.get(extension, "application/octet-stream"),
                   extra_headers={"Cache-Control": "no-store"})

    def _authorize_api(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None, "缺少访问令牌"
        value = header[7:].strip()

        if self.token and hmac.compare_digest(value, self.token):
            return {"id": "", "name": "启动参数 --token", "device": "", "builtin": True}, ""

        record = self.admin.find_token_by_plain(value)
        if not record:
            return None, "令牌无效（请在管理后台确认，或看看是不是刚重置过）"
        if not record.get("enabled", True):
            return None, "该令牌已在管理后台停用"
        return record, ""

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 32 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == SYNC_PATH + "/health":
            self._send(200, {
                "ok": True,
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
                "journalId": self.journal.journal_id,
                "latestSeq": self.journal.latest_seq,
                "authRequired": bool(self.token) or bool(self.admin.list_tokens()),
                "syncPath": SYNC_PATH,
                "adminPath": ADMIN_PATH,
            })
            return

        if parsed.path == "/":
            self._send(200, {
                "ok": True,
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
                "syncPath": SYNC_PATH,
                "adminPath": ADMIN_PATH,
            })
            return

        if parsed.path == ADMIN_PATH or parsed.path == ADMIN_PATH + "/":
            page = read_manager_index()
            self._send(200, raw=page.encode("utf-8"), content_type="text/html; charset=utf-8",
                       extra_headers={"Cache-Control": "no-store"})
            return

        if parsed.path.startswith(ADMIN_PATH + "/api/"):
            self._handle_admin_get(parsed.path)
            return

        if parsed.path.startswith(ADMIN_PATH + "/"):
            self._send_manager_asset(parsed.path)
            return

        record, error = self._authorize_api()
        if not record:
            self._send(401, {"ok": False, "error": error})
            return

        if parsed.path == SYNC_PATH + "/ops":
            since = int((query.get("since") or ["0"])[0] or 0)
            limit = int((query.get("limit") or [str(DEFAULT_PAGE_LIMIT)])[0] or DEFAULT_PAGE_LIMIT)
            limit = max(1, min(limit, MAX_PAGE_LIMIT))
            ops = self.journal.read_ops(since, limit)
            self._send(200, {
                "ok": True,
                "latestSeq": self.journal.latest_seq,
                "ops": ops,
                "hasMore": bool(ops) and ops[-1]["seq"] < self.journal.latest_seq,
            })
            return

        if parsed.path == SYNC_PATH + "/state":
            state = self.journal.state()
            state["ok"] = True
            state["journalId"] = self.journal.journal_id
            self._send(200, state)
            return

        if parsed.path == SYNC_PATH + "/file":
            path = normalize_relative_path((query.get("path") or [""])[0])
            if not path:
                self._send(400, {"ok": False, "error": "路径不合法"})
                return
            entry = self.journal.read_file(path)
            if not entry:
                self._send(404, {"ok": False, "error": "没有该文件（可能已被删除）"})
                return
            self._send(200, {
                "ok": True,
                "path": path,
                "hash": entry.get("hash", ""),
                "encoding": entry.get("encoding", "utf8"),
                "data": entry.get("data", ""),
                "seq": entry.get("seq", 0),
            })
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith(ADMIN_PATH + "/api/"):
            payload = self._read_json() or {}
            self._handle_admin_post(parsed.path, payload)
            return

        record, error = self._authorize_api()
        if not record:
            self._send(401, {"ok": False, "error": error})
            return

        if parsed.path == SYNC_PATH + "/ops":
            payload = self._read_json()
            if not payload or not isinstance(payload.get("ops"), list):
                self._send(400, {"ok": False, "error": "请求体需要 {device, ops:[...]}"})
                return
            if not payload["ops"]:
                self._send(200, {"ok": True, "latestSeq": self.journal.latest_seq, "accepted": []})
                return

            bound_device = str(record.get("device") or "")
            device = bound_device or str(payload.get("device") or "")
            if bound_device:
                for raw in payload["ops"]:
                    if isinstance(raw, dict):
                        raw.pop("device", None)
            accepted = self.journal.append_many(device, payload["ops"])
            if record.get("id"):
                self.admin.note_token_use(record, str(payload.get("device") or ""))

            rejected = [item for item in accepted if item.get("error")]
            self._send(200, {
                "ok": not rejected,
                "error": rejected[0]["error"] if rejected else "",
                "latestSeq": self.journal.latest_seq,
                "accepted": accepted,
            })
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    def _handle_admin_get(self, path):
        if path == ADMIN_PATH + "/api/status":
            self._send(200, {
                "ok": True,
                "version": SERVER_VERSION,
                "passwordSet": self.admin.password_set(),
                "loggedIn": self._has_session(),
                "tokenCount": len(self.admin.list_tokens()),
            })
            return

        if not self._has_session():
            self._send(401, {"ok": False, "error": "请先登录管理后台"})
            return

        if path == ADMIN_PATH + "/api/tokens":
            self._send(200, {"ok": True, "tokens": self.admin.list_tokens()})
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    def _handle_admin_post(self, path, payload):
        if path == ADMIN_PATH + "/api/setup-password":
            password = str(payload.get("password") or "")
            if len(password) < MIN_PASSWORD_LENGTH:
                self._send(400, {"ok": False, "error": "密码至少 {} 位".format(MIN_PASSWORD_LENGTH)})
                return
            if not self.admin.set_password(password):
                self._send(400, {"ok": False, "error": "管理密码已经设置过了，请用现有密码登录"})
                return
            session_id = self.admin.create_session(self._client_ip())
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        if path == ADMIN_PATH + "/api/login":
            ip = self._client_ip()
            if not self.admin.login_allowed(ip):
                self._send(429, {"ok": False, "error": "尝试次数过多，请稍后再试"})
                return
            if not self.admin.verify_password(str(payload.get("password") or "")):
                self.admin.note_login_failure(ip)
                self._send(401, {"ok": False, "error": "密码不正确"})
                return
            session_id = self.admin.create_session(ip)
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        if not self._has_session():
            self._send(401, {"ok": False, "error": "请先登录管理后台"})
            return

        if path == ADMIN_PATH + "/api/logout":
            self.admin.destroy_session(self._session_id())
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._expired_cookie()})
            return

        if path == ADMIN_PATH + "/api/password":
            new_password = str(payload.get("newPassword") or "")
            if len(new_password) < MIN_PASSWORD_LENGTH:
                self._send(400, {"ok": False, "error": "新密码至少 {} 位".format(MIN_PASSWORD_LENGTH)})
                return
            if not self.admin.change_password(str(payload.get("oldPassword") or ""), new_password):
                self._send(400, {"ok": False, "error": "当前密码不正确"})
                return
            session_id = self.admin.create_session(self._client_ip())
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        if path == ADMIN_PATH + "/api/tokens":
            token_id, token = self.admin.create_token(payload.get("name"), payload.get("device"))
            self._send(200, {
                "ok": True,
                "id": token_id,
                "token": token,
                "tokens": self.admin.list_tokens(),
            })
            return

        if path == ADMIN_PATH + "/api/tokens/rotate":
            token = self.admin.rotate_token(str(payload.get("id") or ""))
            if not token:
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "token": token, "tokens": self.admin.list_tokens()})
            return

        if path == ADMIN_PATH + "/api/tokens/update":
            record = self.admin.update_token(
                str(payload.get("id") or ""), payload.get("name"), payload.get("device"), payload.get("enabled"))
            if not record:
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "tokens": self.admin.list_tokens()})
            return

        if path == ADMIN_PATH + "/api/tokens/delete":
            if not self.admin.delete_token(str(payload.get("id") or "")):
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "tokens": self.admin.list_tokens()})
            return

        self._send(404, {"ok": False, "error": "未知接口"})


def create_server(host, port, data_dir, token):
    journal = Journal(data_dir)
    admin = AdminStore(data_dir)
    handler = type("BoundApiHandler", (ApiHandler,), {"journal": journal, "admin": admin, "token": token})
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd, journal, admin


def selftest():
    import json as _json
    import tempfile
    import urllib.request
    import urllib.error

    failures = []

    def check(name, condition, detail=""):
        if condition:
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name} {detail}")
            failures.append(name)

    with tempfile.TemporaryDirectory() as tmp:
        data_dir = os.path.join(tmp, "data")
        httpd, journal, admin = create_server("127.0.0.1", 0, data_dir, "secret")
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{port}"
        cookies = {}

        def _absorb(response):
            value = response.headers.get("Set-Cookie")
            if not value:
                return
            pair = value.split(";", 1)[0]
            if "=" not in pair:
                return
            key, name = pair.split("=", 1)
            if name.strip():
                cookies[key.strip()] = name.strip()
            else:
                cookies.pop(key.strip(), None)

        def call(method, path, payload=None, token=None, use_cookie=False):
            data = None
            headers = {}
            if payload is not None:
                data = _json.dumps(payload).encode("utf-8")
                headers["Content-Type"] = "application/json"
            request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
            if token is not None:
                request.add_header("Authorization", "Bearer " + token)
            if use_cookie and cookies:
                request.add_header("Cookie", "; ".join(f"{key}={value}" for key, value in cookies.items()))
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    body = response.read().decode("utf-8")
                    _absorb(response)
                    return response.status, (_json.loads(body) if body.strip().startswith(("{", "[")) else {"_raw": body})
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8")
                _absorb(error)
                try:
                    parsed = _json.loads(body) if body.strip() else {}
                except ValueError:
                    parsed = {"_raw": body}
                return error.code, parsed

        def get(path, token="secret", cookie=False):
            return call("GET", path, token=token, use_cookie=cookie)

        def post(path, payload, token="secret", cookie=False):
            return call("POST", path, payload, token=token, use_cookie=cookie)

        sync = SYNC_PATH

        print("配置：")
        config_file = os.path.join(tmp, CONFIG_NAME)
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"host": "0.0.0.0", "port": 4936}')
        check("优先用数据目录里的 config.json", config_path(tmp) == config_file, config_path(tmp))
        check("从 config.json 读地址与端口", read_config(tmp) == {"port": 4936, "host": "0.0.0.0"}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"host": "  ", "port": "abc"}')
        check("地址为空、端口不是数字时都忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"port": 70000}')
        check("端口超出范围时忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('not json')
        check("config.json 不是 JSON 时忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        os.remove(config_file)

        print("接口：")
        status, health = get(sync + "/health", token=None)
        check("health 不需要令牌", status == 200 and health.get("latestSeq") == 0, repr(health))
        check("health 标明需要令牌", health.get("authRequired") is True)
        check("health 带回日志身份", isinstance(health.get("journalId"), str) and len(health["journalId"]) > 0)
        check("health 告知同步接口前缀", health.get("syncPath") == SYNC_PATH, repr(health.get("syncPath")))

        status, _ = get(sync + "/ops?since=0", token=None)
        check("缺令牌时 401", status == 401)
        status, _ = get(sync + "/ops?since=0", token="wrong")
        check("令牌错误时 401", status == 401)

        status, body = post(sync + "/ops", {
            "device": "dev-a",
            "ops": [
                {"opId": "a-1", "op": "put", "path": "notes/one.md", "data": "第一篇", "hash": sha256_text("第一篇"), "time": 1000},
                {"opId": "a-2", "op": "put", "path": "notes/two.md", "data": "第二篇", "hash": sha256_text("第二篇"), "time": 1001},
                {"opId": "a-3", "op": "del", "path": "notes/two.md", "time": 1002},
            ],
        })
        check("追加三条操作", status == 200 and [item["seq"] for item in body["accepted"]] == [1, 2, 3], repr(body))

        status, body = post(sync + "/ops", {
            "device": "dev-a",
            "ops": [{"opId": "a-3", "op": "del", "path": "notes/two.md", "time": 1002}],
        })
        check("重复提交同一条 opId 不重复写", body["accepted"][0].get("duplicate") is True and body["latestSeq"] == 3, repr(body))

        status, body = get(sync + "/ops?since=0")
        check("拉取全部操作", len(body["ops"]) == 3 and body["ops"][0]["seq"] == 1, repr(body)[:200])

        status, body = get(sync + "/ops?since=2")
        check("since 之后只回传新操作", [item["seq"] for item in body["ops"]] == [3], repr(body))

        status, body = get(sync + "/state")
        check("state 里只留存活文件", list(body["files"].keys()) == ["notes/one.md"], repr(body["files"]))
        check("state 里保留删除记录", body["deleted"].get("notes/two.md") == 3, repr(body["deleted"]))

        status, body = get(sync + "/file?path=notes/one.md")
        check("能重放出文件内容", status == 200 and body["data"] == "第一篇", repr(body))
        status, body = get(sync + "/file?path=notes/two.md")
        check("已删除的文件查不到", status == 404, repr(body))

        status, body = post(sync + "/ops", {"device": "dev-a", "ops": [{"op": "put", "path": "../evil.md", "data": "x"}]})
        check("越界路径被拒绝", body["ok"] is False and "路径不合法" in body.get("error", ""), repr(body))

        print("管理后台：")
        status, page = get(ADMIN_PATH, token=None)
        check("管理页面可直接打开", status == 200 and "<!DOCTYPE html>" in page.get("_raw", ""), repr(page)[:160])

        status, css = get(ADMIN_PATH + "/app.css", token=None)
        check("管理页静态资源可直接取用", status == 200 and "--bg-body" in css.get("_raw", ""), repr(css)[:80])

        status, body = get(ADMIN_PATH + "/app.js", token=None)
        check("管理页脚本可直接取用", status == 200 and "API_BASE" in body.get("_raw", ""), repr(body)[:80])

        status, body = get(ADMIN_PATH + "/%2e%2e/%2e%2e/EsprinServer.py", token=None)
        check("静态资源不允许穿越出 manager 目录", status == 404, repr(body))

        status, body = get(ADMIN_PATH + "/api/status", token=None)
        check("初始状态：未设密码、未登录", status == 200 and body.get("passwordSet") is False and body.get("loggedIn") is False, repr(body))

        status, body = get(ADMIN_PATH + "/api/tokens", token=None)
        check("未登录不能看令牌", status == 401, repr(body))

        status, body = post(ADMIN_PATH + "/api/setup-password", {"password": "123"}, token=None, cookie=True)
        check("密码太短被拒绝", status == 400, repr(body))

        status, body = post(ADMIN_PATH + "/api/setup-password", {"password": "admin-pass-1"}, token=None, cookie=True)
        check("首次设置密码并自动登录", status == 200 and ADMIN_COOKIE_NAME in cookies, repr(body))

        status, body = post(ADMIN_PATH + "/api/setup-password", {"password": "another-pass"}, token=None)
        check("密码只能设置一次", status == 400, repr(body))

        status, body = get(ADMIN_PATH + "/api/tokens", token=None, cookie=True)
        check("登录后可以看令牌列表", status == 200 and body.get("tokens") == [], repr(body))

        status, body = post(ADMIN_PATH + "/api/tokens", {"name": "台式机", "device": "dev-bound"}, token=None, cookie=True)
        token_a = body.get("token", "")
        check("创建令牌并返回一次明文", status == 200 and token_a.startswith("esn_") and len(body["tokens"]) == 1, repr(body)[:160])
        check("列表里不带摘要", "digest" not in body["tokens"][0], repr(body["tokens"][0]))

        reloaded = AdminStore(data_dir)
        check("密码与令牌都已落盘", reloaded.password_set() and len(reloaded.tokens) == 1, f"{reloaded.password_set()}/{len(reloaded.tokens)}")

        status, body = post(sync + "/ops", {
            "device": "dev-lying",
            "ops": [{"opId": "b-1", "op": "put", "path": "notes/bound.md", "data": "绑定设备", "device": "dev-op-level", "hash": sha256_text("绑定设备"), "time": 2000}],
        }, token=token_a)
        check("管理后台的令牌能同步", status == 200 and body["accepted"][0].get("error") is None, repr(body))

        status, body = get(sync + "/ops?since=3", token=token_a)
        check("令牌绑定的设备优先于客户端自报", body["ops"][0]["device"] == "dev-bound", repr(body["ops"][0]))

        status, body = get(ADMIN_PATH + "/api/tokens", token=None, cookie=True)
        check("记下了最近的设备", body["tokens"][0].get("lastDeviceId") == "dev-lying" and body["tokens"][0].get("lastUsedAt", 0) > 0, repr(body["tokens"][0]))
        token_id = body["tokens"][0]["id"]

        status, body = post(ADMIN_PATH + "/api/tokens/update", {"id": token_id, "name": "笔记本", "device": "dev-new"}, token=None, cookie=True)
        check("修改名称与设备", status == 200 and body["tokens"][0]["name"] == "笔记本" and body["tokens"][0]["device"] == "dev-new", repr(body)[:160])

        status, body = post(ADMIN_PATH + "/api/tokens/update", {"id": token_id, "enabled": False}, token=None, cookie=True)
        status2, body2 = get(sync + "/ops?since=0", token=token_a)
        check("停用后令牌立刻失效", status == 200 and status2 == 401 and "停用" in body2.get("error", ""), repr(body2))

        status, body = post(ADMIN_PATH + "/api/tokens/rotate", {"id": token_id}, token=None, cookie=True)
        token_b = body.get("token", "")
        status2, _ = get(sync + "/ops?since=0", token=token_a)
        status3, _ = get(sync + "/ops?since=0", token=token_b)
        check("重置后旧令牌失效、新令牌可用", status == 200 and status2 == 401 and status3 == 200 and token_b != token_a, f"{status}/{status2}/{status3}")

        status, body = post(ADMIN_PATH + "/api/login", {"password": "wrong-pass"}, token=None)
        check("密码错误不能登录", status == 401, repr(body))

        old_cookie = cookies[ADMIN_COOKIE_NAME]
        status, body = post(ADMIN_PATH + "/api/password", {"oldPassword": "nope", "newPassword": "new-pass-12"}, token=None, cookie=True)
        check("当前密码不对时拒绝改密码", status == 400, repr(body))

        status, body = post(ADMIN_PATH + "/api/password", {"oldPassword": "admin-pass-1", "newPassword": "new-pass-12"}, token=None, cookie=True)
        check("改密码成功并换发会话", status == 200 and cookies[ADMIN_COOKIE_NAME] != old_cookie, repr(body))

        current_cookie = cookies[ADMIN_COOKIE_NAME]
        cookies[ADMIN_COOKIE_NAME] = old_cookie
        status, body = get(ADMIN_PATH + "/api/tokens", token=None, cookie=True)
        check("改密码后旧会话失效", status == 401, repr(body))
        cookies[ADMIN_COOKIE_NAME] = current_cookie

        status, body = post(ADMIN_PATH + "/api/login", {"password": "new-pass-12"}, token=None, cookie=True)
        check("新密码可以登录", status == 200, repr(body))

        status, body = post(ADMIN_PATH + "/api/tokens/delete", {"id": token_id}, token=None, cookie=True)
        status2, _ = get(sync + "/ops?since=0", token=token_b)
        check("删除令牌后立即失效", status == 200 and status2 == 401, f"{status}/{status2}")

        status, body = post(ADMIN_PATH + "/api/logout", {}, token=None, cookie=True)
        status2, _ = get(ADMIN_PATH + "/api/tokens", token=None, cookie=True)
        check("退出登录后会话失效", status == 200 and status2 == 401, f"{status}/{status2}")

        check("启动参数 --token 仍然可用", get(sync + "/ops?since=0")[0] == 200)

        httpd.shutdown()
        httpd.server_close()

        print("重启后重建索引：")
        reloaded = Journal(data_dir)
        check("最新序号一致", reloaded.latest_seq == 4, str(reloaded.latest_seq))
        check("日志身份保持不变", reloaded.journal_id == journal.journal_id, f"{reloaded.journal_id} != {journal.journal_id}")
        check("存活文件一致", sorted(reloaded.files.keys()) == ["notes/bound.md", "notes/one.md"], repr(reloaded.files))
        check("删除记录一致", reloaded.deleted.get("notes/two.md") == 3, repr(reloaded.deleted))
        check("重启后仍能续写", reloaded.append_many("dev-a", [{"opId": "a-4", "op": "put", "path": "notes/three.md", "data": "3"}])[0]["seq"] == 5)

        print("重启后管理数据：")
        reloaded_admin = AdminStore(data_dir)
        check("管理密码重新加载后仍然有效", reloaded_admin.verify_password("new-pass-12"), "密码校验失败")
        check("令牌保持删除后的状态", reloaded_admin.tokens == [], repr(reloaded_admin.tokens))
        check("会话只存在内存里", reloaded_admin.sessions == {}, repr(reloaded_admin.sessions))

    print()
    if failures:
        print(f"自测失败 {len(failures)} 项：" + "、".join(failures))
        return 1
    print("自测全部通过")
    return 0


def config_path(data_dir):
    for candidate in (
        os.path.join(data_dir, CONFIG_NAME),
        os.path.join(SCRIPT_DIR, CONFIG_NAME),
        os.path.join(SCRIPT_DIR, "data", CONFIG_NAME),
    ):
        if os.path.isfile(candidate):
            return candidate
    return os.path.join(data_dir, CONFIG_NAME)


def read_config(data_dir):
    path = config_path(data_dir)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}

    config = {}

    try:
        port = int(data.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if 1 <= port <= 65535:
        config["port"] = port

    host = str(data.get("host") or "").strip()
    if host:
        config["host"] = host

    return config


def lan_address():
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return ""


def main(argv=None):
    parser = argparse.ArgumentParser(description="Esprin Nemo 同步服务端（操作日志）")
    parser.add_argument("--host", help=f"监听地址，不传则用 {CONFIG_NAME} 里的 host，再不行用 {DEFAULT_HOST}（局域网共享可写 0.0.0.0）")
    parser.add_argument("--port", type=int, help=f"监听端口，不传则用 {CONFIG_NAME} 里的 port，再不行用 {DEFAULT_PORT}")
    parser.add_argument("--data", default="./data", help="日志存放目录")
    parser.add_argument("--token", default=os.environ.get("ESPRIN_TOKEN", ""), help="访问令牌，留空则不校验")
    parser.add_argument("--selftest", action="store_true", help="跑一遍内置自测后退出")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    data_dir = os.path.abspath(args.data)
    os.makedirs(data_dir, exist_ok=True)

    config_file = config_path(data_dir)
    config = read_config(data_dir)
    host = args.host or config.get("host") or DEFAULT_HOST
    port = args.port or config.get("port") or DEFAULT_PORT
    host_source = "--host 参数" if args.host else (config_file if config.get("host") else "内置默认值")
    port_source = "--port 参数" if args.port else (config_file if config.get("port") else "内置默认值")

    httpd, journal, admin = create_server(host, port, data_dir, args.token)

    bound_host, bound_port = httpd.server_address[:2]
    if bound_host in ("0.0.0.0", "::", ""):
        url_host = lan_address() or DEFAULT_HOST
    else:
        url_host = bound_host

    if host_source == port_source:
        where = f"来自 {host_source}"
    else:
        where = f"地址来自 {host_source}，端口来自 {port_source}"

    print(f"{SERVER_NAME} v{SERVER_VERSION} 已启动")
    print(f"  数据：{data_dir}")
    print(f"  配置：{config_file}" + ("" if os.path.isfile(config_file) else "（这个文件不存在，地址与端口都走默认值）"))
    print(f"  监听：{bound_host}:{bound_port}（{where}）")
    print(f"  同步：http://{url_host}:{bound_port}{SYNC_PATH}/*（客户端里只填 http://{url_host}:{bound_port} 就行）")
    print(f"  日志：{os.path.join(data_dir, JOURNAL_NAME)}（journalId {journal.journal_id}）")
    print(f"  管理：http://{url_host}:{bound_port}{ADMIN_PATH} "
          + ("（已设置管理密码）" if admin.password_set() else "（首次打开会引导你设置管理密码）"))
    print(f"  授权：{'--token 已启用' if args.token else '由管理后台发放令牌'}，"
          f"当前 {len(admin.list_tokens())} 个令牌")
    print(f"  当前：{journal.count} 条操作，最新序号 {journal.latest_seq}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

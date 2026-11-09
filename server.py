import json
import secrets
import socket
import threading
import time

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# ============================================================
# 設定
# ============================================================

HOST = "0.0.0.0"
PORT = int(__import__("os").environ.get("PORT", 8080))


BASE_DIR = Path(__file__).resolve().parent

MAX_STUDENTS = 40
DEFAULT_STUDENTS = 20
DEFAULT_LAPS = 5

# 部屋情報はサーバーのメモリ内に保持します。
# サーバーを終了すると消えます。
rooms = {}
rooms_lock = threading.RLock()


# ============================================================
# 補助
# ============================================================

def local_ip_address():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        sock.connect(("192.0.2.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return "IPアドレスを確認してください"
    finally:
        sock.close()


def new_student(index):
    return {
        "id": index,
        "name": f"生徒{index + 1:02d}",
        "target": DEFAULT_LAPS,
        "remaining": DEFAULT_LAPS,
        "finish_time": None,
        "completed_laps": None,
        "revision": 0,
    }


def new_room():
    # 12桁の英数字。Aを起動するたびに発行。
    while True:
        key = secrets.token_hex(6).upper()

        if key not in rooms:
            break

    # Aだけが持つ管理用トークン。
    admin_token = secrets.token_urlsafe(24)

    return {
        "key": key,
        "admin_token": admin_token,
        "version": 0,
        "run_id": secrets.token_hex(8),
        "screen": "setup",
        "running": False,
        "started_at": None,
        "elapsed": 0.0,
        "draft_count": DEFAULT_STUDENTS,
        "student_count": DEFAULT_STUDENTS,
        "students": [
            new_student(i)
            for i in range(DEFAULT_STUDENTS)
        ],
        "last_b_seen": 0.0,
        "finish_requests": {},
    }


def elapsed_of(room):
    if room["running"] and room["started_at"] is not None:
        return max(0.0, time.monotonic() - room["started_at"])

    return room["elapsed"]


def room_snapshot(room):
    return {
        "key": room["key"],
        "version": room["version"],
        "run_id": room["run_id"],
        "screen": room["screen"],
        "running": room["running"],
        "elapsed": elapsed_of(room),
        "draft_count": room["draft_count"],
        "student_count": room["student_count"],
        "students": [
            dict(student)
            for student in room["students"][:room["student_count"]]
        ],
        "b_connected": (
            room["last_b_seen"] > 0
            and time.monotonic() - room["last_b_seen"] < 3.0
        ),
    }


def get_integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{label}は{minimum}〜{maximum}の整数で入力してください。"
        )

    return value


def get_student(room, value):
    student_id = get_integer(
        value,
        0,
        room["student_count"] - 1,
        "生徒番号",
    )

    return room["students"][student_id]


def require_admin(room, token):
    if not isinstance(token, str):
        raise PermissionError("Aの認証情報がありません。")

    if not secrets.compare_digest(room["admin_token"], token):
        raise PermissionError("Aの認証情報が正しくありません。")


def require_counter(room):
    if room["screen"] != "counter":
        raise ValueError("記録画面で操作してください。")


def require_running(room):
    require_counter(room)

    if not room["running"]:
        raise ValueError("計測開始後に操作してください。")


# ============================================================
# サーバー
# ============================================================

class Handler(BaseHTTPRequestHandler):

    def log_message(self, format_string, *args):
        print(
            f"{self.address_string()} - "
            f"{format_string % args}"
        )

    def send_json(self, status, payload):
        body = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")

        try:
            self.send_response(status)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, filename, content_type):
        path = BASE_DIR / filename

        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))

            if not 1 <= length <= 8192:
                raise ValueError("送信データのサイズが不正です。")

            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))

            if not isinstance(payload, dict):
                raise ValueError("送信データの形式が不正です。")

            return payload

        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("送信データを読み取れませんでした。")

    def get_room_and_role(self):
        key = self.headers.get("X-Room-Key", "").strip().upper()
        role = self.headers.get("X-Role", "").strip().upper()
        admin_token = self.headers.get("X-Admin-Token", "")

        if role not in ("A", "B"):
            raise PermissionError("役割を確認できません。")

        room = rooms.get(key)

        if room is None:
            raise ValueError(
                "接続キーが見つかりません。"
                "Aの画面に表示されたキーを確認してください。"
            )

        if role == "A":
            require_admin(room, admin_token)
        else:
            room["last_b_seen"] = time.monotonic()

        return room, role

    def do_GET(self):
        if self.path == "/":
            self.send_file(
                "index.html",
                "text/html; charset=utf-8",
            )
            return

        if self.path == "/style.css":
            self.send_file(
                "style.css",
                "text/css; charset=utf-8",
            )
            return

        if self.path == "/app.js":
            self.send_file(
                "app.js",
                "text/javascript; charset=utf-8",
            )
            return

        if self.path == "/api/state":
            try:
                with rooms_lock:
                    room, _ = self.get_room_and_role()
                    state = room_snapshot(room)

                self.send_json(200, {
                    "ok": True,
                    "state": state,
                })

            except PermissionError as error:
                self.send_json(403, {
                    "ok": False,
                    "error": str(error),
                })

            except ValueError as error:
                self.send_json(404, {
                    "ok": False,
                    "error": str(error),
                })

            return

        self.send_error(404)

    def do_POST(self):
        received_at = time.monotonic()

        try:
            payload = self.read_json()

            with rooms_lock:
                if self.path == "/api/create":
                    room = new_room()
                    rooms[room["key"]] = room

                    response = {
                        "ok": True,
                        "key": room["key"],
                        "admin_token": room["admin_token"],
                        "state": room_snapshot(room),
                    }

                else:
                    room, role = self.get_room_and_role()

                    if self.path == "/api/draft":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        if room["screen"] != "setup":
                            raise ValueError("人数選択画面で操作してください。")

                        count = get_integer(
                            payload.get("count"),
                            1,
                            MAX_STUDENTS,
                            "人数",
                        )

                        if room["draft_count"] != count:
                            room["draft_count"] = count
                            room["version"] += 1

                    elif self.path == "/api/prepare":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        if room["screen"] != "setup":
                            raise ValueError("人数選択画面で操作してください。")

                        count = get_integer(
                            payload.get("count"),
                            1,
                            MAX_STUDENTS,
                            "人数",
                        )

                        while len(room["students"]) < count:
                            room["students"].append(
                                new_student(len(room["students"]))
                            )

                        room["student_count"] = count
                        room["draft_count"] = count

                        for student in room["students"][:count]:
                            student["remaining"] = student["target"]
                            student["finish_time"] = None
                            student["completed_laps"] = None
                            student["revision"] += 1

                        room["screen"] = "counter"
                        room["running"] = False
                        room["started_at"] = None
                        room["elapsed"] = 0.0
                        room["run_id"] = secrets.token_hex(8)
                        room["version"] += 1

                    elif self.path == "/api/start":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        require_counter(room)

                        if room["running"]:
                            raise ValueError("すでに計測中です。")

                        room["started_at"] = time.monotonic()
                        room["elapsed"] = 0.0
                        room["running"] = True
                        room["version"] += 1

                    elif self.path == "/api/setup":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        room["elapsed"] = elapsed_of(room)
                        room["running"] = False
                        room["started_at"] = None
                        room["screen"] = "setup"
                        room["draft_count"] = room["student_count"]
                        room["run_id"] = secrets.token_hex(8)
                        room["version"] += 1

                    elif self.path == "/api/change":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        require_running(room)

                        student = get_student(
                            room,
                            payload.get("student_id"),
                        )

                        delta = payload.get("delta")

                        if type(delta) is not int or delta not in (-1, 1):
                            raise ValueError("操作が不正です。")

                        if delta == -1 and student["remaining"] <= 1:
                            raise ValueError("最後の−1はB専用です。")

                        if (
                            delta == 1
                            and student["remaining"] >= student["target"]
                        ):
                            raise ValueError(
                                "残り周数を目標周数より増やせません。"
                            )

                        student["remaining"] += delta
                        student["finish_time"] = None
                        student["completed_laps"] = None
                        student["revision"] += 1
                        room["version"] += 1

                    elif self.path == "/api/edit":
                        if role != "A":
                            raise PermissionError("A専用の操作です。")

                        require_counter(room)

                        student = get_student(
                            room,
                            payload.get("student_id"),
                        )

                        name = payload.get("name")

                        if not isinstance(name, str):
                            raise ValueError("名前を入力してください。")

                        name = name.strip()

                        if not 1 <= len(name) <= 100:
                            raise ValueError(
                                "名前は1〜100文字で入力してください。"
                            )

                        target = get_integer(
                            payload.get("target"),
                            1,
                            9999,
                            "目標周数",
                        )

                        reset = payload.get("reset") is True
                        target_changed = target != student["target"]

                        student["name"] = name
                        student["target"] = target

                        if reset or target_changed:
                            student["remaining"] = target
                            student["finish_time"] = None
                            student["completed_laps"] = None

                        student["revision"] += 1
                        room["version"] += 1

                    elif self.path == "/api/finish":
                        if role != "B":
                            raise PermissionError("最後の−1はB専用です。")

                        request_id = payload.get("request_id")

                        if (
                            not isinstance(request_id, str)
                            or not 1 <= len(request_id) <= 100
                        ):
                            raise ValueError("操作番号が不正です。")

                        # 同じ操作番号で再送された場合、二重記録しない。
                        if request_id not in room["finish_requests"]:
                            require_running(room)

                            if payload.get("run_id") != room["run_id"]:
                                raise ValueError(
                                    "走行が切り替わりました。"
                                    "最新画面を確認してください。"
                                )

                            student = get_student(
                                room,
                                payload.get("student_id"),
                            )

                            revision = payload.get("revision")

                            if (
                                type(revision) is not int
                                or revision != student["revision"]
                                or student["remaining"] != 1
                                or student["finish_time"] is not None
                            ):
                                raise ValueError(
                                    "記録が更新されています。"
                                    "最新の画面を確認してください。"
                                )

                            if received_at < room["started_at"]:
                                raise ValueError(
                                    "スタート前の操作は記録できません。"
                                )

                            student["remaining"] = 0
                            student["finish_time"] = (
                                received_at - room["started_at"]
                            )
                            student["completed_laps"] = student["target"]
                            student["revision"] += 1
                            room["version"] += 1

                            room["finish_requests"][request_id] = True

                            # 記憶する操作番号の数を制限。
                            if len(room["finish_requests"]) > 2000:
                                oldest = next(iter(room["finish_requests"]))
                                del room["finish_requests"][oldest]

                    else:
                        raise ValueError("不明な操作です。")

                    response = {
                        "ok": True,
                        "state": room_snapshot(room),
                    }

            self.send_json(200, response)

        except PermissionError as error:
            self.send_json(403, {
                "ok": False,
                "error": str(error),
            })

        except ValueError as error:
            self.send_json(400, {
                "ok": False,
                "error": str(error),
            })

        except Exception as error:
            print("サーバーエラー:", repr(error))

            self.send_json(500, {
                "ok": False,
                "error": "サーバーでエラーが発生しました。",
            })


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    server = Server((HOST, PORT), Handler)

    print()
    print("持久走・周回カウンター Web版")
    print(f"このPCで開く: http://localhost:{PORT}")
    print(f"ほかの端末で開く: http://{local_ip_address()}:{PORT}")
    print()
    print("終了するには Ctrl+C を押してください。")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを終了します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

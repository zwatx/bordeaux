"""Bordeaux on the SystemCore: serves the editor and stores its files on the robot.

Python standard library only, like the other SystemCore web apps. The browser plans paths, builds BDX bytes and
lays out project files (src/core); this server only stores bytes, confined to fixed folders:

  BORDEAUX_HOME/projects/<name>/   project folders, written by Save and autosave
  BORDEAUX_HOME/paths/             what robot code reads, written only by an explicit Push

Saving never writes where robot code reads. Push copies reviewed bytes, then reads them back and checks SHA-256.

Run: python3 server.py [--port 2468] [--home /home/systemcore/bordeaux] [--static ./static]
"""

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

WORKSPACE = ".bordeaux-workspace.json"
# Folder-relative files a commit may write or remove. Mirrors MANAGED_*_FILE in src/core/project/folderLayout.ts.
MANAGED_FILE = re.compile(r"^(Paths/[^/\\\x00]+\.(path|bdx)|Routines/[^/\\\x00]+\.routine)$", re.IGNORECASE)
PROJECT_NAME = re.compile(r"^[^/\\\x00-\x1f<>:\"|?*.][^/\\\x00-\x1f<>:\"|?*]{0,119}$")
PUSH_FILE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}\.(bdx|bdr)$")
MAX_BODY_BYTES = 160 * 1024 * 1024
# One writer at a time; the robot serves a handful of browsers.
LOCK = threading.Lock()


class Store:
    """Every path this server touches is derived here and checked to stay inside `home`."""

    def __init__(self, home):
        self.home = os.path.realpath(home)
        self.projects = os.path.join(self.home, "projects")
        os.makedirs(self.projects, exist_ok=True)
        os.makedirs(self.default_push_directory(), exist_ok=True)

    def default_push_directory(self):
        return os.path.join(self.home, "paths")

    def project_dir(self, name):
        if not isinstance(name, str) or not PROJECT_NAME.match(name) or name.strip() != name:
            raise ValueError("Project name is not a plain folder name")
        return os.path.join(self.projects, name)

    def push_directory(self, directory):
        """A push destination: the default, or another plain folder inside home."""
        if directory is None:
            return self.default_push_directory()
        if not isinstance(directory, str) or not os.path.isabs(directory):
            raise ValueError("Push folder must be an absolute path")
        normal = os.path.normpath(directory)
        if normal != directory.rstrip("/") or not (normal + "/").startswith(self.home + "/") or os.path.islink(normal):
            raise ValueError(f"Push folder must be inside {self.home}")
        return normal

    def settings_file(self):
        return os.path.join(self.home, "settings.json")

    def read_settings(self):
        try:
            with open(self.settings_file(), encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def write_settings(self, changes):
        settings = {**self.read_settings(), **changes}
        replace_file(self.settings_file(), json.dumps(settings, indent=2).encode())
        return settings


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, limit=MAX_BODY_BYTES):
    """Bytes of a regular, non-symlinked file, or None when it does not exist."""
    try:
        if os.path.islink(path):
            raise ValueError(f"{os.path.basename(path)} is a link; it was left alone")
        if not os.path.isfile(path):
            return None
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"{os.path.basename(path)} is too large")
        return data
    except FileNotFoundError:
        return None


def replace_file(path, data, mode=0o644):
    """Write next to the target, then rename over it, so readers see old or new bytes and never a partial file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".{os.path.basename(path)[:100]}.{secrets.token_hex(8)}.tmp")
    try:
        with open(temporary, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Conflict(Exception):
    pass


def commit_project(store, body):
    """Writes a project folder laid out by the browser. Workspace last, so a failure leaves the previous save readable."""
    folder = store.project_dir(body.get("name"))
    create = body.get("create") is True
    if create:
        if os.path.lexists(folder):
            raise Conflict("A project with this name already exists on the robot")
        os.makedirs(folder)
    try:
        return write_project(store, folder, body, create)
    except Exception:
        # A first save that failed leaves no half-made project behind to block the name. Only the folder this
        # request just made is removed.
        if create:
            shutil.rmtree(folder, ignore_errors=True)
        raise


def write_project(store, folder, body, create):
    workspace_path = os.path.join(folder, WORKSPACE)
    if not create:
        if not os.path.isdir(folder) or os.path.islink(folder):
            raise Conflict("The project folder is missing on the robot")
        current = read_regular(workspace_path)
        if (sha256(current) if current is not None else None) != body.get("expectedWorkspaceSha256"):
            raise Conflict("The project changed on the robot, maybe from another browser. Reload to see the current version.")
    preserved = []
    for write in body.get("writes", []):
        file = write.get("file")
        if not isinstance(file, str) or not MANAGED_FILE.match(file):
            raise ValueError(f"Refusing to write {file!r}")
        replace_file(os.path.join(folder, file), base64.b64decode(write.get("base64", ""), validate=True))
    for remove in body.get("removes", []):
        file = remove.get("file")
        if not isinstance(file, str) or not MANAGED_FILE.match(file):
            raise ValueError(f"Refusing to remove {file!r}")
        target = os.path.join(folder, file)
        data = read_regular(target)
        # Only bytes Bordeaux recorded may be deleted; anything edited by hand stays.
        if data is not None and sha256(data) == remove.get("sha256"):
            os.unlink(target)
        elif data is not None:
            preserved.append(file)
    workspace = body.get("workspace")
    if not isinstance(workspace, str):
        raise ValueError("Missing workspace contents")
    data = workspace.encode("utf-8")
    replace_file(workspace_path, data)
    store.write_settings({"lastProject": os.path.basename(folder)})
    return {"workspaceSha256": sha256(data), "preserved": preserved}


def push_files(store, body):
    """Copies reviewed files into the robot code's folder, then proves each one by reading it back."""
    directory = store.push_directory(body.get("directory"))
    created = not os.path.isdir(directory)
    os.makedirs(directory, exist_ok=True)
    results = []
    for file in body.get("files", []):
        name = file.get("fileName")
        if not isinstance(name, str) or not PUSH_FILE.match(name):
            raise ValueError("Robot filename must be a safe .bdx or .bdr basename")
        data = base64.b64decode(file.get("base64", ""), validate=True)
        if sha256(data) != file.get("sha256"):
            raise ValueError(f"{name} arrived damaged; nothing was replaced")
        target = os.path.join(directory, name)
        if os.path.islink(target):
            raise ValueError(f"{name} on the robot is a link; it was left alone")
        replace_file(target, data)
        if sha256(read_regular(target) or b"") != file["sha256"]:
            raise ValueError(f"{name} did not read back as written")
        results.append(name)
    return {"directory": directory, "directoryCreated": created, "files": results}


def list_projects(store):
    projects = []
    for entry in sorted(os.listdir(store.projects), key=str.lower):
        folder = os.path.join(store.projects, entry)
        workspace = os.path.join(folder, WORKSPACE)
        if PROJECT_NAME.match(entry) and os.path.isdir(folder) and not os.path.islink(folder) and os.path.isfile(workspace):
            projects.append({"name": entry, "updatedAt": os.path.getmtime(workspace)})
    return projects


class Handler(SimpleHTTPRequestHandler):
    store = None
    static_root = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.static_root, **kwargs)

    def log_message(self, format, *args):
        sys.stderr.write("bordeaux: " + format % args + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") or self.path in ("/", "/index.html") else "max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, value, status=HTTPStatus.OK):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError("Request is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def api(self, method):
        route = unquote(urlparse(self.path).path)
        store = self.store
        if method == "GET" and route == "/api/info":
            settings = store.read_settings()
            return {"home": store.home, "projectsRoot": store.projects, "pushDirectory": settings.get("pushDirectory") or store.default_push_directory(),
                    "defaultPushDirectory": store.default_push_directory(), "lastProject": settings.get("lastProject")}
        if method == "GET" and route == "/api/projects":
            return list_projects(store)
        match = re.match(r"^/api/projects/([^/]+)/workspace$", route)
        if method == "GET" and match:
            data = read_regular(os.path.join(store.project_dir(match.group(1)), WORKSPACE))
            if data is None:
                return HTTPStatus.NOT_FOUND, {"error": "No project with this name on the robot"}
            return {"contents": data.decode("utf-8"), "sha256": sha256(data)}
        if method == "POST" and route == "/api/commit":
            with LOCK:
                return commit_project(store, self.read_json())
        if method == "POST" and route == "/api/push":
            with LOCK:
                return push_files(store, self.read_json())
        if method == "POST" and route == "/api/settings":
            body = self.read_json()
            changes = {}
            if "pushDirectory" in body:
                changes["pushDirectory"] = store.push_directory(body["pushDirectory"])
            if "lastProject" in body:
                store.project_dir(body["lastProject"])
                changes["lastProject"] = body["lastProject"]
            with LOCK:
                return store.write_settings(changes)
        return HTTPStatus.NOT_FOUND, {"error": "Unknown request"}

    def handle_api(self, method):
        try:
            result = self.api(method)
            status, value = result if isinstance(result, tuple) else (HTTPStatus.OK, result)
            self.send_json(value, status)
        except Conflict as error:
            self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except OSError as error:
            self.send_json({"error": f"The robot could not write the file: {error.strerror or error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.handle_api("POST")
        self.send_json({"error": "Unknown request"}, HTTPStatus.NOT_FOUND)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("BORDEAUX_PORT", "2468")))
    parser.add_argument("--host", default=os.environ.get("BORDEAUX_BIND", "0.0.0.0"))
    parser.add_argument("--home", default=os.environ.get("BORDEAUX_HOME", "/home/systemcore/bordeaux"))
    parser.add_argument("--static", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))
    args = parser.parse_args()
    Handler.store = Store(args.home)
    Handler.static_root = os.path.realpath(args.static)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"bordeaux: serving {Handler.static_root} on {args.host}:{args.port}, files in {Handler.store.home}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()

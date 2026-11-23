"""Bordeaux on the SystemCore: serves the editor and stores its files on the robot.

Python standard library only, like the other SystemCore web apps. The browser plans paths, builds BDX bytes and
lays out project files (src/core); this server only stores bytes, confined to fixed folders:

  BORDEAUX_HOME/projects/<name>/   project folders, written by Save and autosave
  BORDEAUX_HOME/paths/             what robot code reads, written only by an explicit Push

Saving never writes where robot code reads. Push copies reviewed bytes, then reads them back and checks SHA-256.

Only pages this server served may call it: every API request must name this robot as its Host (an IP address, this
machine's name, or BORDEAUX_ALLOWED_HOSTS), and every write must come from that same origin. Another website open in
a browser on the robot network therefore cannot read or change projects, even through DNS rebinding. Devices on the
robot network are trusted, as they are for the robot's SSH login.

Run: python3 server.py [--port 2468] [--home /home/systemcore/bordeaux] [--static ./static]
"""

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

WORKSPACE = ".bordeaux-workspace.json"
# Folder-relative files a commit may write or remove. Mirrors MANAGED_*_FILE in src/core/project/folderLayout.ts.
MANAGED_FILE = re.compile(r"^(Paths/[^/\\\x00]+\.(path|bdx)|Routines/[^/\\\x00]+\.routine)$", re.IGNORECASE)
PROJECT_NAME = re.compile(r"^[^/\\\x00-\x1f\x7f<>:\"|?*.][^/\\\x00-\x1f\x7f<>:\"|?*]{0,119}$")
# The desktop's rules too (src/core/project/projectName.ts): at most 255 UTF-8 bytes, no trailing dot or space, and
# no Windows device name, so a robot project can be copied to any team laptop.
MAX_NAME_BYTES = 255
WINDOWS_DEVICE_NAME = re.compile(r"^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\.|$)", re.IGNORECASE | re.ASCII)
PUSH_FILE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}\.(bdx|bdr)$")
MAX_BODY_BYTES = 160 * 1024 * 1024
# Push limits match the desktop's SFTP transfer (src/electron/robotFileTransfer.ts).
MAX_PUSH_FILES = 64
MAX_PUSH_BYTES = 24 * 1024 * 1024
# A reviewed push waits in memory until confirmed or canceled; old reviews expire.
PUSH_REVIEW_SECONDS = 15 * 60
MAX_PUSH_REVIEWS = 4
# One writer at a time; the robot serves a handful of browsers.
LOCK = threading.Lock()


def is_project_name(name):
    return (isinstance(name, str) and PROJECT_NAME.match(name) is not None and name.strip() == name and not name.endswith(".")
            and len(name.encode("utf-8", "surrogatepass")) <= MAX_NAME_BYTES and not WINDOWS_DEVICE_NAME.match(name)
            and not any(0xD800 <= ord(character) <= 0xDFFF for character in name))


class Store:
    """Every path this server touches is derived here and checked to stay inside `home`.

    The checks are physical, not only lexical: no folder or file between `home` and a path the server reads or writes
    may be a link, so a link can't route Save into the robot code's folder or a push outside `home`.
    """

    def __init__(self, home):
        self.home = os.path.realpath(home)
        self.projects = os.path.join(self.home, "projects")
        os.makedirs(self.projects, exist_ok=True)
        os.makedirs(self.default_push_directory(), exist_ok=True)

    def default_push_directory(self):
        return os.path.join(self.home, "paths")

    def contained(self, path):
        """`path` itself, once it is inside home with no link at any level below home."""
        normal = os.path.normpath(path)
        if normal != self.home and not normal.startswith(self.home + "/"):
            raise ValueError(f"{path} is outside {self.home}")
        current = self.home
        for part in os.path.relpath(normal, self.home).split("/"):
            if part == ".":
                continue
            current = os.path.join(current, part)
            if os.path.islink(current):
                raise ValueError(f"{current} is a link; Bordeaux doesn't read or write through links")
            if not os.path.lexists(current):
                break
        return normal

    def project_dir(self, name, reading=False):
        """A project folder to write, or with `reading`, one to open: a robot project saved before the desktop's name
        rules applied (such as "Aux") still opens, and Save copy moves it to a name every computer accepts."""
        if reading and isinstance(name, str) and PROJECT_NAME.match(name) and name.strip() == name:
            return self.contained(os.path.join(self.projects, name))
        if not is_project_name(name):
            if isinstance(name, str) and PROJECT_NAME.match(name):
                raise ValueError(f"{name} isn't a project name every computer accepts. Use Save copy to keep it under a new name.")
            raise ValueError("Project name is not a plain folder name")
        return self.contained(os.path.join(self.projects, name))

    def push_directory(self, directory):
        """A push destination: the default, or another plain folder inside home."""
        if directory is None:
            return self.default_push_directory()
        if not isinstance(directory, str) or not os.path.isabs(directory):
            raise ValueError("Push folder must be an absolute path")
        normal = os.path.normpath(directory)
        if normal != directory.rstrip("/") or not (normal + "/").startswith(self.home + "/"):
            raise ValueError(f"Push folder must be inside {self.home}")
        self.contained(normal)
        # Save writes and removes files under projects; robot code's folder must stay reachable only through Push.
        if (normal + "/").startswith(self.projects + "/"):
            raise ValueError("Push folder must be outside the projects folder")
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


def write_temporary(path, data, mode=0o644):
    """A hidden, synced copy of `data` next to `path`, ready to rename over it."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".{os.path.basename(path)[:100]}.{secrets.token_hex(8)}.tmp")
    try:
        with open(temporary, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
    except BaseException:
        remove_quietly(temporary)
        raise
    return temporary


def remove_quietly(path):
    """Cleanup that never hides the error being reported."""
    try:
        os.unlink(path)
    except OSError:
        pass


def replace_file(path, data, mode=0o644):
    """Write next to the target, then rename over it, so readers see old or new bytes and never a partial file."""
    temporary = write_temporary(path, data, mode)
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Conflict(Exception):
    pass


class Forbidden(Exception):
    pass


class PushFailed(Exception):
    """A push that stopped partway; the message names every file already replaced."""


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
    requested, removes = body.get("writes", []), body.get("removes", [])
    if not isinstance(requested, list) or not isinstance(removes, list) or not all(isinstance(item, dict) for item in requested + removes):
        raise ValueError("Writes and removes must be lists of files")
    writes = []
    for write in requested:
        file = write.get("file")
        if not isinstance(file, str) or not MANAGED_FILE.match(file):
            raise ValueError(f"Refusing to write {file!r}")
        writes.append((write, store.contained(os.path.join(folder, file)), base64.b64decode(write.get("base64", ""), validate=True)))
    for remove in removes:
        file = remove.get("file")
        if not isinstance(file, str) or not MANAGED_FILE.match(file):
            raise ValueError(f"Refusing to remove {file!r}")
        store.contained(os.path.join(folder, file))
    workspace = body.get("workspace")
    if not isinstance(workspace, str):
        raise ValueError("Missing workspace contents")
    workspace_data = workspace.encode("utf-8")
    # Each file carries the hash Bordeaux last wrote there (None when it wrote none). Any other bytes on disk, such as an
    # edit made over SSH, are kept. A source file stops the whole save; a generated BDX is only left out, so the sources
    # still save and the page reports the BDX, as the desktop does.
    kept = []
    for write, target, data in list(writes):
        if "expectedSha256" not in write:
            raise ValueError(f"{write['file']} has no expected hash; reload the page")
        current = read_regular(target)
        found = sha256(current) if current is not None else None
        # A missing file is written, as on the desktop: replacing nothing loses nothing.
        if found in (None, write["expectedSha256"], sha256(data)):
            continue
        if write["file"].lower().endswith(".bdx"):
            kept.append(write["file"])
            writes.remove((write, target, data))
            continue
        # This page can't show the robot's version, so reloading would not help; a copy keeps both.
        origin = "changed on the robot since Bordeaux saved it" if write["expectedSha256"] else "is on the robot but Bordeaux didn't write it"
        raise Conflict(f"{write['file']} {origin}, and Bordeaux left it as it is. Use Save copy to keep this version in a new project.")
    # Every file, the workspace included, is written beside its target before any target changes, so a full disk fails
    # the save with nothing replaced. The workspace is renamed last, after the files it records.
    staged, workspace_temporary, preserved = [], None, []
    try:
        for _write, target, data in writes:
            staged.append((write_temporary(target, data), target))
        workspace_temporary = write_temporary(workspace_path, workspace_data)
        for temporary, target in staged:
            os.replace(temporary, target)
        for remove in removes:
            file = remove["file"]
            target = os.path.join(folder, file)
            data = read_regular(target)
            # Only bytes Bordeaux recorded may be deleted; anything edited by hand stays.
            if data is not None and sha256(data) == remove.get("sha256"):
                os.unlink(target)
            elif data is not None:
                preserved.append(file)
        os.replace(workspace_temporary, workspace_path)
    finally:
        for temporary in [item[0] for item in staged] + [workspace_temporary]:
            if temporary:
                remove_quietly(temporary)
    # The project is saved; remembering it as the last project is a convenience whose failure must not hide that.
    try:
        store.write_settings({"lastProject": os.path.basename(folder)})
    except OSError:
        pass
    return {"workspaceSha256": sha256(workspace_data), "preserved": preserved, "keptBinaries": kept}


class PushReviews:
    """Bytes the person reviewed, held until they confirm. Confirm publishes exactly these bytes and nothing else."""

    def __init__(self):
        self.reviews = {}

    def add(self, review):
        now = time.monotonic()
        for key in [key for key, value in self.reviews.items() if now - value["at"] > PUSH_REVIEW_SECONDS]:
            del self.reviews[key]
        while len(self.reviews) >= MAX_PUSH_REVIEWS:
            del self.reviews[min(self.reviews, key=lambda key: self.reviews[key]["at"])]
        operation = secrets.token_hex(16)
        self.reviews[operation] = {**review, "at": now}
        return operation

    def take(self, operation):
        review = self.reviews.pop(operation, None) if isinstance(operation, str) else None
        if review is None or time.monotonic() - review["at"] > PUSH_REVIEW_SECONDS:
            raise Conflict("Review the selected files again before pushing")
        return review


def prepare_push(store, reviews, body):
    """Checks a whole batch and holds it for review. Nothing on the robot changes yet."""
    directory = store.push_directory(body.get("directory"))
    files = body.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_PUSH_FILES:
        raise ValueError(f"Select between 1 and {MAX_PUSH_FILES} robot files")
    names, held, total = set(), [], 0
    for file in files:
        name = file.get("fileName") if isinstance(file, dict) else None
        if not isinstance(name, str) or not PUSH_FILE.match(name):
            raise ValueError("Robot filename must be a safe .bdx or .bdr basename")
        if name.lower() in names:
            raise ValueError(f"Two files are named {name}; rename one before pushing")
        names.add(name.lower())
        data = base64.b64decode(file.get("base64", ""), validate=True)
        total += len(data)
        if not data or total > MAX_PUSH_BYTES:
            raise ValueError("Robot files must not be empty and must total at most 24 MiB")
        if sha256(data) != file.get("sha256"):
            raise ValueError(f"{name} arrived damaged; nothing was replaced")
        held.append({"fileName": name, "data": data, "sha256": sha256(data)})
    operation = reviews.add({"directory": directory, "files": held})
    return {"operationId": operation, "directory": directory,
            "files": [{"fileName": item["fileName"], "size": len(item["data"]), "sha256": item["sha256"]} for item in held]}


def confirm_push(store, reviews, body):
    """Publishes a reviewed batch into the robot code's folder.

    Every file is first written and read back beside its destination, so a bad destination or a full disk stops the
    push before any robot file changes. Only then is each copy renamed into place and read back again.
    """
    review = reviews.take(body.get("operationId"))
    directory = store.push_directory(review["directory"])
    files = review["files"]
    created = not os.path.isdir(directory)
    staged = []
    try:
        os.makedirs(directory, exist_ok=True)
        for item in files:
            name, target = item["fileName"], store.contained(os.path.join(directory, item["fileName"]))
            if os.path.islink(target) or (os.path.lexists(target) and not os.path.isfile(target)):
                raise ValueError(f"{name} on the robot is not a regular file")
            temporary = write_temporary(target, item["data"])
            staged.append((item, temporary, target))
            if sha256(read_regular(temporary) or b"") != item["sha256"]:
                raise ValueError(f"{name} did not read back as written")
    except (OSError, ValueError) as error:
        for _item, temporary, _target in staged:
            remove_quietly(temporary)
        reason = error.strerror if isinstance(error, OSError) and error.strerror else str(error)
        raise PushFailed(f"Could not push: {reason}. No robot files were replaced.") from error
    replaced, publishing = [], None
    try:
        for item, temporary, target in staged:
            publishing = item["fileName"]
            os.replace(temporary, target)
            if sha256(read_regular(target) or b"") != item["sha256"]:
                raise ValueError(f"{publishing} did not read back as written")
            replaced.append(publishing)
            publishing = None
    except (OSError, ValueError) as error:
        for _item, temporary, _target in staged:
            remove_quietly(temporary)
        reason = error.strerror if isinstance(error, OSError) and error.strerror else str(error)
        listed = f" ({', '.join(replaced)})" if replaced else ""
        unsure = f" {publishing} may have been replaced; its final bytes were not verified." if publishing else ""
        raise PushFailed(f"Could not push: {reason}. {len(replaced)} of {len(files)} files replaced and verified{listed}.{unsure}") from error
    return {"directory": directory, "directoryCreated": created, "files": replaced}


def host_names():
    """Names this robot answers to, besides IP addresses."""
    name = socket.gethostname().lower()
    extra = {item.strip().lower() for item in os.environ.get("BORDEAUX_ALLOWED_HOSTS", "").split(",") if item.strip()}
    return {"localhost", name, f"{name}.local", name.split(".")[0], f"{name.split('.')[0]}.local"} | extra


def host_name(host):
    """The name in a Host header without its port, or None when it is malformed."""
    if not isinstance(host, str) or not host:
        return None
    if host.startswith("["):
        end = host.find("]")
        return host[1:end].lower() if end > 0 else None
    return host.rsplit(":", 1)[0].lower() if host.count(":") == 1 else host.lower()


def is_ip_address(name):
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def list_projects(store):
    projects = []
    for entry in sorted(os.listdir(store.projects), key=str.lower):
        folder = os.path.join(store.projects, entry)
        workspace = os.path.join(folder, WORKSPACE)
        if PROJECT_NAME.match(entry) and os.path.isdir(folder) and not os.path.islink(folder) and os.path.isfile(workspace):
            projects.append({"name": entry, "updatedAt": os.path.getmtime(workspace)})
    return projects


class Handler(SimpleHTTPRequestHandler):
    # Seconds a connection may sit idle mid-request before it is dropped, so a stalled client can't hold a thread forever.
    timeout = 30
    store = None
    static_root = None
    reviews = PushReviews()
    allowed_names = frozenset()

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
        """The request's JSON object, read in full and bounded. Routes read it before taking LOCK."""
        lengths = self.headers.get_all("Content-Length") or []
        if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0].strip()):
            raise ValueError("Send the request with one Content-Length")
        length = int(lengths[0])
        if length > MAX_BODY_BYTES:
            raise ValueError("Request is too large")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("The request ended before its body did")
        value = json.loads(data or b"{}")
        if not isinstance(value, dict):
            raise ValueError("The request body must be a JSON object")
        return value

    def authorize(self, method):
        """Same-origin only: a page from another site, or a name rebound to this robot, is refused."""
        host = self.headers.get("Host")
        name = host_name(host)
        if name is None or not (is_ip_address(name) or name in self.allowed_names):
            raise Forbidden(f"Open Bordeaux at this robot's address, not {host or 'an unnamed host'}")
        if method != "GET":
            origin = self.headers.get("Origin")
            if origin not in (f"http://{host}", f"https://{host}"):
                raise Forbidden("Bordeaux accepts changes only from its own page on this robot")
            if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
                raise Forbidden("Bordeaux accepts changes only as JSON")

    def api(self, method):
        self.authorize(method)
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
            data = read_regular(os.path.join(store.project_dir(match.group(1), reading=True), WORKSPACE))
            if data is None:
                return HTTPStatus.NOT_FOUND, {"error": "No project with this name on the robot"}
            return {"contents": data.decode("utf-8"), "sha256": sha256(data)}
        if method == "POST" and route == "/api/commit":
            # Read before locking: a slow or stalled upload must never hold up other browsers' saves and pushes.
            body = self.read_json()
            with LOCK:
                return commit_project(store, body)
        if method == "POST" and route == "/api/push/prepare":
            body = self.read_json()
            with LOCK:
                return prepare_push(store, self.reviews, body)
        if method == "POST" and route == "/api/push/confirm":
            body = self.read_json()
            with LOCK:
                return confirm_push(store, self.reviews, body)
        if method == "POST" and route == "/api/push/cancel":
            body = self.read_json()
            with LOCK:
                try:
                    self.reviews.take(body.get("operationId"))
                    return {"canceled": True}
                except Conflict:
                    return {"canceled": False}
        if method == "POST" and route == "/api/settings":
            body = self.read_json()
            changes = {}
            if "pushDirectory" in body:
                changes["pushDirectory"] = store.push_directory(body["pushDirectory"])
            if "lastProject" in body:
                store.project_dir(body["lastProject"], reading=True)
                changes["lastProject"] = body["lastProject"]
            with LOCK:
                return store.write_settings(changes)
        return HTTPStatus.NOT_FOUND, {"error": "Unknown request"}

    def handle_api(self, method):
        try:
            result = self.api(method)
            status, value = result if isinstance(result, tuple) else (HTTPStatus.OK, result)
            self.send_json(value, status)
        except Forbidden as error:
            self.send_json({"error": str(error)}, HTTPStatus.FORBIDDEN)
        except Conflict as error:
            self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
        except PushFailed as error:
            self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except (TypeError, AttributeError):
            self.send_json({"error": "The request is not in the form Bordeaux sends"}, HTTPStatus.BAD_REQUEST)
        except TimeoutError:
            # The client stopped sending; there is no one left to answer.
            self.close_connection = True
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
    Handler.allowed_names = frozenset(host_names())
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"bordeaux: serving {Handler.static_root} on {args.host}:{args.port}, files in {Handler.store.home}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()

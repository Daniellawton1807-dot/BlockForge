#!/usr/bin/env python3
"""Loopback-only, allowlisted launcher for the Homebase Jarvis web UI (macOS)."""
from __future__ import annotations

import hmac
import json
import os
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ORIGIN = "https://dashboard.danielvault.uk"
HOST = "127.0.0.1"
PORT = 17877
PAIR_SECONDS = 300
MAX_BODY = 4096
CONFIG_FILE = Path.home() / "Library/Application Support/Homebase Jarvis/config.json"
DEFAULT_CONFIG = {
    "apps": {"safari": "Safari", "chrome": "Google Chrome", "notes": "Notes", "calendar": "Calendar", "music": "Music", "finder": "Finder"},
    "websites": {"homebase": "https://dashboard.danielvault.uk/", "github": "https://github.com/"},
    "allowed_hosts": ["dashboard.danielvault.uk", "github.com"],
}


def read_config():
    try:
        value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("config must be an object")
        return {**DEFAULT_CONFIG, **value}
    except FileNotFoundError:
        return DEFAULT_CONFIG
    except (OSError, ValueError):
        return DEFAULT_CONFIG


class Pairing:
    def __init__(self):
        self.code = secrets.token_hex(6).upper()
        self.expires = time.monotonic() + PAIR_SECONDS
        self.attempts = 0
        self.token = None
        self.lock = threading.Lock()

    def pair(self, code):
        with self.lock:
            self.attempts += 1
            if self.token or self.attempts > 5 or time.monotonic() > self.expires or not hmac.compare_digest(str(code).upper(), self.code):
                return None
            self.token = secrets.token_urlsafe(32)
            self.code = ""
            return self.token

    def authorized(self, authorization):
        with self.lock:
            return bool(self.token and hmac.compare_digest(authorization, "Bearer " + self.token))

    def disconnect(self, authorization):
        with self.lock:
            if not self.token or not hmac.compare_digest(authorization, "Bearer " + self.token):
                return False
            self.token = None
            return True


pairing = Pairing()


def website_url(name, config):
    sites = config.get("websites", {})
    if not isinstance(sites, dict):
        return None
    value = sites.get(str(name).strip().lower())
    if not isinstance(value, str) or len(value) > 1500:
        return None
    parsed = urlparse(value)
    allowed = config.get("allowed_hosts", [])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.hostname.lower() not in {str(x).lower() for x in allowed}:
        return None
    return value


def launch_action(body, config):
    """Execute only exact app aliases and HTTPS website aliases from the local allowlist."""
    kind, name = body.get("kind"), str(body.get("name", "")).strip().lower()
    if kind == "app" and isinstance(config.get("apps"), dict) and name in config["apps"]:
        app_name = str(config["apps"][name])
        if not app_name or len(app_name) > 120:
            return 400, {"error": "That app is not allowlisted."}
        command = ["/usr/bin/open", "-a", app_name]
    elif kind == "website":
        url = website_url(name, config)
        if not url:
            return 400, {"error": "That website is not allowlisted."}
        command = ["/usr/bin/open", url]
    else:
        return 400, {"error": "That action is not allowlisted."}
    try:
        subprocess.run(command, check=True, timeout=8, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return 500, {"error": "macOS could not open that app or website."}
    return 200, {"ok": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisCompanion/1"
    sys_version = ""

    def log_message(self, fmt, *args):
        # Avoid writing URLs, pairing codes, tokens, or user content to logs.
        print("Jarvis companion: " + (fmt % args).split(" ", 1)[0], flush=True)

    def _origin_allowed(self):
        return (self.headers.get("Origin") == ORIGIN and
                self.headers.get("Host") in (f"{HOST}:{PORT}", f"localhost:{PORT}", f"127.0.0.1:{PORT}"))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Vary", "Origin")

    def _json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode()
        if not self._origin_allowed():
            return self.send_error(403, "Origin or Host rejected")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self.send_error(403, "Origin or Host rejected")
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "300")
        self.end_headers()

    def do_GET(self):
        if not self._origin_allowed():
            return self.send_error(403, "Origin or Host rejected")
        if self.path != "/catalog":
            return self.send_error(404)
        if not pairing.authorized(self.headers.get("Authorization", "")):
            return self._json(401, {"error": "Pair Jarvis Companion again."})
        config = read_config()
        self._json(200, {"apps": sorted(config.get("apps", {}).keys()), "websites": sorted(config.get("websites", {}).keys())})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "Invalid request size."})
        if not 1 <= length <= MAX_BODY:
            return self._json(413, {"error": "Invalid request size."})
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "Invalid request."})
        if not isinstance(body, dict):
            return self._json(400, {"error": "Invalid request."})

        if self.path == "/pair":
            token = pairing.pair(body.get("code", ""))
            if not token:
                return self._json(401, {"error": "Pairing code expired or incorrect. Restart the companion to get a new code."})
            config = read_config()
            return self._json(200, {"token": token, "apps": sorted(config.get("apps", {}).keys()), "websites": sorted(config.get("websites", {}).keys())})

        if self.path == "/disconnect":
            if not pairing.disconnect(self.headers.get("Authorization", "")):
                return self._json(401, {"error": "This companion session is no longer authorized."})
            return self._json(200, {"ok": True})

        if self.path != "/open" or not pairing.authorized(self.headers.get("Authorization", "")):
            return self._json(401, {"error": "Pair Jarvis Companion before using laptop actions."})
        status, result = launch_action(body, read_config())
        self._json(status, result)


def main():
    if os.uname().sysname != "Darwin":
        raise SystemExit("Jarvis Companion currently supports macOS only.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("Jarvis Companion is listening on this Mac only (127.0.0.1:17877).", flush=True)
    print("Enter this one-time pairing code in Jarvis Settings within five minutes: " + pairing.code, flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

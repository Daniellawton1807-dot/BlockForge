#!/usr/bin/env python3
"""Read-only Homebase physical-drive inventory agent. Python stdlib only."""
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("HOMEBASE_STORAGE_AGENT_PORT", "8765"))
TOKEN_FILE = Path("/etc/homebase-storage-agent/token")

def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=8, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "command failed")
    return result.stdout

def inventory():
    raw = json.loads(command(["lsblk", "--json", "--bytes", "-o",
        "NAME,PATH,MODEL,SIZE,TYPE,FSTYPE,MOUNTPOINTS,TRAN,RM,STATE"]))
    df = command(["df", "-B1", "-PT"])
    filesystems = {}
    lines = df.splitlines()[1:]
    for line in lines:
        fields = line.split()
        if len(fields) >= 7:
            filesystems[fields[6]] = {
                "filesystem": fields[1], "totalBytes": int(fields[2]),
                "usedBytes": int(fields[3]), "freeBytes": int(fields[4]),
                "percent": int(fields[5].rstrip("%"))
            }
    def map_device(node):
        kind = node.get("type", "")
        if kind == "loop":
            return None
        mounts = node.get("mountpoints") or []
        mounts = [m for m in mounts if m]
        item = {
            "name": node.get("name", ""),
            "path": node.get("path", ""),
            "model": (node.get("model") or "").strip(),
            "sizeBytes": int(node.get("size") or 0),
            "type": kind,
            "filesystem": node.get("fstype") or "",
            "mounts": mounts,
            "transport": node.get("tran") or "",
            "removable": bool(node.get("rm")),
            "state": node.get("state") or "unknown",
            "children": []
        }
        for mount in mounts:
            if mount in filesystems:
                item["filesystemStats"] = filesystems[mount]
                break
        for child in node.get("children") or []:
            mapped = map_device(child)
            if mapped:
                item["children"].append(mapped)
        return item
    devices = [d for d in (map_device(n) for n in raw.get("blockdevices", [])) if d]
    return {"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "devices": devices}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/api/drives":
            self.send_error(404)
            return
        try:
            token = TOKEN_FILE.read_text().strip()
        except Exception:
            self.send_error(503, "agent token not configured")
            return
        supplied = self.headers.get("Authorization", "")
        if not token or supplied != "Bearer " + token:
            self.send_error(401)
            return
        try:
            body = json.dumps(inventory()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)[:300]}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

if __name__ == "__main__":
    print("Homebase storage agent listening on %s:%s" % (HOST, PORT), flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()

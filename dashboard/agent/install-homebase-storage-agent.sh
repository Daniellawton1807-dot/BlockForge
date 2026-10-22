#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash install-homebase-storage-agent.sh"; exit 1; fi
BASE="/opt/homebase-storage-agent"
mkdir -p "$BASE" /etc/homebase-storage-agent
install -m 0644 homebase-storage-agent.py "$BASE/homebase-storage-agent.py"
if [ ! -s /etc/homebase-storage-agent/token ]; then
  umask 077
  python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > /etc/homebase-storage-agent/token
fi
chmod 0600 /etc/homebase-storage-agent/token
cat >/etc/systemd/system/homebase-storage-agent.service <<'UNIT'
[Unit]
Description=Homebase read-only storage inventory agent
After=local-fs.target
Wants=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/homebase-storage-agent/homebase-storage-agent.py
Restart=on-failure
RestartSec=5
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
ReadWritePaths=/run
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now homebase-storage-agent
echo
echo "Homebase storage agent installed."
echo "Local health check:"
systemctl --no-pager --full status homebase-storage-agent || true
echo
echo "Agent listens only on 127.0.0.1:8765. It is not exposed to your LAN."
echo "Next: route a Cloudflare Tunnel hostname to http://localhost:8765 and set Homebase environment secrets."
echo "Agent bearer token (copy to Cloudflare Pages secret HOMEBASE_STORAGE_AGENT_TOKEN):"
cat /etc/homebase-storage-agent/token

# Stitcher Controller — Deployment Guide

## Requirements

- Linux VM (Ubuntu/Debian recommended)
- Python 3.10+ with venv support
- Docker Engine installed and running
- Ports 8812, 1080, 1443 open on firewall

On Debian/Ubuntu, ensure these packages are installed:

```bash
sudo apt-get install -y python3 python3-venv
```

## Install

```bash
tar -xzf stitcher-controller-*.tar.gz
cd stitcher
python3 -m venv .venv
./run_controller.sh
```

## Run (foreground)

```bash
chmod +x run_controller.sh
./run_controller.sh
```

Controller UI: http://YOUR_VM_IP:8812

## Run As A System Service (recommended)

Create `/etc/systemd/system/stitcher-controller.service`:

```ini
[Unit]
Description=Stitcher Controller
After=network.target docker.service
Requires=docker.service

[Service]
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/stitcher
ExecStart=/home/YOUR_USER/stitcher/.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8812 --app-dir /home/YOUR_USER/stitcher
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stitcher-controller
sudo systemctl status stitcher-controller
```

## First Time: Initialize Stitcher

Once the controller is running, initialize Stitcher to fetch the default config:

```bash
curl -X POST http://localhost:8812/api/control/init
```

Or click **Init** in the web UI.

## Start / Stop Stitcher

```bash
# Start
curl -X POST http://localhost:8812/api/control/start

# Stop
curl -X POST http://localhost:8812/api/control/stop

# Status
curl http://localhost:8812/api/status
```

Or use the **Stitcher Control** tab in the web UI.

## Ports

| Port | Purpose                  |
|------|--------------------------|
| 8812 | Controller UI / API      |
| 1080 | Stitcher HTTP output     |
| 1443 | Stitcher HTTPS output    |

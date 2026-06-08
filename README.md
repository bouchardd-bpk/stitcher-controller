# Stitcher Controller

A user-friendly web app to control and configure Stitcher.

## Features

- Start / stop / restart Stitcher
- Reload Stitcher configuration
- Edit `default_settings`
- Add, edit, delete `service_config` entries
- Edit `upstream_origin` endpoints
- Automatic backup before each configuration save
- One-click backup restore

## Structure

- `backend/app/main.py`: FastAPI API + command execution
- `backend/app/config_manager.py`: parse/rewrite logic for `conf/stitcher.conf.cc`
- `frontend/`: Vue.js UI (horizontal navbar + panels)
- `conf/backups/`: configuration backups

## Run The Web App

```bash
chmod +x run_controller.sh
./run_controller.sh
```

Then open: `http://localhost:8812`

## Run With npm

```bash
npm install
npm run dev
```

This starts:

- Backend API on `http://localhost:8812`
- Frontend on `http://localhost:5173`

## Notes

- The backend executes `stitcher.sh` from the project root.
- Docker must be available on the VM for start/stop/reload/status commands.

## Deploy On A Remote VM

### Requirements

- Ubuntu/Debian VM (or any Linux with `bash`, `python3`, `pip3`)
- Docker Engine installed
- Project files copied to the VM

### Copy Files To The VM

```bash
# From your local machine
rsync -av --exclude='.venv' --exclude='node_modules' \
  /home/david/stitcher/ user@vm-ip:~/stitcher/
```

Or with scp:

```bash
scp -r /home/david/stitcher user@vm-ip:~/stitcher
```

### Install And Start On The VM

```bash
cd ~/stitcher

# Install Python dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Run the controller (port 8812)
chmod +x run_controller.sh
./run_controller.sh
```

Then open: `http://VM_IP:8812`

### Run As A Background Service (systemd)

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

### Initialize And Start Stitcher

Once the controller is running:

```bash
# Initialize (pulls default config from Stitcher container)
curl -X POST http://localhost:8812/api/control/init

# Start Stitcher
curl -X POST http://localhost:8812/api/control/start

# Check status
curl http://localhost:8812/api/status
```

Or just use the web UI at `http://VM_IP:8812`.

### Firewall Ports To Open

| Port | Purpose |
|------|---------|
| 8812 | Controller UI / API |
| 1080 | Stitcher HTTP output |
| 1443 | Stitcher HTTPS output |

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

### Recommended: Git-Based Deployment

Use Git on the VM so updates are incremental (`git pull`) instead of sending full archives.

### Requirements

- Ubuntu/Debian VM (or any Linux with `bash`, `python3`, `pip3`)
- Docker Engine installed and running
- Git installed
- Network access from VM to GitHub

### First Deployment On The VM

```bash
# 1) Clone the repository
git clone https://github.com/bouchardd-bpk/stitcher-controller.git
cd stitcher-controller

# 2) Create Python virtualenv and install backend dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# 3) Start the controller (port 8812)
chmod +x run_controller.sh
./run_controller.sh
```

Then open: `http://VM_IP:8812`

### Daily Update Workflow

After pushing new commits from your workstation:

```bash
cd ~/stitcher-controller
git pull
source .venv/bin/activate
./run_controller.sh
```

If running with `systemd`, restart the service instead of launching manually:

```bash
sudo systemctl restart stitcher-controller
sudo systemctl status stitcher-controller
```

### Alternative (No GitHub Access): rsync

If your VM cannot pull from GitHub, use incremental `rsync` from your local machine:

```bash
rsync -av --delete \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='conf/backups' \
  /path/to/stitcher-controller/ user@vm-ip:~/stitcher-controller/
```

Then on VM:

```bash
cd ~/stitcher-controller
source .venv/bin/activate
./run_controller.sh
```

### Run As A Background Service (systemd)

Create `/etc/systemd/system/stitcher-controller.service`:

```ini
[Unit]
Description=Stitcher Controller
After=network.target docker.service
Requires=docker.service

[Service]
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/stitcher-controller
ExecStart=/home/YOUR_USER/stitcher-controller/.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8812 --app-dir /home/YOUR_USER/stitcher-controller
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

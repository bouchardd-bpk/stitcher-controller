from __future__ import annotations

import re
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from .config_manager import (
    UpstreamConfig,
    VhostConfig,
    VhostEndpoint,
    apply_config_updates,
    make_backup,
    parse_config_text,
)


ROOT_DIR = Path(__file__).resolve().parents[2]
CONF_PATH = ROOT_DIR / "conf" / "stitcher.conf.cc"
BACKUP_DIR = ROOT_DIR / "conf" / "backups"
STITCHER_SCRIPT = ROOT_DIR / "stitcher.sh"
FRONTEND_DIR = ROOT_DIR / "frontend"

# Container CLI detection (supports docker, podman, nerdctl, bpk-nerdctl)
CONTAINER_CLI_CACHE: str | None = None


def detect_container_cli() -> str:
    """
    Detect which container CLI is available.
    Tries in order: bpk-nerdctl, nerdctl, podman, docker
    Returns the CLI name (e.g., "docker", "podman", "nerdctl", "bpk-nerdctl")
    Raises RuntimeError if no CLI is found.
    """
    for cli in ["bpk-nerdctl", "nerdctl", "podman", "docker"]:
        result = subprocess.run(
            f"command -v {cli}",
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return cli

    raise RuntimeError(
        "No container CLI found (docker, podman, nerdctl, "
        "or bpk-nerdctl required)"
    )


def get_container_cli() -> str:
    """Get the detected container CLI (with caching)."""
    global CONTAINER_CLI_CACHE
    if CONTAINER_CLI_CACHE is None:
        CONTAINER_CLI_CACHE = detect_container_cli()
    return CONTAINER_CLI_CACHE


# Mode detection for Stitcher (container vs native)
STITCHER_MODE_CACHE: dict[str, str] = {"mode": "unknown", "checked_at": ""}


def detect_stitcher_mode() -> str:
    """
    Detect if Stitcher is running in container mode or native (RPM) mode.
    Returns: "container", "native", or "unknown"
    """
    try:
        cli = get_container_cli()
    except RuntimeError:
        # No container CLI available, must be native
        if Path("/etc/broadpeak/hpc/stitcher.conf.cc").exists():
            return "native"
        return "unknown"

    # Check if container is running
    result = subprocess.run(
        [cli, "ps", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0 and "stitcher" in result.stdout:
        return "container"

    # Check if stitcher-hpc RPM is installed
    result = subprocess.run(
        ["rpm", "-q", "stitcher-hpc"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return "native"

    # Check if native config file exists
    if Path("/etc/broadpeak/hpc/stitcher.conf.cc").exists():
        return "native"

    # Default unknown
    return "unknown"


def get_stitcher_mode() -> str:
    """Get cached mode or detect it."""
    return detect_stitcher_mode()


def run_stitcher_command(action: str) -> dict[str, Any]:
    """
    Execute stitcher control command via the appropriate method.
    action: "start", "stop", "reload", "status", or "init"
    Returns dict with ok, returncode, and output.
    """
    mode = get_stitcher_mode()

    if mode == "native":
        # Use systemctl for native mode
        cmd_map = {
            "start": ["sudo", "systemctl", "start", "stitcher-hpc"],
            "stop": ["sudo", "systemctl", "stop", "stitcher-hpc"],
            "reload": [
                "sudo",
                "systemctl",
                "reload-or-restart",
                "stitcher-hpc",
            ],
            "status": ["systemctl", "status", "stitcher-hpc", "--no-pager"],
            # Init has no meaning in native mode - it's already installed
            "init": ["echo", "Native mode: stitcher-hpc is already installed"],
        }
    else:
        # Use stitcher.sh for container mode
        cmd_map = {
            "start": [str(STITCHER_SCRIPT), "start"],
            "stop": [str(STITCHER_SCRIPT), "stop"],
            "reload": [str(STITCHER_SCRIPT), "reload"],
            "status": [str(STITCHER_SCRIPT), "status"],
            "init": [str(STITCHER_SCRIPT), "init"],
        }

    if action not in cmd_map:
        raise ValueError(f"Unknown action: {action}")

    cmd = cmd_map[action]
    result = subprocess.run(
        cmd,
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )

    # Return dict format expected by endpoints
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "output": result.stdout + result.stderr,
    }


def stitcher_running() -> bool:
    """Check if Stitcher is currently running."""
    mode = get_stitcher_mode()

    if mode == "native":
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", "stitcher-hpc"],
            check=False,
        )
        return result.returncode == 0
    elif mode == "container":
        try:
            cli = get_container_cli()
            result = subprocess.run(
                [cli, "ps", "--format", "{{.Names}}"],
                capture_output=True,
                text=True,
                check=False,
            )
            return result.returncode == 0 and "stitcher" in result.stdout
        except RuntimeError:
            return False
    else:
        return False


def get_config_path() -> Path:
    """Get the configuration path based on Stitcher mode."""
    mode = get_stitcher_mode()
    if mode == "native":
        return Path("/etc/broadpeak/hpc/stitcher.conf.cc")
    else:
        return CONF_PATH


RESERVED_UPSTREAM_NAMES = {"upstream_stitcher"}


class UpstreamModel(BaseModel):
    name: str = Field(min_length=1)
    endpoints: list[str]

    @field_validator("name")
    @classmethod
    def validate_name(cls, name: str) -> str:
        clean = name.strip()
        if not clean:
            raise ValueError("Upstream name cannot be empty")
        if clean in RESERVED_UPSTREAM_NAMES:
            raise ValueError(f"Upstream name '{clean}' is reserved")
        return clean

    @field_validator("endpoints")
    @classmethod
    def validate_endpoints(cls, endpoints: list[str]) -> list[str]:
        if not endpoints:
            raise ValueError("At least one endpoint is required")
        validated: list[str] = []
        for endpoint in endpoints:
            current = str(endpoint).strip()
            if not current:
                raise ValueError("Endpoint cannot be empty")
            parsed = urllib.parse.urlparse(current)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError(f"Invalid endpoint scheme: {current}")
            if not parsed.netloc:
                raise ValueError(f"Invalid endpoint host: {current}")
            validated.append(current)
        return validated


class ServiceConfigModel(BaseModel):
    name: str = Field(min_length=1)
    settings: dict[str, str]


class DefaultSettingMetaModel(BaseModel):
    label: str = ""
    tooltip: str = ""

    @field_validator("label", "tooltip")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return str(value).strip()


class VhostEndpointModel(BaseModel):
    protocol: str
    port: int = Field(ge=1, le=65535)

    @field_validator("protocol")
    @classmethod
    def validate_protocol(cls, protocol: str) -> str:
        clean = str(protocol).strip().upper()
        if clean not in {"HTTP", "HTTPS"}:
            raise ValueError("Vhost endpoint protocol must be HTTP or HTTPS")
        return clean


class VhostModel(BaseModel):
    name: str = Field(min_length=1)
    var: str = Field(min_length=1)
    pattern: str = Field(min_length=1)
    endpoints: list[VhostEndpointModel]
    cert_selfsigned: str | None = None
    cert_file: str | None = None
    upstream: str = Field(min_length=1)

    @field_validator("name", "var", "pattern", "upstream")
    @classmethod
    def validate_non_empty_fields(cls, value: str) -> str:
        clean = str(value).strip()
        if not clean:
            raise ValueError("Vhost field cannot be empty")
        return clean

    @field_validator("endpoints")
    @classmethod
    def validate_endpoints(
        cls,
        endpoints: list[VhostEndpointModel],
    ) -> list[VhostEndpointModel]:
        if not endpoints:
            raise ValueError("Vhost must have at least one endpoint")
        return endpoints


class ConfigUpdateModel(BaseModel):
    default_settings: dict[str, str]
    default_settings_meta: dict[
        str,
        DefaultSettingMetaModel,
    ] = Field(default_factory=dict)
    monitoring_enabled: bool = False
    prometheus_port: int = Field(default=11450, ge=1, le=65535)
    services: list[ServiceConfigModel]
    upstreams: list[UpstreamModel]
    vhosts: list[VhostModel]

    @field_validator("default_settings")
    @classmethod
    def validate_default_settings(
        cls,
        default_settings: dict[str, str],
    ) -> dict[str, str]:
        if not default_settings:
            raise ValueError("default_settings cannot be empty")

        validated: dict[str, str] = {}
        for key, value in default_settings.items():
            clean_key = str(key).strip()
            clean_value = str(value).strip()

            if not clean_key:
                raise ValueError("Default setting key cannot be empty")
            if not clean_value:
                raise ValueError(
                    f"Default setting value cannot be empty: {clean_key}",
                )

            validated[clean_key] = clean_value

        return validated

    @model_validator(mode="after")
    def validate_service_overrides(self) -> "ConfigUpdateModel":
        allowed_keys = set(self.default_settings.keys())

        for service in self.services:
            clean_name = service.name.strip()
            if not clean_name:
                raise ValueError("Service name cannot be empty")

            normalized: dict[str, str] = {}
            for key, value in service.settings.items():
                clean_key = str(key).strip()
                clean_value = str(value).strip()

                if clean_key not in allowed_keys:
                    raise ValueError(
                        "Service override key is not in default_settings: "
                        f"{clean_key}",
                    )
                if not clean_value:
                    raise ValueError(
                        "Service override value cannot be empty: "
                        f"{service.name}.{clean_key}",
                    )

                normalized[clean_key] = clean_value

            service.name = clean_name
            service.settings = normalized

        return self

    @model_validator(mode="after")
    def validate_default_settings_meta(self) -> "ConfigUpdateModel":
        allowed_keys = set(self.default_settings.keys())
        for key in self.default_settings_meta.keys():
            if key not in allowed_keys:
                raise ValueError(
                    "default_settings_meta key not found in "
                    f"default_settings: {key}",
                )
        return self

    @model_validator(mode="after")
    def validate_upstream_names_unique(self) -> "ConfigUpdateModel":
        names = [u.name for u in self.upstreams]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate upstream names")
        return self

    @model_validator(mode="after")
    def validate_vhost_names_unique(self) -> "ConfigUpdateModel":
        names = [v.name for v in self.vhosts]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate vhost names")
        return self


class UrlTestModel(BaseModel):
    url: str = Field(min_length=1)
    timeout_seconds: float = Field(default=15, ge=1, le=60)


app = FastAPI(title="Stitcher Controller API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


ANSI_ESCAPE_RE = re.compile(
    r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])",
)
START_JOB_PROGRESS_RE = re.compile(
    r"A start job is running for .*\(\d+s / no limit\)",
)
TRAFFIC_LINE_RE = re.compile(
    r"(?P<upstream>[A-Za-z0-9_.-]+)\s+"
    r"(?P<phase>before_request|after_reply)\s+"
    r"url=(?P<url>\S+)"
    r"(?:\s+Cache-Control=(?P<cache_control>.*?)\s+Expires=(?P<expires>.*))?$",
)
MANIFEST_EXTENSIONS = (
    ".mpd",
    ".m3u8",
    ".ism/manifest",
    ".dash",
)


def _command_exists(name: str) -> bool:
    probe = subprocess.run(
        ["bash", "-lc", f"command -v {name}"],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    return probe.returncode == 0


def clean_terminal_output(text: str) -> str:
    # Remove ANSI sequences and normalize terminal control characters.
    cleaned = ANSI_ESCAPE_RE.sub("", text)
    cleaned = cleaned.replace("\r", "")
    cleaned = cleaned.replace("\x08", "")

    lines: list[str] = []
    last_effective = ""
    pending_blank = False

    for line in cleaned.splitlines():
        normalized = line.rstrip()
        if not normalized:
            pending_blank = True
            continue

        if START_JOB_PROGRESS_RE.search(normalized):
            normalized = "A start job is running..."

        if normalized == last_effective:
            continue

        if pending_blank and lines:
            # Keep paragraph spacing but avoid bursts of blank lines.
            lines.append("")

        lines.append(normalized)
        last_effective = normalized
        pending_blank = False
    return "\n".join(lines).strip()


def strip_terminal_control(text: str) -> str:
    cleaned = ANSI_ESCAPE_RE.sub("", text)
    cleaned = cleaned.replace("\r", "")
    cleaned = cleaned.replace("\x08", "")
    return cleaned


def is_manifest_path(path: str) -> bool:
    return path.lower().endswith(MANIFEST_EXTENSIONS)


def parse_traffic_event(raw_line: str) -> dict[str, Any] | None:
    line = raw_line.strip()
    if not line:
        return None

    match = TRAFFIC_LINE_RE.search(line)
    if not match:
        return None

    url = (match.group("url") or "").strip()
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    path = (parsed.path or "").lower()

    return {
        "upstream": match.group("upstream"),
        "phase": match.group("phase"),
        "url": url,
        "host": host,
        "cache_control": (match.group("cache_control") or "").strip(),
        "expires": (match.group("expires") or "").strip(),
        "is_manifest": is_manifest_path(path),
        "line": line,
    }


@app.get("/api/container-stats")
def get_container_stats() -> dict[str, Any]:
    try:
        cli = get_container_cli()
    except RuntimeError as e:
        return {
            "name": "stitcher",
            "cpu": "--",
            "memory": "--",
            "memory_percent": "--",
            "error": str(e),
        }

    proc = subprocess.run(
        [
            cli,
            "stats",
            "stitcher",
            "--no-stream",
            "--format",
            "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )

    output = clean_terminal_output(f"{proc.stdout}{proc.stderr}")
    if proc.returncode != 0 or not output:

        @model_validator(mode="after")
        def validate_vhost_names_unique(self) -> "ConfigUpdateModel":
            names = [v.name for v in self.vhosts]
            if len(names) != len(set(names)):
                raise ValueError("Duplicate vhost names")
            return self
        return {
            "ok": False,
            "running": stitcher_running(),
            "name": "stitcher",
            "cpu": "--",
            "memory": "--",
            "memory_percent": "--",
            "error": output or "Unable to read docker stats.",
        }

    parts = output.split("\t")
    if len(parts) < 4:
        return {
            "ok": False,
            "running": stitcher_running(),
            "name": "stitcher",
            "cpu": "--",
            "memory": "--",
            "memory_percent": "--",
            "error": f"Unexpected docker stats output: {output}",
        }

    return {
        "ok": True,
        "running": stitcher_running(),
        "name": parts[0].strip() or "stitcher",
        "cpu": parts[1].strip() or "--",
        "memory": parts[2].strip() or "--",
        "memory_percent": parts[3].strip() or "--",
        "error": "",
    }


@app.get("/api/stitcher-mode")
def get_stitcher_mode_endpoint() -> dict[str, Any]:
    """Get the current Stitcher mode (container or native)."""
    return {
        "mode": get_stitcher_mode(),
    }


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    status_result = run_stitcher_command("status")
    return {
        "running": stitcher_running(),
        "status": status_result,
    }


@app.get("/api/config-ready")
def is_config_ready() -> dict[str, Any]:
    return {
        "ready": get_config_path().exists(),
    }


@app.post("/api/control/{action}")
def control_stitcher(action: str) -> dict[str, Any]:
    allowed = {"start", "stop", "reload", "restart", "init"}
    if action not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported action: {action}",
        )

    if action == "init":
        result = run_stitcher_command("init")
        if not result["ok"]:
            raise HTTPException(status_code=500, detail=result)
        result = run_stitcher_command("start")
        if not result["ok"]:
            raise HTTPException(status_code=500, detail=result)
        return {"result": result, "running": stitcher_running()}

    if action == "reload" and not stitcher_running():
        raise HTTPException(
            status_code=409,
            detail="Cannot reload: Stitcher container is not running.",
        )

    result = run_stitcher_command(action)
    if not result["ok"]:
        raise HTTPException(status_code=500, detail=result)
    return {"result": result, "running": stitcher_running()}


@app.get("/api/config")
def read_config() -> dict[str, Any]:
    conf_path = get_config_path()
    if not conf_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Configuration file not found",
        )
    text = conf_path.read_text(encoding="utf-8")
    parsed = parse_config_text(text)
    return {
        "default_settings": parsed.default_settings,
        "default_settings_meta": parsed.default_settings_meta,
        "monitoring_enabled": parsed.monitoring_enabled,
        "prometheus_port": parsed.prometheus_port,
        "services": parsed.services,
        "upstreams": [
            {"name": u.name, "endpoints": u.endpoints}
            for u in parsed.upstreams
        ],
        "vhosts": [
            {
                "name": v.name,
                "var": v.var,
                "pattern": v.pattern,
                "endpoints": [
                    {"protocol": ep.protocol, "port": ep.port}
                    for ep in v.endpoints
                ],
                "cert_selfsigned": v.cert_selfsigned,
                "cert_file": v.cert_file,
                "upstream": v.upstream,
            }
            for v in parsed.vhosts
        ],
        "raw": parsed.raw,
    }


@app.put("/api/config")
def update_config(payload: ConfigUpdateModel) -> dict[str, Any]:
    conf_path = get_config_path()
    if not conf_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Configuration file not found",
        )

    current = conf_path.read_text(encoding="utf-8")
    backup = make_backup(conf_path, BACKUP_DIR)

    try:
        updated = apply_config_updates(
            text=current,
            default_settings=payload.default_settings,
            default_settings_meta={
                key: value.model_dump()
                for key, value in payload.default_settings_meta.items()
            },
            monitoring_enabled=payload.monitoring_enabled,
            prometheus_port=payload.prometheus_port,
            services=[s.model_dump() for s in payload.services],
            upstreams=[
                UpstreamConfig(name=u.name, endpoints=u.endpoints)
                for u in payload.upstreams
            ],
            vhosts=[
                VhostConfig(
                    name=v.name,
                    var=v.var,
                    pattern=v.pattern,
                    endpoints=[
                        VhostEndpoint(protocol=ep.protocol, port=ep.port)
                        for ep in v.endpoints
                    ],
                    cert_selfsigned=v.cert_selfsigned,
                    cert_file=v.cert_file,
                    upstream=v.upstream,
                )
                for v in payload.vhosts
            ],
        )
        conf_path.write_text(updated, encoding="utf-8")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Configuration update error: {exc}",
        ) from exc

    return {
        "ok": True,
        "backup": str(backup.relative_to(ROOT_DIR)),
    }


@app.get("/api/backups")
def list_backups() -> dict[str, Any]:
    if not BACKUP_DIR.exists():
        return {"backups": []}
    backups = sorted(
        [p.name for p in BACKUP_DIR.glob("stitcher.conf.*.cc")],
        reverse=True,
    )
    return {"backups": backups}


@app.post("/api/backups/{backup_name}/restore")
def restore_backup(backup_name: str) -> dict[str, Any]:
    backup_path = BACKUP_DIR / backup_name
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail="Backup not found")
    conf_path = get_config_path()
    make_backup(conf_path, BACKUP_DIR)
    conf_path.write_text(
        backup_path.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return {"ok": True, "restored": backup_name}


@app.post("/api/test-url")
def test_url(payload: UrlTestModel) -> dict[str, Any]:
    request = urllib.request.Request(
        payload.url,
        headers={"User-Agent": "StitcherController/1.0"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(
            request,
            timeout=payload.timeout_seconds,
        ) as response:
            data = response.read(4096)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return {
                "ok": True,
                "status": response.status,
                "final_url": response.geturl(),
                "elapsed_ms": elapsed_ms,
                "headers": dict(response.headers.items()),
                "body_preview": data.decode("utf-8", errors="replace"),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read(4096).decode("utf-8", errors="replace")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "status": exc.code,
            "final_url": payload.url,
            "elapsed_ms": elapsed_ms,
            "headers": dict(exc.headers.items()) if exc.headers else {},
            "body_preview": body,
            "error": str(exc),
        }
    except urllib.error.URLError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"URL test failed: {exc}",
        ) from exc


@app.get("/api/docker-logs")
def get_docker_logs(tail: int = 300) -> dict[str, Any]:
    safe_tail = max(1, min(tail, 2000))
    try:
        cli = get_container_cli()
    except RuntimeError:
        return {
            "ok": False,
            "tail": safe_tail,
            "logs": "No container CLI available.",
        }

    proc = subprocess.run(
        [cli, "logs", "--tail", str(safe_tail), "stitcher"],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )

    output = f"{proc.stdout}{proc.stderr}".strip()
    output = clean_terminal_output(output)
    if proc.returncode != 0 and not output:
        output = (
            "Unable to read container logs "
            "(container may be stopped or missing)."
        )

    return {
        "ok": proc.returncode == 0,
        "tail": safe_tail,
        "logs": output,
    }


@app.get("/api/origin-traffic")
def get_origin_traffic(
    tail: int = 1200,
    origin_host: str = "",
    manifest_only: bool = False,
) -> dict[str, Any]:
    safe_tail = max(50, min(tail, 5000))
    host_filter = origin_host.strip().lower()

    proc = subprocess.run(
        ["docker", "logs", "--tail", str(safe_tail), "stitcher"],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )

    raw_output = strip_terminal_control(f"{proc.stdout}{proc.stderr}")
    events: list[dict[str, Any]] = []

    for raw_line in raw_output.splitlines():
        event = parse_traffic_event(raw_line)
        if not event:
            continue

        if host_filter and event["host"] != host_filter:
            continue
        if manifest_only and not event["is_manifest"]:
            continue

        events.append(event)

    before_count = sum(
        1 for event in events if event["phase"] == "before_request"
    )
    after_count = sum(1 for event in events if event["phase"] == "after_reply")
    manifest_count = sum(1 for event in events if event["is_manifest"])

    return {
        "ok": proc.returncode == 0,
        "tail": safe_tail,
        "origin_host": host_filter,
        "manifest_only": manifest_only,
        "count": len(events),
        "summary": {
            "before_request": before_count,
            "after_reply": after_count,
            "manifest": manifest_count,
        },
        "events": events,
    }


if FRONTEND_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(FRONTEND_DIR), html=True),
        name="frontend",
    )

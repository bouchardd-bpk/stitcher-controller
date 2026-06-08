from __future__ import annotations

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
    apply_config_updates,
    make_backup,
    parse_config_text,
)


ROOT_DIR = Path(__file__).resolve().parents[2]
CONF_PATH = ROOT_DIR / "conf" / "stitcher.conf.cc"
BACKUP_DIR = ROOT_DIR / "conf" / "backups"
STITCHER_SCRIPT = ROOT_DIR / "stitcher.sh"
FRONTEND_DIR = ROOT_DIR / "frontend"


class ServiceConfigModel(BaseModel):
    name: str = Field(min_length=1)
    settings: dict[str, str]


class ConfigUpdateModel(BaseModel):
    default_settings: dict[str, str]
    services: list[ServiceConfigModel]
    upstream_origin_endpoints: list[str]

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

    @field_validator("upstream_origin_endpoints")
    @classmethod
    def validate_upstream_origin_endpoints(
        cls,
        endpoints: list[str],
    ) -> list[str]:
        validated: list[str] = []
        for endpoint in endpoints:
            current = str(endpoint).strip()
            if not current:
                raise ValueError("Endpoint cannot be empty")

            parsed = urllib.parse.urlparse(current)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError(
                    f"Invalid endpoint scheme: {current}",
                )
            if not parsed.netloc:
                raise ValueError(
                    f"Invalid endpoint host: {current}",
                )

            validated.append(current)
        return validated


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


def run_stitcher_command(command: str) -> dict[str, Any]:
    if not STITCHER_SCRIPT.exists():
        raise HTTPException(status_code=500, detail="stitcher.sh not found")

    try:
        proc = subprocess.run(
            ["bash", str(STITCHER_SCRIPT), command],
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Command error: {exc}",
        ) from exc

    return {
        "command": command,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "ok": proc.returncode == 0,
    }


def stitcher_running() -> bool:
    proc = subprocess.run(
        [
            "docker",
            "ps",
            "--filter",
            "name=^/stitcher$",
            "--format",
            "{{.Names}}",
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    return "stitcher" in proc.stdout.splitlines()


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    status_result = run_stitcher_command("status")
    return {
        "running": stitcher_running(),
        "status": status_result,
    }


@app.post("/api/control/{action}")
def control_stitcher(action: str) -> dict[str, Any]:
    allowed = {"start", "stop", "reload", "restart", "init"}
    if action not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported action: {action}",
        )

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
    if not CONF_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="Configuration file not found",
        )
    text = CONF_PATH.read_text(encoding="utf-8")
    parsed = parse_config_text(text)
    return {
        "default_settings": parsed.default_settings,
        "services": parsed.services,
        "upstream_origin_endpoints": parsed.upstream_origin_endpoints,
        "raw": parsed.raw,
    }


@app.put("/api/config")
def update_config(payload: ConfigUpdateModel) -> dict[str, Any]:
    if not CONF_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="Configuration file not found",
        )

    current = CONF_PATH.read_text(encoding="utf-8")
    backup = make_backup(CONF_PATH, BACKUP_DIR)

    try:
        updated = apply_config_updates(
            text=current,
            default_settings=payload.default_settings,
            services=[s.model_dump() for s in payload.services],
            upstream_origin_endpoints=payload.upstream_origin_endpoints,
        )
        CONF_PATH.write_text(updated, encoding="utf-8")
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
    make_backup(CONF_PATH, BACKUP_DIR)
    CONF_PATH.write_text(
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


if FRONTEND_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(FRONTEND_DIR), html=True),
        name="frontend",
    )

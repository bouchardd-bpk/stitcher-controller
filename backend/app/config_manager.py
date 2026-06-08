from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_PATTERN = re.compile(
    r"default_config\(\{(?P<body>.*?)\}\);",
    re.DOTALL,
)

SERVICE_CONFIG_PATTERN = re.compile(
    r"service_config\(\"(?P<name>[^\"]+)\",\s*\{(?P<body>.*?)\}\);",
    re.DOTALL,
)

UPSTREAM_ORIGIN_PATTERN = re.compile(
    r"config\.upstreams\[\"upstream_origin\"\]\s*=\s*\{(?P<body>.*?)\};",
    re.DOTALL,
)

ENDPOINTS_PATTERN = re.compile(
    r"\.endpoints\s*=\s*\{(?P<body>.*?)\},",
    re.DOTALL,
)


@dataclass
class ParsedConfig:
    default_settings: dict[str, str]
    services: list[dict[str, Any]]
    upstream_origin_endpoints: list[str]
    raw: str


def _parse_assignments(block: str) -> dict[str, str]:
    result: dict[str, str] = {}
    assign_re = re.compile(r"\.(\w+)\s*=\s*([^,]+)")
    for match in assign_re.finditer(block):
        key = match.group(1).strip()
        value = match.group(2).strip()
        result[key] = value
    return result


def parse_config_text(text: str) -> ParsedConfig:
    default_match = DEFAULT_CONFIG_PATTERN.search(text)
    if not default_match:
        raise ValueError("default_config block not found")
    default_settings = _parse_assignments(default_match.group("body"))

    services: list[dict[str, Any]] = []
    for service_match in SERVICE_CONFIG_PATTERN.finditer(text):
        service_name = service_match.group("name")
        values = _parse_assignments(service_match.group("body"))
        services.append({"name": service_name, "settings": values})

    upstream_match = UPSTREAM_ORIGIN_PATTERN.search(text)
    if not upstream_match:
        raise ValueError("upstream_origin block not found")
    upstream_block = upstream_match.group("body")
    endpoints_match = ENDPOINTS_PATTERN.search(upstream_block)
    endpoints: list[str] = []
    if endpoints_match:
        body = endpoints_match.group("body")
        for raw_ep in body.split(","):
            raw_ep = raw_ep.strip()
            if not raw_ep:
                continue
            endpoints.append(raw_ep.strip().strip('"'))

    return ParsedConfig(
        default_settings=default_settings,
        services=services,
        upstream_origin_endpoints=endpoints,
        raw=text,
    )


def _render_defaults_clean(default_settings: dict[str, str]) -> str:
    if not default_settings:
        raise ValueError("default_settings cannot be empty")

    lines = []
    keys = list(default_settings.keys())
    for idx, key in enumerate(keys):
        value = str(default_settings[key]).strip()
        if key.startswith("param_"):
            value = _ensure_quoted_literal(value)
        suffix = "," if idx < len(keys) - 1 else ""
        lines.append(f"                .{key} = {value}{suffix}")
    return "default_config({\n" + "\n".join(lines) + "\n});"


def _ensure_quoted_literal(value: str) -> str:
    raw = str(value).strip()
    if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
        return raw
    return f'"{raw}"'


def _render_service(service: dict[str, Any]) -> str:
    name = service["name"]
    settings = service.get("settings", {})
    parts = []
    for key, value in settings.items():
        if value is None or str(value).strip() == "":
            continue
        parts.append(f".{key} = {value}")
    return f"service_config(\"{name}\", {{{', '.join(parts)}}});"


def _render_services(services: list[dict[str, Any]]) -> str:
    if not services:
        return ""
    return "\n".join(_render_service(s) for s in services)


def _render_endpoints(endpoints: list[str]) -> str:
    quoted = ", ".join(f'\"{ep}\"' for ep in endpoints)
    return f".endpoints = {{{quoted}}},"


def apply_config_updates(
    text: str,
    default_settings: dict[str, str],
    services: list[dict[str, Any]],
    upstream_origin_endpoints: list[str],
) -> str:
    default_match = DEFAULT_CONFIG_PATTERN.search(text)
    if not default_match:
        raise ValueError("default_config block not found")

    upstream_match = UPSTREAM_ORIGIN_PATTERN.search(text)
    if not upstream_match:
        raise ValueError("upstream_origin block not found")

    default_block = _render_defaults_clean(default_settings)
    text = (
        text[:default_match.start()]
        + default_block
        + text[default_match.end():]
    )

    # Recompute matches after default block replacement to keep offsets valid.
    services_matches = list(SERVICE_CONFIG_PATTERN.finditer(text))

    services_block = _render_services(services)
    if services_block:
        services_block += "\n"

    if services_matches:
        first_service_start = services_matches[0].start()
        last_service_end = services_matches[-1].end()
        text = (
            text[:first_service_start]
            + services_block
            + text[last_service_end:]
        )
    else:
        default_match_new = DEFAULT_CONFIG_PATTERN.search(text)
        if not default_match_new:
            raise ValueError("default_config block not found after update")
        insertion_point = default_match_new.end()
        text = (
            text[:insertion_point]
            + "\n"
            + services_block
            + text[insertion_point:]
        )

    upstream_match = UPSTREAM_ORIGIN_PATTERN.search(text)
    if not upstream_match:
        raise ValueError("upstream_origin block not found after update")
    upstream_block = upstream_match.group(0)

    endpoints_line = _render_endpoints(upstream_origin_endpoints)
    if ENDPOINTS_PATTERN.search(upstream_block):
        upstream_block_new = ENDPOINTS_PATTERN.sub(
            endpoints_line,
            upstream_block,
            count=1,
        )
    else:
        insert_pos = upstream_block.rfind("};")
        if insert_pos == -1:
            raise ValueError("Invalid upstream_origin block")
        upstream_block_new = (
            upstream_block[:insert_pos]
            + f"    {endpoints_line}\n"
            + upstream_block[insert_pos:]
        )

    text = (
        text[:upstream_match.start()]
        + upstream_block_new
        + text[upstream_match.end():]
    )
    return text


def make_backup(config_path: Path, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = __import__("datetime").datetime.now().strftime(
        "%Y%m%d_%H%M%S_%f"
    )
    backup_path = backup_dir / f"stitcher.conf.{timestamp}.cc"
    backup_path.write_text(
        config_path.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return backup_path

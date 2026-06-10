from __future__ import annotations

import re
import json
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

# Matches any named upstream block EXCEPT upstream_stitcher
UPSTREAM_BLOCK_PATTERN = re.compile(
    r"config\.upstreams\[\"(?P<name>upstream_(?!stitcher)[^\"]+)\"\]\s*=\s*\{(?P<body>.*?)\};",
    re.DOTALL,
)

ENDPOINTS_IN_BLOCK_PATTERN = re.compile(
    r"\.endpoints\s*=\s*\{(?P<body>[^}]*)\},",
    re.DOTALL,
)

# The upstream_stitcher block (preserved as-is)
UPSTREAM_STITCHER_BLOCK_PATTERN = re.compile(
    r"(auto& upstream_stitcher_conf.*?};)",
    re.DOTALL,
)
# Vhost blocks: auto& <var> = config.vhosts["<name>"];
VHOST_BLOCK_PATTERN = re.compile(
    r'auto& (?P<var>\w+) = config\.vhosts\["(?P<name>[^"]+)"\];'
    r'(?P<body>(?:\s*\w+\.\w+\s*=\s*[^;]+;)*)',
    re.DOTALL,
)

# register_vhost lines
REGISTER_VHOST_PATTERN = re.compile(
    r'register_vhost\((?P<var>\w+),\s*"upstream_stitcher",\s*"(?P<upstream>[^"]+)"\);',
)

PROMETHEUS_PORT_PATTERN = re.compile(
    r"^\s*config\.prometheus_port\s*=\s*(?P<port>\d+)\s*;",
    re.MULTILINE,
)

MONITORING_FLAG_PATTERNS: dict[str, re.Pattern[str]] = {
    "network_monitoring": re.compile(
        r"^\s*product\.default_settings\.network_monitoring\.is_enabled\s*=\s*(?P<value>true|false)\s*;",
        re.MULTILINE,
    ),
    "metrics": re.compile(
        r"^\s*product\.default_settings\.monitoring\.metrics\.is_enabled\s*=\s*(?P<value>true|false)\s*;",
        re.MULTILINE,
    ),
    "storage": re.compile(
        r"^\s*product\.default_settings\.monitoring\.storage\.is_enabled\s*=\s*(?P<value>true|false)\s*;",
        re.MULTILINE,
    ),
    "services_upstreams_active": re.compile(
        r"^\s*product\.default_settings\.monitoring\.services_upstreams\.active\.is_enabled\s*=\s*(?P<value>true|false)\s*;",
        re.MULTILINE,
    ),
    "services_upstreams_passive": re.compile(
        r"^\s*product\.default_settings\.monitoring\.services_upstreams\.passive\.is_enabled\s*=\s*(?P<value>true|false)\s*;",
        re.MULTILINE,
    ),
}

@dataclass
class UpstreamConfig:
    name: str
    endpoints: list[str]


@dataclass
class VhostEndpoint:
    protocol: str   # "HTTP" or "HTTPS"
    port: int


@dataclass
class VhostConfig:
    name: str
    var: str        # C++ variable name (e.g. "vh", "vh_qos")
    pattern: str
    endpoints: list[VhostEndpoint]
    cert_selfsigned: str | None   # e.g. "default", or None
    cert_file: str | None         # custom cert string, or None
    upstream: str                 # upstream used in register_vhost


@dataclass
class ParsedConfig:
    default_settings: dict[str, str]
    default_settings_meta: dict[str, dict[str, str]]
    monitoring_enabled: bool
    prometheus_port: int
    services: list[dict[str, Any]]
    upstreams: list[UpstreamConfig]
    vhosts: list[VhostConfig]
    raw: str


def _parse_assignments(block: str) -> dict[str, str]:
    result: dict[str, str] = {}
    assign_re = re.compile(r"\.(\w+)\s*=\s*([^,]+)")
    for match in assign_re.finditer(block):
        key = match.group(1).strip()
        value = match.group(2).strip()
        result[key] = value
    return result


def _parse_default_settings_with_meta(
    block: str,
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    defaults: dict[str, str] = {}
    metadata: dict[str, dict[str, str]] = {}

    pending_meta: dict[str, str] | None = None
    ui_meta_re = re.compile(r"^//\s*ui_meta\s*:\s*(\{.*\})\s*$")
    assignment_re = re.compile(r"^\.(\w+)\s*=\s*([^,]+)\s*,?\s*$")

    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        meta_match = ui_meta_re.match(line)
        if meta_match:
            pending_meta = None
            try:
                parsed = json.loads(meta_match.group(1))
                if isinstance(parsed, dict):
                    label = str(parsed.get("label", "")).strip()
                    tooltip = str(parsed.get("tooltip", "")).strip()
                    if label or tooltip:
                        pending_meta = {
                            "label": label,
                            "tooltip": tooltip,
                        }
            except Exception:
                pending_meta = None
            continue

        assignment_match = assignment_re.match(line)
        if not assignment_match:
            continue

        key = assignment_match.group(1).strip()
        value = assignment_match.group(2).strip()
        defaults[key] = value
        if pending_meta:
            metadata[key] = pending_meta
            pending_meta = None

    return defaults, metadata


def _parse_endpoints(upstream_body: str) -> list[str]:
    endpoints_match = ENDPOINTS_IN_BLOCK_PATTERN.search(upstream_body)
    if not endpoints_match:
        return []
    body = endpoints_match.group("body")
    result = []
    for raw_ep in body.split(","):
        ep = raw_ep.strip().strip('"')
        if ep:
            result.append(ep)
    return result


def _parse_vhosts(text: str) -> list[VhostConfig]:
    # Build register_vhost map: var -> upstream
    reg_map: dict[str, str] = {}
    for m in REGISTER_VHOST_PATTERN.finditer(text):
        reg_map[m.group("var")] = m.group("upstream")

    vhosts: list[VhostConfig] = []
    for m in VHOST_BLOCK_PATTERN.finditer(text):
        var = m.group("var")
        name = m.group("name")
        body = m.group("body")

        # pattern
        pat_match = re.search(r'pattern\s*=\s*"([^"]+)"', body)
        pattern = pat_match.group(1) if pat_match else ".*"

        # endpoints: endpoint(HTTP, 80) or endpoint(HTTPS, 443)
        ep_list: list[VhostEndpoint] = []
        ep_block_match = re.search(
            r'\.endpoints\s*=\s*\{([^}]+)\}', body
        )
        if ep_block_match:
            for ep_m in re.finditer(
                r'endpoint\((?P<proto>HTTP|HTTPS),\s*(?P<port>\d+)\)',
                ep_block_match.group(1),
            ):
                ep_list.append(VhostEndpoint(
                    protocol=ep_m.group("proto"),
                    port=int(ep_m.group("port")),
                ))

        # certificates
        cert_selfsigned: str | None = None
        cert_file: str | None = None
        cert_match = re.search(
            r'\.certificates\s*=\s*\{selfsigned_certificate\("([^"]+)"\)\}',
            body,
        )
        if cert_match:
            cert_selfsigned = cert_match.group(1)
        else:
            file_cert_match = re.search(
                r'\.certificates\s*=\s*\{\{([^}]+)\}\}', body
            )
            if file_cert_match:
                cert_file = file_cert_match.group(1).strip()

        upstream = reg_map.get(var, "")
        vhosts.append(VhostConfig(
            name=name,
            var=var,
            pattern=pattern,
            endpoints=ep_list,
            cert_selfsigned=cert_selfsigned,
            cert_file=cert_file,
            upstream=upstream,
        ))
    return vhosts


def parse_config_text(text: str) -> ParsedConfig:
    default_match = DEFAULT_CONFIG_PATTERN.search(text)
    if not default_match:
        raise ValueError("default_config block not found")
    (
        default_settings,
        default_settings_meta,
    ) = _parse_default_settings_with_meta(default_match.group("body"))

    services: list[dict[str, Any]] = []
    for service_match in SERVICE_CONFIG_PATTERN.finditer(text):
        service_name = service_match.group("name")
        values = _parse_assignments(service_match.group("body"))
        services.append({"name": service_name, "settings": values})

    upstreams: list[UpstreamConfig] = []
    for upstream_match in UPSTREAM_BLOCK_PATTERN.finditer(text):
        name = upstream_match.group("name")
        body = upstream_match.group("body")
        endpoints = _parse_endpoints(body)
        upstreams.append(UpstreamConfig(name=name, endpoints=endpoints))

    vhosts = _parse_vhosts(text)

    prometheus_match = PROMETHEUS_PORT_PATTERN.search(text)
    if not prometheus_match:
        raise ValueError("config.prometheus_port assignment not found")
    prometheus_port = int(prometheus_match.group("port"))

    monitoring_values: list[bool] = []
    for pattern in MONITORING_FLAG_PATTERNS.values():
        match = pattern.search(text)
        if not match:
            raise ValueError("One or more monitoring flags not found")
        monitoring_values.append(match.group("value") == "true")

    # Keep a deterministic UI state when the file has mixed values.
    monitoring_enabled = all(monitoring_values)

    return ParsedConfig(
        default_settings=default_settings,
        default_settings_meta=default_settings_meta,
        monitoring_enabled=monitoring_enabled,
        prometheus_port=prometheus_port,
        services=services,
        upstreams=upstreams,
        vhosts=vhosts,
        raw=text,
    )


def _replace_prometheus_port(text: str, prometheus_port: int) -> str:
    return PROMETHEUS_PORT_PATTERN.sub(
        lambda match: match.group(0).replace(
            match.group("port"),
            str(prometheus_port),
            1,
        ),
        text,
        count=1,
    )


def _replace_monitoring_flags(text: str, monitoring_enabled: bool) -> str:
    value = "true" if monitoring_enabled else "false"
    updated = text
    for pattern in MONITORING_FLAG_PATTERNS.values():
        updated = pattern.sub(
            lambda match: match.group(0).replace(
                match.group("value"),
                value,
                1,
            ),
            updated,
            count=1,
        )
    return updated


def _render_defaults_clean(
    default_settings: dict[str, str],
    default_settings_meta: dict[str, dict[str, str]] | None = None,
) -> str:
    if not default_settings:
        raise ValueError("default_settings cannot be empty")

    metadata = default_settings_meta or {}
    lines = []
    keys = list(default_settings.keys())
    for idx, key in enumerate(keys):
        meta_for_key = metadata.get(key, {})
        label = str(meta_for_key.get("label", "")).strip()
        tooltip = str(meta_for_key.get("tooltip", "")).strip()
        if label or tooltip:
            payload = json.dumps(
                {"label": label, "tooltip": tooltip},
                ensure_ascii=True,
                separators=(",", ":"),
            )
            lines.append(f"                // ui_meta: {payload}")

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


_UPSTREAM_EXPIRATION = (
    'hpc::expire::by_extension('
    '{{'
    '".mpd", 1s, 100ms}, {".m3u8", 1s, 100ms}, '
    '{".mp4", 7200s, 100ms}, {".ts", 7200s, 100ms}, '
    '{".dash", 7200s, 100ms}'
    '}'
    ')'
)

_UPSTREAM_SECTION_COMMENT = "/* === UPSTREAM ORIGIN ===================== */\n"
_UPSTREAM_SECTION_COMMENT_RE = re.compile(
    r'(?:/\* === UPSTREAM ORIGIN ===================== \*/\n)+',
)


def _render_upstream_block(upstream: UpstreamConfig) -> str:
    name = upstream.name
    endpoints_line = _render_endpoints(upstream.endpoints)
    lines = [
        f'config.upstreams["{name}"] = {{',
        '    .max_redirect = 10,',
        '    .before_request = [](cache::upstream_request& request) {'
        f' stitcher::log().debug("{name} before_request url={{}}",'
        ' request.get_url()); },',
        '    .after_reply =',
        '        [](cache::upstream_request& request, cache::upstream_reply& reply) {',
        f'            stitcher::log().debug("{name} after_reply url={{}} Cache-Control={{}} Expires={{}}",',
        '                                  request.get_url(),',
        '                                  reply.get_header(proxygen::HTTP_HEADER_CACHE_CONTROL),'
        ' reply.get_header(proxygen::HTTP_HEADER_EXPIRES));',
        '            reply.remove_header(proxygen::HTTP_HEADER_CACHE_CONTROL);',
        '            reply.remove_header(proxygen::HTTP_HEADER_EXPIRES);',
        '        },',
        '    .default_expiration_function =',
        f'        {_UPSTREAM_EXPIRATION},',
        f'    {endpoints_line}',
        '};',
    ]
    return '\n'.join(lines)


def _vhost_var(name: str) -> str:
    """Derive a safe C++ variable name from the vhost config key."""
    return re.sub(r'[^a-z0-9]', '_', name.lower())


def _render_vhost_block(vhost: VhostConfig) -> str:
    var = vhost.var or _vhost_var(vhost.name)
    lines = []
    lines.append(f'auto& {var} = config.vhosts["{vhost.name}"];')
    lines.append(f'{var}.pattern = "{vhost.pattern}";')

    eps = ', '.join(
        f'endpoint({ep.protocol}, {ep.port})'
        for ep in vhost.endpoints
    )
    lines.append(f'{var}.endpoints = {{{eps}}};')

    has_https = any(ep.protocol == "HTTPS" for ep in vhost.endpoints)
    if has_https:
        if vhost.cert_file:
            lines.append(f'{var}.certificates = {{{{{vhost.cert_file}}}}};')
        else:
            cert_name = vhost.cert_selfsigned or "default"
            lines.append(
                f'{var}.certificates = '
                f'{{selfsigned_certificate("{cert_name}")}};'
            )

    return '\n'.join(lines)


def _render_vhosts_section(
    vhosts: list[VhostConfig],
) -> str:
    blocks = '\n\n'.join(_render_vhost_block(v) for v in vhosts)
    register_lines = '\n'.join(
        f'register_vhost({v.var or _vhost_var(v.name)},'
        f' "upstream_stitcher", "{v.upstream}");'
        for v in vhosts
    )
    return blocks + '\n\n/* === Register handlers on vhosts ========== */\n\n' + register_lines


# Pattern for the entire vhost + register_vhost section to replace atomically
_VHOST_SECTION_PATTERN = re.compile(
    r'(?:/\* === WEB server.*?\*/\n)?'
    r'(?:auto& \w+ = config\.vhosts.*?)'
    r'(?:register_vhost\([^)]+\);\n?)+',
    re.DOTALL,
)


def apply_config_updates(
    text: str,
    default_settings: dict[str, str],
    default_settings_meta: dict[str, dict[str, str]] | None,
    monitoring_enabled: bool,
    prometheus_port: int,
    services: list[dict[str, Any]],
    upstreams: list[UpstreamConfig],
    vhosts: list[VhostConfig],
) -> str:
    text = _replace_monitoring_flags(text, monitoring_enabled)
    text = _replace_prometheus_port(text, prometheus_port)

    # --- default_config block ---
    default_match = DEFAULT_CONFIG_PATTERN.search(text)
    if not default_match:
        raise ValueError("default_config block not found")

    default_block = _render_defaults_clean(
        default_settings,
        default_settings_meta,
    )
    text = (
        text[:default_match.start()]
        + default_block
        + text[default_match.end():]
    )

    # --- service_config blocks ---
    services_matches = list(SERVICE_CONFIG_PATTERN.finditer(text))
    services_block = _render_services(services)
    if services_block:
        services_block += "\n"

    if services_matches:
        first = services_matches[0].start()
        last = services_matches[-1].end()
        text = text[:first] + services_block + text[last:]
    else:
        default_match_new = DEFAULT_CONFIG_PATTERN.search(text)
        if not default_match_new:
            raise ValueError("default_config block not found after update")
        insertion_point = default_match_new.end()
        text = text[:insertion_point] + "\n" + services_block + text[insertion_point:]

    # --- upstream blocks (all except upstream_stitcher) ---
    upstream_matches = list(UPSTREAM_BLOCK_PATTERN.finditer(text))

    rendered_upstreams = "\n\n".join(_render_upstream_block(u) for u in upstreams)

    if upstream_matches:
        first = upstream_matches[0].start()
        last = upstream_matches[-1].end()
        text = (
            text[:first]
            + _UPSTREAM_SECTION_COMMENT
            + rendered_upstreams
            + "\n"
            + text[last:]
        )
    else:
        stitcher_match = UPSTREAM_STITCHER_BLOCK_PATTERN.search(text)
        if stitcher_match:
            text = (
                text[:stitcher_match.start()]
                + rendered_upstreams
                + "\n\n"
                + text[stitcher_match.start():]
            )

    # Avoid accumulating duplicated section comments across successive saves.
    text = _UPSTREAM_SECTION_COMMENT_RE.sub(_UPSTREAM_SECTION_COMMENT, text)

    # --- vhost + register_vhost section ---
    if vhosts:
        rendered_vhosts = _render_vhosts_section(vhosts)
        section_header = "/* === WEB server listening port =========== */\n"
        vhost_section_match = _VHOST_SECTION_PATTERN.search(text)
        if vhost_section_match:
            text = (
                text[:vhost_section_match.start()]
                + section_header
                + rendered_vhosts
                + "\n"
                + text[vhost_section_match.end():]
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

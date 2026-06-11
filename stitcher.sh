#!/usr/bin/env bash

set -e

CONTAINER_NAME="stitcher"
IMAGE="harbor.broadpeaklab.tv/dev.stitcher/stitcher-rhel9:local-latest"
CONF_DIR="./conf"
CONF_FILE="stitcher.conf.cc"
CONF_PATH="$CONF_DIR/$CONF_FILE"

PORTS="-p 1080:80 -p 1443:443"
DOCKER_COMMON="--privileged --cgroupns=private --tmpfs /run --tmpfs /tmp -h stitcher"

# Container CLI detection (supports docker, podman, nerdctl, bpk-nerdctl)
CONTAINER_CLI=""
COMPOSE_CLI=""

detect_container_cli() {
  # Try bpk-nerdctl first (custom alias)
  if command -v bpk-nerdctl >/dev/null 2>&1; then
    CONTAINER_CLI="bpk-nerdctl"
    # nerdctl doesn't have compose, try to use docker-compose or podman-compose
    if command -v docker-compose >/dev/null 2>&1; then
      COMPOSE_CLI="docker-compose"
    elif command -v podman-compose >/dev/null 2>&1; then
      COMPOSE_CLI="podman-compose"
    else
      COMPOSE_CLI="$CONTAINER_CLI compose"
    fi
    return 0
  fi

  # Try nerdctl
  if command -v nerdctl >/dev/null 2>&1; then
    CONTAINER_CLI="nerdctl"
    # nerdctl doesn't have compose, try to use docker-compose or podman-compose
    if command -v docker-compose >/dev/null 2>&1; then
      COMPOSE_CLI="docker-compose"
    elif command -v podman-compose >/dev/null 2>&1; then
      COMPOSE_CLI="podman-compose"
    else
      COMPOSE_CLI="$CONTAINER_CLI compose"
    fi
    return 0
  fi

  # Try podman
  if command -v podman >/dev/null 2>&1; then
    CONTAINER_CLI="podman"
    if command -v podman-compose >/dev/null 2>&1; then
      COMPOSE_CLI="podman-compose"
    elif podman compose version >/dev/null 2>&1; then
      COMPOSE_CLI="podman compose"
    elif command -v docker-compose >/dev/null 2>&1; then
      COMPOSE_CLI="docker-compose"
    fi
    return 0
  fi

  # Fallback to docker
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_CLI="docker"
    if docker compose version >/dev/null 2>&1; then
      COMPOSE_CLI="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
      COMPOSE_CLI="docker-compose"
    fi
    return 0
  fi

  echo "❌ No container CLI found (docker, podman, nerdctl, or bpk-nerdctl required)" >&2
  return 1
}

# Mode detection
STITCHER_MODE="unknown"

detect_mode() {
  # Check if container is running
  if $CONTAINER_CLI ps 2>/dev/null | grep -q "$CONTAINER_NAME"; then
    STITCHER_MODE="container"
    return 0
  fi

  # Check if stitcher is installed via RPM
  if rpm -q stitcher-hpc >/dev/null 2>&1 || [ -f "/etc/broadpeak/hpc/$CONF_FILE" ]; then
    STITCHER_MODE="native"
    return 0
  fi

  # Check if docker compose file exists and stitcher service is defined
  if [ -f "docker-compose.yml" ] && grep -q "container_name.*stitcher" docker-compose.yml 2>/dev/null; then
    STITCHER_MODE="container"
    return 0
  fi

  # Default to container mode if we have a compose file
  if [ -f "docker-compose.yml" ]; then
    STITCHER_MODE="container"
    return 0
  fi

  STITCHER_MODE="unknown"
}

# Execute command in the right context (container or native)
exec_stitcher_cmd() {
  local cmd="$1"
  if [ "$STITCHER_MODE" = "container" ]; then
    $CONTAINER_CLI exec "$CONTAINER_NAME" sh -c "$cmd"
  else
    sh -c "$cmd"
  fi
}

# Get stitcher service status
stitcher_is_active() {
  if [ "$STITCHER_MODE" = "container" ]; then
    $CONTAINER_CLI exec "$CONTAINER_NAME" systemctl is-active --quiet stitcher-hpc 2>/dev/null && return 0 || return 1
  else
    systemctl is-active --quiet stitcher-hpc 2>/dev/null && return 0 || return 1
  fi
}

# No longer needed - COMPOSE_CLI is set by detect_container_cli()

usage() {
  cat <<EOF
Usage: $0 <command>

Available commands:
  init              Initialize: fetch config from container or validate native
  start             Start Stitcher (native or container)
  stop              Stop Stitcher
  restart           Restart Stitcher
  reload            Reload configuration without full restart
  gen-compose       Generate docker-compose.yml with local config mapping
  compose-start     Start Stitcher using docker compose
  compose-stop      Stop Stitcher using docker compose
  compose-reload    Reload Stitcher config using docker compose
  status            Show Stitcher status (container or native)
  help              Show this help

Modes:
  - Container: Stitcher runs in Docker (detected automatically)
  - Native:    Stitcher runs via RPM (detected automatically)

EOF
}

ensure_conf_dir() {
  if [ ! -d "$CONF_DIR" ]; then
    echo "Creating config directory: $CONF_DIR"
    mkdir -p "$CONF_DIR"
  fi
}

ensure_conf_file_permissions() {
  # Keep the generated config readable/editable by the invoking user.
  if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
    chown "$SUDO_UID:$SUDO_GID" "$CONF_PATH" >/dev/null 2>&1 || true
  fi
  chmod 0644 "$CONF_PATH" >/dev/null 2>&1 || true
}

image_exists_local() {
  $CONTAINER_CLI image inspect "$IMAGE" >/dev/null 2>&1
}

ensure_container_image() {
  if image_exists_local; then
    return 0
  fi

  echo "❌ Image not found in local $CONTAINER_CLI store: $IMAGE"
  echo "   $CONTAINER_CLI and docker may use different local image stores."
  echo "   Fix options:"
  echo "   1) Login and pull with the selected CLI:"
  echo "      sudo $CONTAINER_CLI login harbor.broadpeaklab.tv"
  echo "      sudo $CONTAINER_CLI pull $IMAGE"
  echo "   2) Or import an exported image tar into $CONTAINER_CLI."
  return 1
}

generate_compose() {
  ensure_conf_dir
  local compose_conf_path="${CONF_PATH#./}"

  cat > docker-compose.yml <<EOF
services:
  stitcher:
    image: $IMAGE
    container_name: $CONTAINER_NAME
    hostname: stitcher
    privileged: true
    cgroup: private
    tmpfs:
      - /run
      - /tmp
    ports:
      - "1080:80"
      - "1443:443"
    volumes:
      - ./$compose_conf_path:/etc/broadpeak/hpc/$CONF_FILE
    tty: true
EOF

  echo "✅ docker-compose.yml generated."
  echo "   Start with: docker compose up -d (or docker-compose up -d)"
}

ensure_compose_file() {
  if [ ! -f "docker-compose.yml" ]; then
    echo ">> docker-compose.yml not found, generating it..."
    generate_compose
  fi
}

use_compose_mode() {
  [ -f "docker-compose.yml" ] && [ -n "$COMPOSE_CLI" ]
}

compose_start() {
  ensure_conf_dir
  ensure_compose_file

  if [ -z "$COMPOSE_CLI" ]; then
    echo "❌ Compose is not available (docker compose, podman-compose, or docker-compose)."
    exit 1
  fi

  if [ ! -f "$CONF_PATH" ]; then
    echo "❌ Missing config. Run '$0 init' first."
    exit 1
  fi

  echo ">> Starting Stitcher with compose..."
  local compose_output
  if ! compose_output=$($COMPOSE_CLI up -d stitcher 2>&1); then
    if echo "$compose_output" | grep -q "container name .* is already in use"; then
      echo ">> Existing container name conflict detected, removing old container..."
      $CONTAINER_CLI rm -f $CONTAINER_NAME >/dev/null 2>&1 || true
      echo ">> Retrying compose start..."
      $COMPOSE_CLI up -d stitcher
    else
      echo "$compose_output" >&2
      exit 1
    fi
  fi
  wait_stitcher_ready
  echo "✅ Stitcher started with compose."
}

compose_stop() {
  ensure_compose_file

  if [ -z "$COMPOSE_CLI" ]; then
    echo "❌ Compose is not available (docker compose, podman-compose, or docker-compose)."
    exit 1
  fi

  echo ">> Stopping Stitcher with compose..."
  $COMPOSE_CLI stop stitcher || true
  echo "✅ Stitcher stopped with compose."
}

compose_reload() {
  ensure_compose_file

  if [ -z "$COMPOSE_CLI" ]; then
    echo "❌ Compose is not available (docker compose, podman-compose, or docker-compose)."
    exit 1
  fi

  echo ">> Reload configuration with compose..."
  if ! $COMPOSE_CLI ps --services --filter "status=running" | grep -qx "stitcher"; then
    echo "❌ Cannot reload: Stitcher compose service is not running."
    exit 1
  fi

  $COMPOSE_CLI exec -T stitcher sh -c 'systemctl restart stitcher-hpc'
  echo "✅ Configuration reloaded with compose."
}

wait_stitcher_ready() {
  local max_attempts=40
  local attempt=1

  echo ">> Waiting for stitcher-hpc service readiness..."
  while [ "$attempt" -le "$max_attempts" ]; do
    if stitcher_is_active && check_port_listening; then
      echo "✅ stitcher-hpc is ready."
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "❌ stitcher-hpc did not become ready in time."
  if [ "$STITCHER_MODE" = "container" ]; then
    $CONTAINER_CLI exec $CONTAINER_NAME systemctl status stitcher-hpc --no-pager -l || true
  else
    systemctl status stitcher-hpc --no-pager -l || true
  fi
  return 1
}

check_port_listening() {
  if [ "$STITCHER_MODE" = "container" ]; then
    $CONTAINER_CLI exec "$CONTAINER_NAME" sh -lc "ss -lnt | grep -q ':80 '" 2>/dev/null && return 0 || return 1
  else
    ss -lnt | grep -q ':80 ' && return 0 || return 1
  fi
}

init() {
  detect_mode

  echo "ℹ️  Detected mode: $STITCHER_MODE"

  if [ "$STITCHER_MODE" = "native" ]; then
    echo "ℹ️  Stitcher running in native mode (RPM installed)"
    echo "ℹ️  Configuration location: /etc/broadpeak/hpc/$CONF_FILE"
    if [ ! -f "/etc/broadpeak/hpc/$CONF_FILE" ]; then
      echo "❌ Configuration file not found at /etc/broadpeak/hpc/$CONF_FILE"
      echo "   Please ensure stitcher-hpc RPM is properly installed."
      exit 1
    fi
    echo "✅ Initialization complete (native mode uses system installation)."
    return 0
  fi

  # Container mode initialization
  ensure_conf_dir
  ensure_container_image || exit 1

  # Clean up any leftover container from a previous failed init
  if $CONTAINER_CLI ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    echo ">> Removing existing container '$CONTAINER_NAME'..."
    $CONTAINER_CLI rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi

  echo ">> Starting initial Stitcher container..."
  $CONTAINER_CLI run -d -t $DOCKER_COMMON \
    --name $CONTAINER_NAME $IMAGE

  echo ">> Waiting for container to be ready..."
  local attempt=1
  while [ "$attempt" -le 20 ]; do
    if $CONTAINER_CLI exec "$CONTAINER_NAME" true 2>/dev/null; then
      break
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo ">> Fetching configuration file..."
  mkdir -p "$(dirname "$CONF_PATH")"
  local abs_conf_path
  abs_conf_path="$(pwd)/conf/$CONF_FILE"
  local tmp_conf_path
  tmp_conf_path="$(mktemp "$(pwd)/conf/.${CONF_FILE}.tmp.XXXXXX")"
  local tmp_err_path
  tmp_err_path="$(mktemp "$(pwd)/conf/.${CONF_FILE}.err.XXXXXX")"
  local fetch_ok=0
  local fetch_attempt=1
  while [ "$fetch_attempt" -le 10 ]; do
    : > "$tmp_conf_path"
    : > "$tmp_err_path"

    if $CONTAINER_CLI exec -i "$CONTAINER_NAME" bash -lc "cat /etc/broadpeak/hpc/$CONF_FILE" > "$tmp_conf_path" 2> "$tmp_err_path" && [ -s "$tmp_conf_path" ]; then
      fetch_ok=1
      break
    fi

    : > "$tmp_conf_path"
    if $CONTAINER_CLI exec -i "$CONTAINER_NAME" sh -lc "cat /etc/broadpeak/hpc/$CONF_FILE" > "$tmp_conf_path" 2>> "$tmp_err_path" && [ -s "$tmp_conf_path" ]; then
      fetch_ok=1
      break
    fi

    # Some bpk-nerdctl/rootless setups require a pseudo-TTY for exec.
    : > "$tmp_conf_path"
    if $CONTAINER_CLI exec -it "$CONTAINER_NAME" bash -lc "cat /etc/broadpeak/hpc/$CONF_FILE" > "$tmp_conf_path" 2>> "$tmp_err_path" && [ -s "$tmp_conf_path" ]; then
      fetch_ok=1
      break
    fi

    echo "⚠️  Fetch attempt $fetch_attempt/10 failed. Retrying in 5s..."
    sleep 5
    fetch_attempt=$((fetch_attempt + 1))
  done

  if [ "$fetch_ok" -ne 1 ]; then
    rm -f "$tmp_conf_path" >/dev/null 2>&1 || true
    if [ -s "$tmp_err_path" ]; then
      echo "❌ Last fetch error:" >&2
      tail -n 5 "$tmp_err_path" >&2 || true
    fi
    rm -f "$tmp_err_path" >/dev/null 2>&1 || true
    echo "❌ Failed to fetch configuration from container after 10 attempts."
    $CONTAINER_CLI rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    exit 1
  fi

  mv "$tmp_conf_path" "$abs_conf_path"
  rm -f "$tmp_err_path" >/dev/null 2>&1 || true
  ensure_conf_file_permissions

  echo ">> Stopping initial container..."
  $CONTAINER_CLI stop $CONTAINER_NAME
  $CONTAINER_CLI rm -f $CONTAINER_NAME >/dev/null 2>&1 || true

  generate_compose

  echo "✅ Initialization complete. Config stored in $CONF_PATH"
}

start() {
  detect_mode

  if [ "$STITCHER_MODE" = "unknown" ]; then
    echo "❌ Cannot determine Stitcher mode. Provide --mode container or ensure RPM is installed."
    exit 1
  fi

  if [ "$STITCHER_MODE" = "native" ]; then
    echo ">> Starting Stitcher (native mode via systemctl)..."
    if ! sudo systemctl start stitcher-hpc; then
      echo "❌ Failed to start stitcher-hpc service."
      exit 1
    fi
    wait_stitcher_ready
    echo "✅ Stitcher started."
    return 0
  fi

  # Container mode start
  if use_compose_mode; then
    compose_start
    return
  fi

  ensure_conf_dir

  if [ ! -f "$CONF_PATH" ]; then
    echo "❌ Missing config. Run '$0 init' first."
    exit 1
  fi

  ensure_container_image || exit 1

  echo ">> Starting Stitcher with persisted config..."

  local run_output
  if ! run_output=$($CONTAINER_CLI run -d -t $DOCKER_COMMON $PORTS \
    -v "$(pwd)/$CONF_PATH:/etc/broadpeak/hpc/$CONF_FILE" \
    --name $CONTAINER_NAME $IMAGE 2>&1); then
    if echo "$run_output" | grep -q "is already in use by container"; then
      echo ">> Existing container name conflict detected, removing old container..."
      $CONTAINER_CLI rm -f $CONTAINER_NAME >/dev/null 2>&1 || true
      echo ">> Retrying Stitcher start..."
      $CONTAINER_CLI run -d -t $DOCKER_COMMON $PORTS \
        -v "$(pwd)/$CONF_PATH:/etc/broadpeak/hpc/$CONF_FILE" \
        --name $CONTAINER_NAME $IMAGE
    else
      echo "$run_output" >&2
      exit 1
    fi
  fi

  wait_stitcher_ready

  echo "✅ Stitcher started."
}

stop() {
  detect_mode

  if [ "$STITCHER_MODE" = "native" ]; then
    echo ">> Stopping Stitcher (native mode via systemctl)..."
    sudo systemctl stop stitcher-hpc || true
    echo "✅ Stitcher stopped."
    return 0
  fi

  if [ "$STITCHER_MODE" = "container" ]; then
    if use_compose_mode; then
      compose_stop
      return
    fi

    echo ">> Stopping Stitcher container..."
    $CONTAINER_CLI stop $CONTAINER_NAME || true
    echo "✅ Stitcher stopped."
    return 0
  fi

  echo "⚠️  Stitcher mode unknown, no action taken."
}

restart() {
  stop
  sleep 1
  start
}

reload() {
  detect_mode

  if [ "$STITCHER_MODE" = "native" ]; then
    echo ">> Reloading configuration (native mode)..."
    if ! sudo systemctl reload-or-restart stitcher-hpc; then
      echo "❌ Failed to reload stitcher-hpc service."
      exit 1
    fi
    echo "✅ Configuration reloaded."
    return 0
  fi

  if [ "$STITCHER_MODE" = "container" ]; then
    if use_compose_mode; then
      compose_reload
      return
    fi

    echo ">> Reload configuration..."
    if ! $CONTAINER_CLI ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      echo "❌ Cannot reload: Stitcher container is not running."
      exit 1
    fi

    $CONTAINER_CLI exec $CONTAINER_NAME sh -c 'systemctl restart stitcher-hpc'
    echo "✅ Configuration reloaded."
    return 0
  fi

  echo "❌ Cannot reload: Stitcher mode unknown."
  exit 1
}

status() {
  detect_mode

  echo "ℹ️  Stitcher Mode: $STITCHER_MODE"

  if [ "$STITCHER_MODE" = "native" ]; then
    echo ""
    echo "Native (RPM) Status:"
    systemctl status stitcher-hpc --no-pager -l || true
    return 0
  fi

  if [ "$STITCHER_MODE" = "container" ]; then
    if use_compose_mode; then
      echo ""
      echo "Docker Compose Status:"
      $COMPOSE_CLI ps stitcher || true
    else
      echo ""
      echo "Container Status:"
      $CONTAINER_CLI ps -a | grep $CONTAINER_NAME || echo "Stitcher container not found."
    fi
    return 0
  fi

  echo "⚠️  Stitcher mode unknown."
}

# Initialize container CLI detection
detect_container_cli || exit 1

case "$1" in
  init)
    init
    ;;
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  reload)
    reload
    ;;
  gen-compose)
    generate_compose
    ;;
  compose-start)
    compose_start
    ;;
  compose-stop)
    compose_stop
    ;;
  compose-reload)
    compose_reload
    ;;
  status)
    status
    ;;
  help|*)
    usage
    ;;
esac

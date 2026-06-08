#!/usr/bin/env bash

set -e

CONTAINER_NAME="stitcher"
IMAGE="harbor.broadpeaklab.tv/dev.stitcher/stitcher-rhel9:local-latest"
CONF_DIR="./conf"
CONF_FILE="stitcher.conf.cc"
CONF_PATH="$CONF_DIR/$CONF_FILE"

PORTS="-p 1080:80 -p 1443:443"
DOCKER_COMMON="--privileged --cgroupns=private --tmpfs /run --tmpfs /tmp -h stitcher"

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return 0
  fi

  return 1
}

usage() {
  cat <<EOF
Usage: $0 <command>

Available commands:
  init       Initialize: start container + fetch config
  start      Start Stitcher with persisted config
  stop       Stop Stitcher
  restart    Restart Stitcher
  reload     Reload configuration without full restart
  gen-compose Generate docker-compose.yml with local config mapping
  compose-start Start Stitcher using docker compose
  compose-stop  Stop Stitcher using docker compose
  compose-reload Reload Stitcher config using docker compose
  status     Show container status
  help       Show this help

EOF
}

ensure_conf_dir() {
  if [ ! -d "$CONF_DIR" ]; then
    echo "Creating config directory: $CONF_DIR"
    mkdir -p "$CONF_DIR"
  fi
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
  [ -f "docker-compose.yml" ] && compose_cmd >/dev/null 2>&1
}

compose_start() {
  ensure_conf_dir
  ensure_compose_file

  local compose
  if ! compose="$(compose_cmd)"; then
    echo "❌ Docker Compose is not available (docker compose or docker-compose)."
    exit 1
  fi

  if [ ! -f "$CONF_PATH" ]; then
    echo "❌ Missing config. Run '$0 init' first."
    exit 1
  fi

  echo ">> Starting Stitcher with docker compose..."
  local compose_output
  if ! compose_output=$($compose up -d stitcher 2>&1); then
    if echo "$compose_output" | grep -q "container name .* is already in use"; then
      echo ">> Existing container name conflict detected, removing old container..."
      docker rm -f $CONTAINER_NAME >/dev/null 2>&1 || true
      echo ">> Retrying docker compose start..."
      $compose up -d stitcher
    else
      echo "$compose_output" >&2
      exit 1
    fi
  fi
  wait_stitcher_ready
  echo "✅ Stitcher started with docker compose."
}

compose_stop() {
  ensure_compose_file
  local compose
  if ! compose="$(compose_cmd)"; then
    echo "❌ Docker Compose is not available (docker compose or docker-compose)."
    exit 1
  fi

  echo ">> Stopping Stitcher with docker compose..."
  $compose stop stitcher || true
  echo "✅ Stitcher stopped with docker compose."
}

compose_reload() {
  ensure_compose_file
  local compose
  if ! compose="$(compose_cmd)"; then
    echo "❌ Docker Compose is not available (docker compose or docker-compose)."
    exit 1
  fi

  echo ">> Reload configuration with docker compose..."
  if ! $compose ps --services --filter "status=running" | grep -qx "stitcher"; then
    echo "❌ Cannot reload: Stitcher compose service is not running."
    exit 1
  fi

  $compose exec -T stitcher sh -c 'systemctl restart stitcher-hpc'
  echo "✅ Configuration reloaded with docker compose."
}

wait_stitcher_ready() {
  local max_attempts=40
  local attempt=1

  echo ">> Waiting for stitcher-hpc service readiness..."
  while [ "$attempt" -le "$max_attempts" ]; do
    if docker exec $CONTAINER_NAME systemctl is-active --quiet stitcher-hpc \
      && docker exec $CONTAINER_NAME sh -lc "ss -lnt | grep -q ':80 '"; then
      echo "✅ stitcher-hpc is ready."
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "❌ stitcher-hpc did not become ready in time."
  docker exec $CONTAINER_NAME systemctl status stitcher-hpc --no-pager -l || true
  return 1
}

init() {
  ensure_conf_dir

  echo ">> Starting initial Stitcher container..."
  docker run --rm -d -t $DOCKER_COMMON $PORTS \
    --name $CONTAINER_NAME $IMAGE

  echo ">> Waiting for startup..."
  sleep 5

  echo ">> Fetching configuration file..."
  docker cp "$CONTAINER_NAME:/etc/broadpeak/hpc/$CONF_FILE" "$CONF_PATH"

  echo ">> Stopping initial container..."
  docker stop $CONTAINER_NAME

  generate_compose

  echo "✅ Initialization complete. Config stored in $CONF_PATH"
}

start() {
  if use_compose_mode; then
    compose_start
    return
  fi

  ensure_conf_dir

  if [ ! -f "$CONF_PATH" ]; then
    echo "❌ Missing config. Run '$0 init' first."
    exit 1
  fi

  echo ">> Starting Stitcher with persisted config..."

  local run_output
  if ! run_output=$(docker run -d -t $DOCKER_COMMON $PORTS \
    -v "$(pwd)/$CONF_PATH:/etc/broadpeak/hpc/$CONF_FILE" \
    --name $CONTAINER_NAME $IMAGE 2>&1); then
    if echo "$run_output" | grep -q "is already in use by container"; then
      echo ">> Existing container name conflict detected, removing old container..."
      docker rm -f $CONTAINER_NAME >/dev/null 2>&1 || true
      echo ">> Retrying Stitcher start..."
      docker run -d -t $DOCKER_COMMON $PORTS \
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
  if use_compose_mode; then
    compose_stop
    return
  fi

  echo ">> Stopping Stitcher..."
  docker stop $CONTAINER_NAME || true
  echo "✅ Stitcher stopped."
}

restart() {
  stop
  start
}

reload() {
  if use_compose_mode; then
    compose_reload
    return
  fi

  echo ">> Reload configuration..."
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "❌ Cannot reload: Stitcher container is not running."
    exit 1
  fi

  docker exec $CONTAINER_NAME sh -c 'systemctl restart stitcher-hpc'
  echo "✅ Configuration reloaded."
}

status() {
  if use_compose_mode; then
    local compose
    compose="$(compose_cmd)"
    $compose ps stitcher || true
  else
    docker ps -a | grep $CONTAINER_NAME || echo "Stitcher not found."
  fi
}

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

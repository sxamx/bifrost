#!/usr/bin/env bash
# ==============================================================================
# Bifrost Egress Node Agent — One-Command Linux Installer (HU-11, HU-11b)
# ==============================================================================
set -euo pipefail

NODE_USER="${NODE_USER:-bifrost-node}"
NODE_GROUP="${NODE_GROUP:-bifrost-node}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bifrost-node}"
DATA_DIR="${DATA_DIR:-/var/lib/bifrost-node}"
ENV_FILE="/etc/default/bifrost-node"
SERVICE_NAME="bifrost-node.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}"

MODE="tailscale"
PORT="9443"
TOKEN="${BIFROST_NODE_TOKEN:-}"
TLS_CERT=""
TLS_KEY=""

usage() {
  cat <<'EOF'
Bifrost Egress Node Installer

Usage:
  bash install-node.sh --token <node_token> [--mode tailscale|public_ip] [--port 9443] [--tls-cert <path> --tls-key <path>]

Options:
  --token <token>               Initial 32-byte node token from Bifrost Admin Panel
  --mode <tailscale|public_ip>  Listener mode (default: tailscale)
  --port <port>                 Listening port (default: 9443)
  --tls-cert <path>             Custom TLS certificate PEM path (public_ip mode)
  --tls-key <path>              Custom TLS private key PEM path (public_ip mode)
  --help, -h                    Show this help message
EOF
}

log() {
  printf '\033[1;34m[bifrost-node]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[bifrost-node][WARN]\033[0m %s\n' "$*" >&2
}

err() {
  printf '\033[1;31m[bifrost-node][ERROR]\033[0m %s\n' "$*" >&2
}

ORIG_ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --token=*)
      TOKEN="${1#*=}"
      shift
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
      shift
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    --tls-cert)
      TLS_CERT="${2:-}"
      shift 2
      ;;
    --tls-cert=*)
      TLS_CERT="${1#*=}"
      shift
      ;;
    --tls-key)
      TLS_KEY="${2:-}"
      shift 2
      ;;
    --tls-key=*)
      TLS_KEY="${1#*=}"
      shift
      ;;
    --endpoint)
      shift 2
      ;;
    --endpoint=*)
      shift
      ;;
    *)
      err "Argumento no reconocido: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "${MODE}" != "tailscale" && "${MODE}" != "public_ip" ]]; then
  err "Modo inválido '${MODE}'. Valores permitidos: tailscale | public_ip."
  exit 1
fi

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || [[ "${PORT}" -lt 1 || "${PORT}" -gt 65535 ]]; then
  err "Puerto inválido '${PORT}'. Debe estar entre 1 y 65535."
  exit 1
fi

if [[ -n "${TLS_CERT}" || -n "${TLS_KEY}" ]]; then
  if [[ -z "${TLS_CERT}" || -z "${TLS_KEY}" ]]; then
    err "Debes proporcionar --tls-cert y --tls-key juntos."
    exit 1
  fi
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  err "Este instalador requiere Linux (detectado: $(uname -s))."
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Elevando privilegios con sudo..."
    exec sudo -E bash "$0" "${ORIG_ARGS[@]}"
  fi
  err "Ejecuta este instalador como root (ej. sudo bash install-node.sh ...)."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
  err "Se requiere systemd activo para registrar ${SERVICE_NAME}."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  err "Node.js (>= 22 LTS) y npm son obligatorios."
  exit 1
fi

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 22 ]]; then
  err "Se requiere Node.js >= 22 LTS (detectado: v${NODE_VERSION})."
  exit 1
fi
NODE_BIN="$(command -v node)"

STATE_FILE="${DATA_DIR}/token-state.json"
if [[ -z "${TOKEN}" && ! -f "${STATE_FILE}" ]]; then
  err "Falta --token <node_token> para la instalación inicial del nodo."
  usage
  exit 1
fi

if [[ "${MODE}" == "tailscale" ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    warn "No se encontró el binario 'tailscale'. Verifica que Tailscale esté activo o usa --mode=public_ip."
  fi
else
  warn "Modo public_ip seleccionado: el puerto ${PORT} escuchará sobre TLS fuera de Tailscale. Restringe el acceso por firewall a la IP de Bifrost."
  if [[ -z "${TLS_CERT}" ]] && ! command -v openssl >/dev/null 2>&1; then
    err "Se requiere 'openssl' para autogenerar el certificado TLS en modo public_ip."
    exit 1
  fi
fi

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if ! getent group "${NODE_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${NODE_GROUP}"
fi

if ! id -u "${NODE_USER}" >/dev/null 2>&1; then
  NOLOGIN_SHELL="/usr/sbin/nologin"
  [[ -x "${NOLOGIN_SHELL}" ]] || NOLOGIN_SHELL="/bin/false"
  useradd --system \
    --gid "${NODE_GROUP}" \
    --home-dir "${DATA_DIR}" \
    --no-create-home \
    --shell "${NOLOGIN_SHELL}" \
    "${NODE_USER}"
fi

mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
chmod 0755 "${INSTALL_DIR}"
chmod 0700 "${DATA_DIR}"
chown "${NODE_USER}:${NODE_GROUP}" "${DATA_DIR}"

# Store only SHA-256 digest in token-state.json (0600) so raw token never leaks via ps/env
if [[ -n "${TOKEN}" ]]; then
  BIFROST_INIT_TOKEN="${TOKEN}" node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const hash = crypto.createHash("sha256").update(process.env.BIFROST_INIT_TOKEN.trim(), "utf8").digest("hex");
    fs.writeFileSync(process.argv[1], JSON.stringify({ activeTokenHashHex: hash, updatedAt: Math.floor(Date.now() / 1000) }, null, 2) + "\n", { mode: 0o600 });
  ' "${STATE_FILE}"
  chmod 0600 "${STATE_FILE}"
  chown "${NODE_USER}:${NODE_GROUP}" "${STATE_FILE}"
fi

if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" && -d "${SCRIPT_DIR}/src" ]]; then
  REAL_SRC="$(cd "${SCRIPT_DIR}" && pwd -P)"
  REAL_DST="$(cd "${INSTALL_DIR}" && pwd -P)"
  if [[ "${REAL_SRC}" != "${REAL_DST}" ]]; then
    tar -C "${SCRIPT_DIR}" \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='dist' \
      -cf - . | tar -C "${INSTALL_DIR}" -xf -
  fi
else
  ARCHIVE_URL="${BIFROST_REPO_ARCHIVE:-https://github.com/sxamx/bifrost/archive/refs/heads/main.tar.gz}"
  log "Descargando código del agente desde ${ARCHIVE_URL}..."
  TMP_EXTRACT="$(mktemp -d)"
  trap 'rm -rf "${TMP_EXTRACT}"' EXIT
  curl -fsSL "${ARCHIVE_URL}" | tar -xz -C "${TMP_EXTRACT}" --strip-components=1
  if [[ ! -f "${TMP_EXTRACT}/nodes/package.json" ]]; then
    err "El paquete descargado no contiene la carpeta nodes/."
    exit 1
  fi
  tar -C "${TMP_EXTRACT}/nodes" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    -cf - . | tar -C "${INSTALL_DIR}" -xf -
fi

log "Instalando dependencias y compilando agente en ${INSTALL_DIR}..."
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  npm --prefix "${INSTALL_DIR}" ci
else
  npm --prefix "${INSTALL_DIR}" install
fi
npm --prefix "${INSTALL_DIR}" run build
npm --prefix "${INSTALL_DIR}" prune --omit=dev
chown -R "${NODE_USER}:${NODE_GROUP}" "${INSTALL_DIR}"

# Pre-generate self-signed TLS cert in public_ip mode if none supplied so fingerprint can be printed
if [[ "${MODE}" == "public_ip" && -z "${TLS_CERT}" ]]; then
  CERT_OUT="${DATA_DIR}/node-tls.crt"
  KEY_OUT="${DATA_DIR}/node-tls.key"
  if [[ ! -f "${CERT_OUT}" || ! -f "${KEY_OUT}" ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -nodes -days 3650 -subj "/CN=bifrost-egress-node" \
      -keyout "${KEY_OUT}" -out "${CERT_OUT}" 2>/dev/null
    chmod 0600 "${KEY_OUT}"
    chmod 0644 "${CERT_OUT}"
    chown "${NODE_USER}:${NODE_GROUP}" "${KEY_OUT}" "${CERT_OUT}"
  fi
fi

(
  umask 0077
  {
    echo "BIFROST_NODE_MODE=${MODE}"
    echo "BIFROST_NODE_PORT=${PORT}"
    echo "BIFROST_NODE_DATA_DIR=${DATA_DIR}"
    if [[ -n "${TLS_CERT}" ]]; then
      echo "BIFROST_NODE_TLS_CERT=${TLS_CERT}"
      echo "BIFROST_NODE_TLS_KEY=${TLS_KEY}"
    fi
  } > "${ENV_FILE}"
)
chmod 0600 "${ENV_FILE}"

install -m 0644 "${INSTALL_DIR}/${SERVICE_NAME}" "${SERVICE_DEST}"
if [[ "${NODE_BIN}" != "/usr/bin/node" && "${NODE_BIN}" != "/usr/local/bin/node" ]]; then
  sed -i "s|^ExecStart=.*|ExecStart=${NODE_BIN} ${INSTALL_DIR}/dist/index.js|" "${SERVICE_DEST}"
fi

systemctl daemon-reload
systemctl enable bifrost-node
systemctl restart bifrost-node

log "Servicio bifrost-node activo en modo '${MODE}' (puerto ${PORT})."
if [[ "${MODE}" == "public_ip" ]]; then
  CERT_CHECK="${TLS_CERT:-${DATA_DIR}/node-tls.crt}"
  if [[ -f "${CERT_CHECK}" ]]; then
    FP="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");console.log(new crypto.X509Certificate(fs.readFileSync(process.argv[1],"utf8")).fingerprint256);' "${CERT_CHECK}")"
    log "TLS SHA-256 Fingerprint: ${FP}"
  fi
fi

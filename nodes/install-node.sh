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
  BIFROST_NODE_TOKEN=<node_token> sudo -E bash install-node.sh [--mode tailscale|public_ip] [--port 9443]

Options:
  --token <token>               Initial 32-byte node token from Bifrost Admin Panel (or env BIFROST_NODE_TOKEN)
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

validate_safe_path() {
  local label="$1"
  local value="$2"
  local allow_empty="${3:-false}"
  if [[ -z "${value}" ]]; then
    if [[ "${allow_empty}" == "true" ]]; then
      return 0
    fi
    err "${label} no puede estar vacío."
    exit 1
  fi
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* || "${value}" == *'|'* ]]; then
    err "Ruta inválida en ${label}: no se permiten saltos de línea ni el carácter '|'."
    exit 1
  fi
  if [[ "${value}" == "/" ]]; then
    err "Ruta inválida en ${label}: no puede ser '/'."
    exit 1
  fi
}

validate_safe_identifier() {
  local label="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    err "Identificador inválido en ${label}: '${value}'."
    exit 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
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

validate_safe_identifier "NODE_USER" "${NODE_USER}"
validate_safe_identifier "NODE_GROUP" "${NODE_GROUP}"
validate_safe_path "INSTALL_DIR" "${INSTALL_DIR}" "false"
validate_safe_path "DATA_DIR" "${DATA_DIR}" "false"
validate_safe_path "TLS_CERT" "${TLS_CERT}" "true"
validate_safe_path "TLS_KEY" "${TLS_KEY}" "true"

if [[ "$(uname -s)" != "Linux" ]]; then
  err "Este instalador requiere Linux (detectado: $(uname -s))."
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if [[ ! -f "$0" ]]; then
    err "Este instalador debe ejecutarse como root cuando se invoca por pipe."
    err "Usa: curl -fsSL <URL>/install-node.sh | BIFROST_NODE_TOKEN='<token>' sudo -E bash -s -- --mode ${MODE} --port ${PORT}"
    exit 1
  fi
  if command -v sudo >/dev/null 2>&1; then
    log "Elevando privilegios con sudo..."
    exec sudo -E bash "$0" "${ORIG_ARGS[@]}"
  fi
  err "Ejecuta este instalador como root (ej. sudo bash install-node.sh ...)."
  exit 1
fi

# Scrub raw token from process environment once running as root so child processes do not inherit it
unset BIFROST_NODE_TOKEN || true

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
validate_safe_path "NODE_BIN" "${NODE_BIN}" "false"
NODE_BIN_REAL="$(readlink -f "${NODE_BIN}" 2>/dev/null || printf '%s' "${NODE_BIN}")"
if [[ "${NODE_BIN}" == /root/* || "${NODE_BIN}" == /home/* || "${NODE_BIN_REAL}" == /root/* || "${NODE_BIN_REAL}" == /home/* ]]; then
  err "El binario de Node.js reside en '${NODE_BIN_REAL}' (bajo /root o /home), lo cual falla con systemd ProtectHome=true."
  err "Instala Node.js a nivel de sistema (ej. /usr/bin/node o /usr/local/bin/node) y vuelve a ejecutar el instalador."
  exit 1
fi

STATE_FILE="${DATA_DIR}/token-state.json"
if [[ -z "${TOKEN}" && ! -f "${STATE_FILE}" ]]; then
  err "Falta --token <node_token> o variable de entorno BIFROST_NODE_TOKEN para la instalación inicial del nodo."
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

# Store only SHA-256 digest in token-state.json (0600) via stdin so raw token never leaks via ps/environ
if [[ -n "${TOKEN}" ]]; then
  printf '%s' "${TOKEN}" | node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const token = fs.readFileSync(0, "utf8").trim();
    if (!token) {
      process.exit(1);
    }
    const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const target = process.argv[1];
    const tmp = `${target}.tmp.${process.pid}`;
    const payload = JSON.stringify(
      {
        activeTokenHashHex: hash,
        prevTokenHashHex: null,
        prevTokenExpiresAtMs: null,
        updatedAt: Math.floor(Date.now() / 1000)
      },
      null,
      2
    ) + "\n";
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  ' "${STATE_FILE}"
  chmod 0600 "${STATE_FILE}"
  chown "${NODE_USER}:${NODE_GROUP}" "${STATE_FILE}"
fi

BIFROST_REPO_URL="${BIFROST_REPO_URL:-https://github.com/sxamx/bifrost.git}"
NODE_SUBDIR="${INSTALL_DIR}"
SERVICE_SOURCE=""

if command -v git >/dev/null 2>&1; then
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Actualizando repositorio del agente en ${INSTALL_DIR}..."
    git -C "${INSTALL_DIR}" fetch --depth 1 origin main
    git -C "${INSTALL_DIR}" reset --hard origin/main
  else
    log "Clonando repositorio del agente en ${INSTALL_DIR} (habilita auto-update)..."
    rm -rf "${INSTALL_DIR:?}"/* "${INSTALL_DIR:?}"/.[!.]* 2>/dev/null || true
    git clone --depth 1 "${BIFROST_REPO_URL}" "${INSTALL_DIR}"
  fi
  NODE_SUBDIR="${INSTALL_DIR}/nodes"
  SERVICE_SOURCE="${NODE_SUBDIR}/${SERVICE_NAME}"
elif [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" && -d "${SCRIPT_DIR}/src" ]]; then
  REAL_SRC="$(cd "${SCRIPT_DIR}" && pwd -P)"
  REAL_DST="$(cd "${INSTALL_DIR}" && pwd -P)"
  if [[ "${REAL_SRC}" != "${REAL_DST}" ]]; then
    tar -C "${SCRIPT_DIR}" \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='dist' \
      -cf - . | tar -C "${INSTALL_DIR}" -xf -
  fi
  SERVICE_SOURCE="${INSTALL_DIR}/${SERVICE_NAME}"
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
  SERVICE_SOURCE="${INSTALL_DIR}/${SERVICE_NAME}"
fi

log "Instalando dependencias y compilando agente en ${NODE_SUBDIR}..."
if [[ -f "${NODE_SUBDIR}/package-lock.json" ]]; then
  npm --prefix "${NODE_SUBDIR}" ci --include=dev --ignore-scripts
else
  npm --prefix "${NODE_SUBDIR}" install --include=dev --ignore-scripts
fi
npm --prefix "${NODE_SUBDIR}" run build
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
    echo "NPM_CONFIG_CACHE=${DATA_DIR}/.npm"
    if [[ -d "${INSTALL_DIR}/.git" ]]; then
      echo "BIFROST_NODE_REPO_DIR=${INSTALL_DIR}"
    fi
    if [[ -n "${TLS_CERT}" ]]; then
      echo "BIFROST_NODE_TLS_CERT=${TLS_CERT}"
      echo "BIFROST_NODE_TLS_KEY=${TLS_KEY}"
    fi
  } > "${ENV_FILE}"
)
chmod 0600 "${ENV_FILE}"

install -m 0644 "${SERVICE_SOURCE}" "${SERVICE_DEST}"

ESC_NODE_USER="$(escape_sed_replacement "${NODE_USER}")"
ESC_NODE_GROUP="$(escape_sed_replacement "${NODE_GROUP}")"
ESC_INSTALL_DIR="$(escape_sed_replacement "${INSTALL_DIR}")"
ESC_NODE_SUBDIR="$(escape_sed_replacement "${NODE_SUBDIR}")"
ESC_DATA_DIR="$(escape_sed_replacement "${DATA_DIR}")"
ESC_EXEC_START="$(escape_sed_replacement "${NODE_BIN} ${NODE_SUBDIR}/dist/index.js")"

sed -i \
  -e "s|^User=.*|User=${ESC_NODE_USER}|" \
  -e "s|^Group=.*|Group=${ESC_NODE_GROUP}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${ESC_NODE_SUBDIR}|" \
  -e "s|^Environment=BIFROST_NODE_DATA_DIR=.*|Environment=BIFROST_NODE_DATA_DIR=${ESC_DATA_DIR}|" \
  -e "s|^Environment=BIFROST_NODE_REPO_DIR=.*|Environment=BIFROST_NODE_REPO_DIR=${ESC_INSTALL_DIR}|" \
  -e "s|^Environment=NPM_CONFIG_CACHE=.*|Environment=NPM_CONFIG_CACHE=${ESC_DATA_DIR}/.npm|" \
  -e "s|^ExecStart=.*|ExecStart=${ESC_EXEC_START}|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${ESC_DATA_DIR} ${ESC_INSTALL_DIR}|" \
  "${SERVICE_DEST}"

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

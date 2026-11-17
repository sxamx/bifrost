#!/usr/bin/env bash
# ==============================================================================
# Bifrost — Native Linux + systemd Installer (HU-01, HU-26)
# ==============================================================================
set -euo pipefail

BIFROST_USER="${BIFROST_USER:-bifrost}"
BIFROST_GROUP="${BIFROST_GROUP:-bifrost}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bifrost}"
DATA_DIR="${DATA_DIR:-/var/lib/bifrost}"
PORT="${PORT:-8080}"
SERVICE_NAME="bifrost.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '\033[1;34m[bifrost]\033[0m %s\n' "$*"
}

err() {
  printf '\033[1;31m[bifrost][error]\033[0m %s\n' "$*" >&2
}

# 1. Verify Linux + systemd + root privileges
if [[ "$(uname -s)" != "Linux" ]]; then
  err "Este instalador solo soporta sistemas Linux (detectado: $(uname -s))."
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Elevando privilegios con sudo..."
    exec sudo -E bash "$0" "$@"
  fi
  err "Ejecuta este instalador como root (ej. sudo bash scripts/install.sh)."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
  err "Se requiere systemd activo para instalar Bifrost como servicio del sistema."
  exit 1
fi

# 2. Verify Node.js >= 22 and npm
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  err "Node.js (>= 22 LTS) y npm son obligatorios y no se encontraron en PATH."
  exit 1
fi

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 22 ]]; then
  err "Se requiere Node.js >= 22 LTS (detectado: v${NODE_VERSION})."
  exit 1
fi
NODE_BIN="$(command -v node)"
log "Entorno verificado: Linux + systemd + Node.js v${NODE_VERSION} (${NODE_BIN})"

# 3. Create system user/group bifrost and directories (/opt/bifrost, /var/lib/bifrost)
if ! getent group "${BIFROST_GROUP}" >/dev/null 2>&1; then
  log "Creando grupo de sistema '${BIFROST_GROUP}'..."
  groupadd --system "${BIFROST_GROUP}"
fi

if ! id -u "${BIFROST_USER}" >/dev/null 2>&1; then
  NOLOGIN_SHELL="/usr/sbin/nologin"
  if [[ ! -x "${NOLOGIN_SHELL}" ]]; then
    NOLOGIN_SHELL="/bin/false"
  fi
  log "Creando usuario de sistema '${BIFROST_USER}'..."
  useradd --system \
    --gid "${BIFROST_GROUP}" \
    --home-dir "${DATA_DIR}" \
    --no-create-home \
    --shell "${NOLOGIN_SHELL}" \
    "${BIFROST_USER}"
fi

log "Preparando directorios '${INSTALL_DIR}' y '${DATA_DIR}' (0700)..."
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
chmod 0755 "${INSTALL_DIR}"
chmod 0700 "${DATA_DIR}"
chown "${BIFROST_USER}:${BIFROST_GROUP}" "${DATA_DIR}"

# 4. Provision /var/lib/bifrost/master.key (32 random bytes, 0600, never overwrite!)
MASTER_KEY_PATH="${DATA_DIR}/master.key"
DB_PATH="${DATA_DIR}/bifrost.db"

if [[ -f "${MASTER_KEY_PATH}" ]]; then
  KEY_BYTES="$(wc -c < "${MASTER_KEY_PATH}" | tr -d '[:space:]')"
  if [[ "${KEY_BYTES}" -ne 32 ]]; then
    err "La llave existente en ${MASTER_KEY_PATH} es inválida (${KEY_BYTES} bytes; se esperan 32 bytes). Abortando sin sobrescribir."
    exit 1
  fi
  chmod 0600 "${MASTER_KEY_PATH}"
  chown "${BIFROST_USER}:${BIFROST_GROUP}" "${MASTER_KEY_PATH}"
  log "Llave maestra existente conservada en ${MASTER_KEY_PATH} (32 bytes, 0600)."
elif [[ -f "${DB_PATH}" ]]; then
  err "Existe base de datos en ${DB_PATH} pero falta ${MASTER_KEY_PATH}. Por seguridad (HU-26) no se genera una llave nueva automáticamente."
  exit 1
else
  log "Generando nueva llave maestra de 32 bytes en ${MASTER_KEY_PATH}..."
  (
    umask 0077
    head -c 32 /dev/urandom > "${MASTER_KEY_PATH}"
  )
  chmod 0600 "${MASTER_KEY_PATH}"
  chown "${BIFROST_USER}:${BIFROST_GROUP}" "${MASTER_KEY_PATH}"
fi

# 5. Sync application files to /opt/bifrost and compile panel + core
REAL_REPO="$(cd "${REPO_ROOT}" && pwd -P)"
REAL_INSTALL="$(cd "${INSTALL_DIR}" && pwd -P)"

if [[ "${REAL_REPO}" != "${REAL_INSTALL}" ]]; then
  log "Copiando código fuente de Bifrost en ${INSTALL_DIR}..."
  tar -C "${REPO_ROOT}" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='data' \
    --exclude='*.db*' \
    --exclude='*.sqlite*' \
    --exclude='*.key' \
    --exclude='*.enc' \
    -cf - package.json schemas core panel scripts \
    | tar -C "${INSTALL_DIR}" -xf -
fi

log "Instalando dependencias y compilando panel (${INSTALL_DIR}/panel)..."
if [[ -f "${INSTALL_DIR}/panel/package-lock.json" ]]; then
  npm --prefix "${INSTALL_DIR}/panel" ci
else
  npm --prefix "${INSTALL_DIR}/panel" install
fi
npm --prefix "${INSTALL_DIR}/panel" run build
rm -rf "${INSTALL_DIR}/panel/node_modules"

log "Instalando dependencias y compilando núcleo (${INSTALL_DIR}/core)..."
if [[ -f "${INSTALL_DIR}/core/package-lock.json" ]]; then
  npm --prefix "${INSTALL_DIR}/core" ci
else
  npm --prefix "${INSTALL_DIR}/core" install
fi
npm --prefix "${INSTALL_DIR}/core" run build
npm --prefix "${INSTALL_DIR}/core" prune --omit=dev

chown -R "${BIFROST_USER}:${BIFROST_GROUP}" "${INSTALL_DIR}"

# 6. Install and enable systemd unit
log "Instalando servicio systemd en ${SERVICE_DEST}..."
install -m 0644 "${INSTALL_DIR}/scripts/${SERVICE_NAME}" "${SERVICE_DEST}"

# Ensure custom Node binary locations outside standard systemd PATH still work cleanly
if [[ "${NODE_BIN}" != "/usr/bin/node" && "${NODE_BIN}" != "/usr/local/bin/node" ]]; then
  sed -i "s|^ExecStart=.*|ExecStart=${NODE_BIN} ${INSTALL_DIR}/core/dist/index.js|" "${SERVICE_DEST}"
fi

systemctl daemon-reload
systemctl enable --now bifrost

log "Bifrost instalado y ejecutándose correctamente."
log "Panel y API disponibles en: http://localhost:${PORT}"

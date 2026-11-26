#!/usr/bin/env bash
# ==============================================================================
# Bifrost — Docker Runtime Entrypoint
# Ensures DATA_DIR is writable by UID 1000 (node), enforces strict permissions,
# and initializes master.key ONLY on a brand-new empty data directory.
# ==============================================================================
set -euo pipefail

DATA_PATH="${DATA_DIR:-/data}"
MASTER_KEY_FILE="${DATA_PATH}/master.key"
DB_FILE="${DATA_PATH}/bifrost.db"

if ! mkdir -p "${DATA_PATH}" 2>/dev/null; then
  printf '[bifrost][error] No se pudo crear el directorio de datos "%s" como usuario %s (UID %s:%s).\n' \
    "${DATA_PATH}" "$(id -un 2>/dev/null || echo node)" "$(id -u)" "$(id -g)" >&2
  printf '[bifrost][error] Ajusta los permisos del volumen montado (por ejemplo: chown -R 1000:1000 <directorio-datos>).\n' >&2
  exit 1
fi

if [[ ! -d "${DATA_PATH}" || ! -w "${DATA_PATH}" ]]; then
  printf '[bifrost][error] El directorio de datos "%s" no tiene permisos de escritura para UID %s:%s (USER node).\n' \
    "${DATA_PATH}" "$(id -u)" "$(id -g)" >&2
  printf '[bifrost][error] Verifica el propietario del volumen o bind mount (por ejemplo: chown -R 1000:1000 <directorio-datos>).\n' >&2
  exit 1
fi

chmod 0700 "${DATA_PATH}" 2>/dev/null || true

# Generate a 32-byte master.key ONLY on a brand-new empty volume;
# never overwrite or regenerate if bifrost.db already exists.
if [[ -z "${BIFROST_MASTER_KEY:-}" ]] \
  && [[ ! -e "${MASTER_KEY_FILE}" ]] \
  && [[ ! -e "${DB_FILE}" ]] \
  && [[ ! -e "${DB_FILE}-wal" ]] \
  && [[ ! -e "${DB_FILE}-shm" ]]; then
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const dir = process.argv[1];
    const keyFile = dir + "/master.key";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
    fs.chmodSync(keyFile, 0o600);
  ' "${DATA_PATH}"
elif [[ -f "${MASTER_KEY_FILE}" ]]; then
  chmod 0600 "${MASTER_KEY_FILE}" 2>/dev/null || true
fi

if [[ "$#" -gt 0 ]]; then
  exec "$@"
fi

exec node dist/index.js

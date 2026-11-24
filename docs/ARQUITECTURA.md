# Arquitectura técnica de Bifrost

Este documento define la arquitectura, el esquema de base de datos, la criptografía, los contratos de API y el modelo de despliegue de **Bifrost**. Es la referencia técnica obligatoria para implementar cualquier historia de `docs/HISTORIAS.md`.

---

## 1. Stack y estructura del proceso

- **Lenguaje:** TypeScript (ESM, Node.js ≥ 22 LTS).
- **Núcleo (`core/`):** servidor HTTP **Hono** sobre Node.js.
  - Expone la API compatible con OpenAI (`/v1/*`).
  - Expone la API interna del panel (`/api/*`).
  - Sirve los archivos estáticos compilados de `panel/dist/` (un único proceso y puerto, por defecto `8080`).
- **Panel (`panel/`):** React + Vite + TypeScript. Nunca guarda claves ni consulta proveedores directamente; todo pasa por `core/`.
- **Base de datos:** **SQLite** (archivo único `data/bifrost.db`, modo `WAL` habilitado).
- **Nodos de salida (`nodes/`):** agente ligero independiente que se ejecuta en VMs remotas y actúa como túnel TCP `HTTP CONNECT` (ver `docs/PROTOCOLO-NODOS.md`).

---

## 2. Instalación, arranque y llave maestra (HU-01, HU-26)

### Métodos oficiales de instalación
1. **Docker Compose (principal):**
   - `docker-compose.yml` levanta el contenedor único de `bifrost` montando el volumen persistente `/data` (contiene `bifrost.db` y `master.key`) y política `restart: unless-stopped`.
2. **Script nativo en Linux (`install.sh` + `systemd`):**
   - Instala dependencias, compila `core/` y `panel/`, crea el usuario de sistema `bifrost` y registra la unidad `bifrost.service` con `Restart=always` para autoarranque tras reinicio.

### Llave maestra del servidor (`master.key`)
- En la primera instalación se genera automáticamente una clave aleatoria de 32 bytes (256 bits) guardada en `data/master.key` (o pasada por variable de entorno `BIFROST_MASTER_KEY`) con permisos estrictos `0600`.
- **Regla de arranque (HU-26):** al iniciar, `core/` valida que `master.key` exista y tenga exactamente 32 bytes. Si falta o es inválida, **el servidor aborta el arranque** con un mensaje claro en stderr/log y código de salida distinto de `0`. Nunca genera una llave nueva silenciosamente si ya existe `bifrost.db`.

---

## 3. Criptografía y seguridad

| Dato | Mecanismo | Detalle |
|---|---|---|
| Contraseñas de usuario | `crypto.scrypt` | Salt aleatorio de 16 bytes por usuario, `N=16384, r=8, p=1`. |
| Sesiones del panel | Cookie `HttpOnly`, `SameSite=Lax` | Token opaco de 32 bytes almacenado como hash `SHA-256` en SQLite. |
| API keys internas (`sk-bf-...`) | Prefijo + `SHA-256` | Se genera `sk-bf-` + 32 bytes aleatorios en base64url. En BD solo se guarda `key_prefix` (primeros 12 chars) y `key_hash` (`SHA-256`). La clave completa solo se muestra una vez al crearla. |
| Claves/cuentas de proveedores | `AES-256-GCM` | Cifradas con `master.key`. Se guarda `iv` (12 bytes), `auth_tag` (16 bytes) y `ciphertext`. En UI solo se muestran los últimos 4 caracteres (`last4`). |
| Tokens de nodos | `SHA-256` + rotación | Token de 32 bytes; se guarda su hash. Durante la rotación coexisten `token_hash` y `prev_token_hash` por 5 minutos. |
| Respaldos exportados (`.bifrost.enc`) | `scrypt` + `gzip` + `AES-256-GCM` | Cabecera mágica `BIFROST1` + `salt` (16 B) + `iv` (12 B) + `auth_tag` (16 B) + payload JSON comprimido con `gzip` y cifrado con clave derivada de la contraseña del admin. |

### Control anti-manipulación de cuotas
- Todas las marcas de tiempo se calculan exclusivamente con el reloj del servidor en **UTC** (`Date.now()` / `unixepoch()`). Los encabezados o fechas enviadas por el cliente se ignoran por completo.

---

## 4. Esquema de base de datos (SQLite)

Todas las tablas usan `INTEGER` para timestamps Unix en segundos (UTC) y `TEXT` para UUIDs/JSON.

```sql
-- Usuarios e invitaciones
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
  daily_token_limit INTEGER,          -- NULL = ilimitado (admin)
  quota_reset_mode TEXT NOT NULL DEFAULT 'utc_midnight' CHECK (quota_reset_mode IN ('utc_midnight', 'rolling_24h')),
  created_at INTEGER NOT NULL
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  daily_token_limit INTEGER NOT NULL,
  allowed_models_json TEXT NOT NULL,  -- Array de IDs "provider/model" o ["*"]
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE user_model_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_full_id TEXT NOT NULL,        -- ej. "openrouter/deepseek-v3:free"
  PRIMARY KEY (user_id, model_full_id)
);

CREATE TABLE internal_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Nodos de salida
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tailscale', 'public_ip')),
  endpoint TEXT NOT NULL,             -- IP:puerto o host:puerto
  token_hash TEXT NOT NULL,
  prev_token_hash TEXT,
  prev_token_expires_at INTEGER,
  last_seen_at INTEGER,
  last_rotated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'unresponsive', 'offline')),
  created_at INTEGER NOT NULL
);

-- Proveedores instalados (desde marketplace o ficha local) y sus cuentas/claves
CREATE TABLE providers (
  id TEXT PRIMARY KEY,                -- slug del proveedor, ej. "openrouter"
  name TEXT NOT NULL,
  package_type TEXT NOT NULL CHECK (package_type IN ('official-json', 'experimental-adapter')),
  models_source TEXT NOT NULL CHECK (models_source IN ('api', 'static')),
  schema_json TEXT NOT NULL,          -- Ficha completa validada contra schemas/provider.schema.json
  adapter_url TEXT,                   -- Solo si package_type = 'experimental-adapter' (ej. http://127.0.0.1:3100)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_models_sync_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE provider_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  encrypted_secret BLOB NOT NULL,     -- iv(12) + tag(16) + ciphertext
  last4 TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  forced_node INTEGER NOT NULL DEFAULT 0,
  daily_quota_limit INTEGER,          -- Tope estimado diario configurable para HU-17
  ratelimit_remaining INTEGER,        -- Último valor leído de x-ratelimit-remaining
  ratelimit_reset_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rate_limited', 'error', 'no_node')),
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- Catálogo de modelos detectados
CREATE TABLE models (
  full_id TEXT PRIMARY KEY,           -- "provider_id/model_id"
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  canonical_model_id TEXT,            -- Cruce con models.dev
  name TEXT NOT NULL,
  context_length INTEGER,
  max_output INTEGER,
  modalities_json TEXT NOT NULL,      -- {"input":[...],"output":[...]}
  capabilities_json TEXT NOT NULL,    -- {"tools":bool,"reasoning":bool,"structured_output":bool}
  is_free INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  upstream_created_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

-- Telemetría, uso, uptime y logs
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL,
  provider_key_id TEXT,
  model_full_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,                    -- Time To First Token
  duration_ms INTEGER NOT NULL,
  tokens_per_sec REAL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'resumed')),
  error_type TEXT,                    -- 'rate_limit' | 'network' | 'tool_error' | 'structured_error' | 'upstream'
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_usage_created ON usage_logs(created_at);
CREATE INDEX idx_usage_user_created ON usage_logs(user_id, created_at);

CREATE TABLE system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  category TEXT NOT NULL CHECK (category IN ('failover', 'stream_resume', 'node', 'sync', 'auth', 'backup', 'system')),
  message TEXT NOT NULL,              -- Nunca contiene secretos ni claves en texto plano
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_syslogs_created ON system_logs(created_at);

-- Caché de catálogos externos y benchmarks
CREATE TABLE external_cache (
  cache_key TEXT PRIMARY KEY,         -- ej. "models_dev:api", "lmarena:agent", "aw:bench"
  payload_json TEXT NOT NULL,
  etag TEXT,
  fetched_at INTEGER NOT NULL
);
```

---

## 5. Contratos de API (`core/`)

### A. API compatible con OpenAI (`/v1/*`)
Autenticación: `Authorization: Bearer sk-bf-...`
- `GET /v1/models`: devuelve solo los modelos activos permitidos al usuario dueño de la key.
- `POST /v1/chat/completions`: soporta `stream: true` (SSE) y `stream: false`.
  - Verifica cuota diaria del usuario en SQLite (UTC). Si excede, responde `429` con mensaje claro y `reset_at` en ISO-8601.
  - Selecciona una `provider_key` activa del proveedor (respetando su `node_id` asignado).
  - **Failover (HU-09):** ante `429`, `5xx` o error de red, marca temporalmente la clave, registra en `system_logs` y reintenta con otra clave disponible del mismo proveedor.
  - **Reanudación de streaming cortado:** si un stream SSE se interrumpe tras emitir tokens parciales (`content_accumulated`), `core/` intenta continuar con otra clave del mismo proveedor enviando un mensaje de continuación transparente con el contexto acumulado y registra el evento en `system_logs` (`category: 'stream_resume'`).

### B. API interna del Panel (`/api/*`)
Autenticación: cookie de sesión (`HttpOnly`). Endpoints marcados `[admin]` devuelven `403` si `role !== 'admin'`.
- `POST /api/setup` (solo si no existe admin), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- `GET/POST/DELETE /api/keys` (API keys internas `sk-bf-...` del usuario autenticado).
- `GET/POST/DELETE /api/users`, `POST /api/invitations` `[admin]`, `POST /api/invitations/:token/accept`.
- `GET /api/marketplace` (lee catálogo de `mazzapata/providers`), `POST /api/marketplace/install` `[admin]`.
- `GET/POST/DELETE /api/providers`, `POST /api/providers/:id/keys` `[admin]`, `POST /api/providers/:id/detect-models` `[admin]`, `POST /api/providers/:id/reload-models` `[admin]`.
- `GET/POST/DELETE /api/nodes` `[admin]`, `POST /api/nodes/:id/rotate` `[admin]`.
- `GET /api/models`, `GET /api/models/:fullId`, `GET /api/models/:fullId/benchmarks`.
- `GET /api/metrics/summary`, `GET /api/metrics/latency`, `GET /api/metrics/speed`, `GET /api/metrics/uptime`, `GET /api/metrics/activity`.
- `GET /api/logs` `[admin]` (paginado, filtros por `level`, `category`, búsqueda).
- `POST /api/playground/chat` (usa el pipeline `/v1/chat/completions` del usuario autenticado y devuelve `ttft_ms` y `tokens_per_sec`).
- `POST /api/backup/export` `[admin]` (devuelve binario `.bifrost.enc`), `POST /api/backup/import` `[admin]`.

---

## 6. Marketplace e integraciones (`mazzapata/providers`)

- **Instalación bajo demanda:** Bifrost arranca vacío. El panel muestra el catálogo remoto de `mazzapata/providers` y el admin instala solo lo que necesita.
- **Paquetes `official-json`:** contienen únicamente una ficha declarativa validada por `schemas/provider.schema.json`.
- **Paquetes `experimental-adapter`:** incluyen un manifiesto + proceso/contenedor adaptador aislado que expone un endpoint local compatible con OpenAI (`/v1/chat/completions`, `/v1/models`). Bifrost se comunica con él mediante la ficha del proveedor y gestiona igualmente múltiples cuentas/claves cifradas dentro de la integración instalada en el panel.
- **Sincronización automática (HU-16):** un job interno corre **cada 6 horas** y actualiza la lista de modelos **solo** en proveedores habilitados con `models_source = 'api'`.

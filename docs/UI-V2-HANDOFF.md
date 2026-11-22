# Guía de Handoff UI — Bifrost V2

Documento técnico para implementar los cambios de interfaz de la V2 en el panel (`panel/src/`).  
Refleja las historias `HU-27` a `HU-42` descritas en [`HISTORIAS-V2.md`](HISTORIAS-V2.md).

---

## 1. Alcance y archivos permitidos

### Componentes que SÍ debes actualizar (en `panel/src/components/`)
1. `ProviderVaultCard.tsx`
2. `NodesTab.tsx`
3. `ModelsTab.tsx`
4. `UsersTab.tsx`
5. `ApiKeysTab.tsx`
6. `MetricsTab.tsx`
7. `MarketplaceTab.tsx` *(o la vista de catálogo del Marketplace dentro de `ProvidersTab.tsx`)*
8. `OverviewTab.tsx` *(y barra superior / topbar en `App.tsx` si aplica)*

### Archivos que NO debes tocar
- `panel/src/api.ts` (el cliente HTTP y normalizadores se proveen desde backend/API)
- `panel/src/types.ts` (los tipos e interfaces se proveen desde backend/API)
- `core/`, `nodes/`, `tests/` (backend, agente de nodos y suite de pruebas)

### Reglas de diseño vigentes
- Mantener el estilo visual actual (modo claro, variables CSS existentes en `styles.css`, clase `mono` / `tabular-nums` para cifras y IDs).
- Prohibido usar `cursor: help` (`?`). Toda ayuda contextual debe usar el componente `InfoTip` (`ⓘ`) o cambio de tono visible al pasar el cursor.
- Toda acción destructiva o sensible debe mostrar confirmación clara o estado de carga y manejar `ApiError` mostrando mensajes legibles.

---

## 2. Contrato disponible por componente (`api.ts` y `types.ts`)

> Nota: Algunos campos ya existen en `types.ts`/`api.ts` (ej. `enforceStrictQuota`, `status: 'no_node'`, `active`, `setModelVisibility`) y las nuevas propiedades de `HU-37` / `HU-40` serán provistas en `api.ts` y `types.ts` por backend antes de compilar el panel V2.

### 2.1 `ProviderVaultCard.tsx` (`HU-27`, `HU-29`, `HU-40`)

**Propiedades en `ProviderKeyItem` (`types.ts`):**
- `status: ProviderKeyStatus` — `'active' | 'rate_limited' | 'error' | 'no_node' | 'disabled'` (las claves creadas desactivadas llegan con `status === 'disabled'`).
- `lastError?: string | null` — Último error reportado por el upstream o por una prueba manual.
- `nodeId: string | null` — Nodo asignado (si es `null` y `status === 'no_node'`, la clave está fuera de servicio).

**Propiedades en `ProviderSummary` (`types.ts`):**
- `privacy?: ProviderPrivacyConfig | null` — Metadatos de retención y entrenamiento del proveedor (`HU-40`, ver sección 2.7).

**Métodos en `api` (`api.ts`):**
- `api.toggleProviderKey(providerId: string, keyId: string, enabled: boolean): Promise<ProviderKeyItem>`  
  Conectar al interruptor **Activar / Desactivar** de cada clave (`enabled = k.status !== 'disabled'`).
- `api.testProviderKey(providerId: string, keyId: string): Promise<ProviderKeyTestResult>`  
  Donde `ProviderKeyTestResult` es `{ ok: boolean; httpStatus: number | null; latencyMs: number; message: string }`. Conectar al botón **Probar clave** (deshabilitar si `k.status === 'no_node'`).

**Requisitos UI:**
- Indicar visualmente cuando una clave recién creada está **Desactivada** (`k.status === 'disabled'`) y permitir activarla con el switch.
- Mostrar badge específico para `status === 'no_node'` («Sin nodo / Fuera de servicio») y deshabilitar **Probar clave** mientras no tenga nodo asignado.
- Mostrar el resultado inline de **Probar clave** (latencia `latencyMs` en `ms` si `ok: true`, o `message` / `httpStatus` si `ok: false`).
- **Privacidad/ZDR (`HU-40`):** si `provider.privacy` indica que el proveedor retiene prompts (`retention === 'retained'`) o permite entrenamiento (`training === 'allowed'` u `'opt_out'`, como NVIDIA NIM free-tier), mostrar un badge/tooltip (`InfoTip`) de advertencia visible en la tarjeta del proveedor.

---

### 2.2 `NodesTab.tsx` (`HU-27`, `HU-28`, `HU-41`)

**Propiedades en `ExitNodeItem` (`types.ts`):**
- `id: string`, `name: string`, `mode: NodeMode` (`'tailscale' | 'public_ip'`), `endpoint: string`, `status: NodeStatus` (`'online' | 'unresponsive' | 'offline'`), `assignedKeysCount?: number`, `commit?: string | null`, `updateAvailable?: boolean`.

**Métodos en `api` (`api.ts`):**
- `api.testNode(nodeId: string): Promise<ExitNodeTestResult>`  
  Donde `ExitNodeTestResult` es `{ ok: boolean; status: NodeStatus | string; latencyMs: number | null; error?: string }`. Conectar al botón **Probar nodo** en cada nodo.
- `api.updateNode(nodeId: string): Promise<{ ok: boolean; upToDate?: boolean; message: string; restarting: boolean }>`  
  Llama a `POST /api/nodes/:id/update` (que reenvía la orden a `POST /_bifrost/update` en el agente del nodo). Conectar al botón **Actualizar nodo** en cada nodo.
- `api.deleteNode(nodeId: string): Promise<{ ok: boolean }>` *(ya existente)*

**Requisitos UI:**
- Añadir botón **Probar nodo** con estado `testing` por fila/tarjeta y feedback inline (`En línea · X ms` o `error` descriptivo).
- Para **«Actualizar nodo»**, mostrar o habilitar la acción de actualización únicamente cuando `node.updateAvailable === true` (o mostrar un badge **«Al día»** cuando sea `false`), con estado de carga mientras se envía la orden; manejar `upToDate === true` de forma limpia sin esperar un reinicio, y mostrar feedback inline claro para el resto de estados (`restarting: true` o `message` del servidor, manejando errores con `ApiError`).
- En el flujo/confirmación de **Eliminar nodo**, advertir explícitamente si `assignedKeysCount > 0` que esas claves pasarán a estado `no_node` (fuera de servicio) hasta que se les asigne otro nodo.

---

### 2.3 `ModelsTab.tsx` (`HU-30`, `HU-40`)

**Propiedades en `ProviderModelItem` (`types.ts`):**
- `active?: boolean` — Estado global del modelo (`true` activo, `false` deshabilitado).
- `disabledByAdmin?: boolean` — Indica si fue deshabilitado explícitamente por un administrador.
- `hasCatalogInfo?: boolean` — `true` si el modelo tiene ficha de catálogo/precios de referencia (`models.dev` / `LiteLLM`).
- `modalities?: { input: string[]; output: string[] }` — Incluye modelos no-texto (ej. `embeddings`).
- `releaseDate?: string | null` y `upstreamCreatedAt?: number | null`.
- `providerPrivacy?: ProviderPrivacyConfig | null` — Política de privacidad/ZDR heredada del proveedor (`HU-40`, ver sección 2.7).

**Métodos en `api` (`api.ts`):**
- `api.setModelVisibility(fullId: string, disabled: boolean): Promise<{ ok: boolean; fullId: string; disabledByAdmin: boolean }>`  
  Conectar al interruptor **Habilitar / Deshabilitar modelo** (solo visible/operable para `admin`; pasar `disabled = true` para desactivar y `disabled = false` para reactivar).
- `api.getModels(): Promise<ProviderModelItem[]>` *(ya existente)*

**Requisitos UI:**
- **No** descartar silenciosamente los modelos con `active === false` o `disabledByAdmin === true` cuando el admin los esté gestionando (o añadir filtro/vista «Todos / Activos / Deshabilitados» para que el admin pueda reactivarlos).
- Permitir ver y alternar modelos no-texto (como `embeddings`) en el catálogo sin ocultarlos.
- Mostrar un distintivo o indicador visual cuando `model.hasCatalogInfo` sea `true` (y diferenciarlo cuando sea `false`).
- Corregir `formatReleaseDate`: validar que el timestamp convertido sea razonable (p. ej. año `>= 2018`) para evitar fechas corruptas como `1993-04-26`, mostrando `'No reportada'` en su lugar.
- **Privacidad/ZDR (`HU-40`):** mostrar en cada modelo el indicador de privacidad/ZDR de `model.providerPrivacy` para que el usuario sepa antes de enrutar prompts si el proveedor aplica ZDR, retención temporal, retiene prompts o es variable (agregadores).

---

### 2.4 `UsersTab.tsx` (`HU-31`, `HU-33`, `HU-35`)

**Propiedades ya disponibles en `types.ts`:**
- `ManagedUserItem.enforceStrictQuota?: boolean`
- `InvitationItem.enforceStrictQuota?: boolean`
- `CreateInvitationInput.enforceStrictQuota?: boolean`
- `ManagedUserItem.allowedModels: string[]` / `InvitationItem.allowedModels: string[]`

**Métodos en `api` (`api.ts`):**
- `api.deleteInvitation(invitationId: string): Promise<{ ok: boolean }>` *(endpoint `DELETE /api/invitations/:id`)*  
  Conectar al botón **Eliminar** en la lista de invitaciones pendientes.
- `api.createInvitation(input: CreateInvitationInput): Promise<CreateInvitationResult>` *(ya existente; incluir `enforceStrictQuota` en el payload)*.
- `api.updateUserQuotaAndModels(userId, { dailyTokenLimit, quotaResetMode, enforceStrictQuota, allowedModels }): Promise<ManagedUserItem>` *(ya existente; incluir `enforceStrictQuota` en el payload)*.

**Requisitos UI:**
- **Eliminar invitaciones:** botón de borrado/revocación en cada invitación pendiente (`usedAt === null`) que llame a `api.deleteInvitation(inv.id)` y actualice la lista.
- **Buscador de modelos:** dentro de los modales **Nueva invitación** y **Editar usuario**, añadir un input de búsqueda local sobre la lista de modelos cuando no esté activo el comodín `*`, filtrando por `fullId`, `name` o `providerId` sin perder las selecciones previas.
- **Interruptor de cuota estricta:** añadir switch/checkbox **Cuota estricta** (`enforceStrictQuota`, `true` por defecto al crear invitación) tanto en **Nueva invitación** como en **Editar usuario**, y mostrar un badge/indicador en la tabla.

---

### 2.5 `ApiKeysTab.tsx` (`HU-36`, `HU-37`)

**Propiedades en `InternalApiKey` (`types.ts`):**
- `expiresAt?: number | null` — Timestamp Unix (segundos) o `null` si no vence.
- `usedTokens?: number` / `requestsCount?: number` *(opcionales si el backend los expone en el listado de claves)*.

**Métodos en `api` (`api.ts`):**
- `api.createKey(name: string, options?: { expiresInDays?: number | null; expiresAt?: number | null }): Promise<CreateKeyResponse>`

**Requisitos UI:**
- Añadir selector opcional de vencimiento en el formulario de creación de API key (ej. *Sin vencimiento*, *7 días*, *30 días*, *90 días* o *Fecha personalizada*) enviando `expiresInDays` o `expiresAt` en `options`.
- Mostrar la fecha de expiración en cada fila/tarjeta de clave y un estado visual claro de **Expirada** cuando `expiresAt` sea menor o igual al tiempo actual.
- Si están disponibles `usedTokens` / `requestsCount` (o enlace directo a `MetricsTab` filtrado por API key), mostrarlos de forma compacta con `tabular-nums`.

---

### 2.6 `MetricsTab.tsx` (`HU-34`, `HU-37`)

**Tipos en `types.ts`:**
- `ActivityGroupBy = 'model' | 'provider' | 'user' | 'apiKey'` *(nota: `'apiKey'` se añade para `HU-37`)*
- `SpeedMetricsData` (`ModelSpeedEntry`: `ttftMs: PercentileTuple`, `tokensPerSec: PercentileTuple`)

**Métodos en `api` (`api.ts`):**
- `api.getMetricsActivity(range: ActivityRange, groupBy: ActivityGroupBy): Promise<ActivityMetricsData>` *(ya existente; soporta `groupBy = 'apiKey'` además de `'model' | 'provider' | 'user'`)*.

**Requisitos UI:**
- **Corrección de tabla/chips de percentiles (`HU-34`):** separar visualmente la etiqueta (`P50`, `P75`, `P90`, `P95`, `P99`) del valor numérico en `tokensPerSec` y `ttftMs` (ej. gap/espaciado entre `<strong>{s.label}</strong>` y el valor, usar `tabular-nums` / `.mono`, formato `toLocaleString('es-ES', { maximumFractionDigits: 1 })` y unidad explícita `tok/s` o `ms`).
- **Agrupación por API key y por usuario (`HU-37`):** añadir la opción **Por API key** en el selector de agrupación de actividad (junto a **Por modelo**, **Por proveedor** y **Por usuario**).

---

### 2.7 `MarketplaceTab.tsx` / `ProvidersTab.tsx` / Privacidad y ZDR (`HU-40`)

**Contrato TypeScript en `panel/src/types.ts` (añadido por Backend):**
```ts
export type DataRetentionKind = 'zero' | 'transient' | 'retained' | 'variable';
export type ProviderTrainingPolicy = 'never' | 'opt_out' | 'allowed' | 'unknown';

export interface ProviderPrivacyConfig {
  retention: DataRetentionKind;
  training: ProviderTrainingPolicy;
  retentionDays?: number;
  policyUrl?: string;
  note?: string;
}
```

**Campos añadidos a las interfaces existentes en `panel/src/types.ts` y normalizados en `panel/src/api.ts`:**
- En `ProviderManifest` *(ítems del Marketplace devueltos por `api.getMarketplace()` dentro de `MarketplaceCatalogState.manifests`)*:
  - `privacy?: ProviderPrivacyConfig | null`
- En `ProviderSummary` *(proveedores instalados devueltos por `api.getProviders()`)*:
  - `privacy?: ProviderPrivacyConfig | null`
- En `ProviderModelItem` *(modelos devueltos por `api.getModels()`, `api.getModelDetail()` y `ProviderSummary.models`)*:
  - `providerPrivacy?: ProviderPrivacyConfig | null`

**Requisitos UI (`MarketplaceTab.tsx` / `ProvidersTab.tsx`, `ProviderVaultCard.tsx`, `ModelsTab.tsx`):**
1. **Badge de privacidad/ZDR en Marketplace (`MarketplaceTab.tsx` / `ProvidersTab.tsx`):**
   - `retention === 'zero'` → Badge positivo (ej. **ZDR estricto** / *Sin retención*).
   - `retention === 'transient'` → Badge informativo (ej. **Retención temporal** + `${retentionDays}d` si está definido).
   - `retention === 'retained'` → Badge de advertencia (ej. **Sin ZDR / Retiene prompts**).
   - `retention === 'variable'` → Badge neutro/informativo para agregadores como OpenRouter (ej. **Variable**).
   - Mostrar indicador de entrenamiento cuando `training === 'allowed'` u `'opt_out'`, y enlace externo seguro (`target="_blank" rel="noopener noreferrer"`) a `policyUrl` cuando exista.
2. **Advertencia en `ProviderVaultCard.tsx`:**
   - Si el proveedor instalado tiene `privacy?.retention === 'retained'` o `privacy?.training === 'allowed'` / `'opt_out'` (ej. NVIDIA NIM free-tier), mostrar un badge de advertencia visible y un `InfoTip` con `privacy.note` o resumen de la política.
3. **Indicador en `ModelsTab.tsx`:**
   - Mostrar el distintivo de `model.providerPrivacy` en la fila/ficha del modelo para que el usuario conozca la retención antes de usarlo o enrutar prompts.
4. **Manejo especial para agregadores (`retention === 'variable'`):**
   - En OpenRouter y otros routers/agregadores con `retention: 'variable'`, explicar claramente mediante `InfoTip` o nota contextual que la retención de datos y el entrenamiento dependen del proveedor/modelo upstream subyacente que atienda la petición.

---

### 2.8 Prioridad P3 (`HU-38`, `HU-39`: Metadatos de límites y cuotas adaptativas)

**Contrato TypeScript en `panel/src/types.ts` (añadido por Backend):**
```ts
export type ProviderRateLimitKind = 'none' | 'requests' | 'tokens' | 'concurrency';
export type ProviderRateLimitWindow = 'hour' | 'day' | 'week';
export type QuotaConfidence = 'header_exact' | 'configured' | 'inferred';

export interface ProviderAdaptiveQuota {
  providerId: string;
  providerName: string;
  rateLimitKind: ProviderRateLimitKind | null;
  unit: 'tokens' | 'requests' | 'none';
  supportedWindows: ProviderRateLimitWindow[];
  activeWindow: ProviderRateLimitWindow;
  windowSeconds: number;
  windowLabel: string;
  confidence: QuotaConfidence;
  usableKeysCount: number;
  configuredLimit: number | null;
  inferredLimit: number | null;
  effectiveLimit: number | null;
  usedInWindow: number;
  remainingInWindow: number | null;
  headerRemaining: number | null;
  earliestResetAt: string | null;
  recent429Count7d: number;
  adaptiveAdjusted: boolean;
}

export interface FreeQuotaStatus {
  activeWindow: ProviderRateLimitWindow;
  windowSeconds?: number;
  windowLabel?: string;
  confidence: QuotaConfidence;
  configuredLimit: number | null;
  effectiveLimit: number | null;
  usedInWindow: number;
  remainingInWindow: number | null;
  quotaPercentageRemaining: number | null;
  adaptiveAdjusted: boolean;
  providers: ProviderAdaptiveQuota[];
}
```

1. **Marketplace & Proveedores (`ProviderManifest` / `ProviderSummary`):**
   - `rateLimitKind?: ProviderRateLimitKind | null` (`'none' | 'requests' | 'tokens' | 'concurrency' | null`)
   - `rateLimitWindows?: ProviderRateLimitWindow[]` (`Array<'hour' | 'day' | 'week'>`)
   - Normalizados en `api.getMarketplace()` (`MarketplaceCatalogState.manifests`) y disponibles en `ProviderManifest` / `ProviderSummary`.
   - **Requisito UI (`MarketplaceTab.tsx` / `ProvidersTab.tsx` / `ProviderVaultCard.tsx`):** mostrar un badge de clasificación del límite de tasa en las tarjetas de proveedor (*Sin límite* para `'none'`, *Por peticiones* para `'requests'`, *Por tokens* para `'tokens'` y **«Concurrencia»** para `'concurrency'`, junto con las ventanas `hora` / `día` / `semana` cuando apliquen).

2. **Cuota gratuita adaptativa (`MetricsSummary` vía `api.getMetricsSummary()` y `FreeQuotaStatus` vía `api.getFreeQuota()`):**
   - En `MetricsSummary` (`/api/metrics/summary`, con respaldo en `quotaToday` del servidor):
     - `activeWindow?: ProviderRateLimitWindow` (`'hour' | 'day' | 'week'`)
     - `quotaConfidence?: QuotaConfidence` (`'header_exact' | 'configured' | 'inferred'`; mapeado desde `summary.quotaConfidence` o `quotaToday.confidence`)
     - `effectiveLimit?: number | null`
     - `adaptiveAdjusted?: boolean`
     - `providerQuotas?: ProviderAdaptiveQuota[]`
   - En `FreeQuotaStatus` (`/api/metrics/free-quota`):
     - `activeWindow: ProviderRateLimitWindow` (`'hour' | 'day' | 'week'`)
     - `windowSeconds?: number` y `windowLabel?: string` *(ej. `'30m'`, `'4h'`, `'5h'`, `'24h'`, `'7d'`)*
     - `confidence: QuotaConfidence` (`'header_exact' | 'configured' | 'inferred'`)
     - `configuredLimit: number | null`, `effectiveLimit: number | null`, `usedInWindow: number`, `remainingInWindow: number | null`, `quotaPercentageRemaining: number | null`
     - `adaptiveAdjusted: boolean`
     - `providers: ProviderAdaptiveQuota[]` *(cada proveedor incluye `unit: 'tokens' | 'requests' | 'none'`, `windowSeconds`, `windowLabel` junto a `activeWindow` retrocompatible, y `usableKeysCount` contando solo claves `active` + `rate_limited`)*
   - **Requisito UI (`OverviewTab.tsx` / `MetricsTab.tsx` — bloque «Cuota gratuita»):**
     - Mostrar la ventana activa usando `windowLabel` cuando esté disponible (ej. `30m`, `4h`, `5h`, `24h`, `7d`) o la traducción de `activeWindow` (`hora` / `día` / `semana`) como respaldo.
     - Mostrar el indicador de confianza de la cuota (`Exacto por cabecera` para `'header_exact'`, `Configurado` para `'configured'`, `Inferido por 429` para `'inferred'`).
     - En el desglose por proveedor (`providerQuotas` / `providers`), renderizar cada cuota en su unidad real según `unit` (`tokens`, `peticiones` para `'requests'`, o `'none'`), **sin mezclar nunca peticiones y tokens**, mostrando además `windowLabel`, `usableKeysCount` (solo claves `active` + `rate_limited`) y `confidence`.
     - Usar `effectiveLimit` / cifras en `tabular-nums` (`.mono`) e indicar mediante badge/nota (`InfoTip`) cuando `adaptiveAdjusted === true` o cuando exista desglose en `providerQuotas` / `providers`.

---

### 2.9 Detección y ejecución de actualizaciones (`HU-41`)

**Contrato TypeScript en `panel/src/types.ts` (añadido por Backend):**
```ts
export type SystemUpdatePhase = 'idle' | 'pulling' | 'building' | 'restarting' | 'error';

export interface SystemUpdateStatus {
  currentVersion: string;
  currentCommit: string | null;
  latestCommit: string | null;
  latestCommitMessage: string | null;
  latestCommitUrl: string | null;
  latestPublishedAt: string | null;
  updateAvailable: boolean;
  runtimeMode: 'docker' | 'native';
  canAutoUpdate: boolean;
  checkedAt: number;
  error?: string | null;
  updatePhase?: SystemUpdatePhase;
  updatePhaseMessage?: string | null;
}
```

**Métodos en `api` (`api.ts`):**
- `api.getHealth(): Promise<{ ok: boolean; version?: string; buildCommit?: string | null }>`  
  Llama a `GET /api/health` (devuelve estado del servidor, versión actual y `buildCommit` corto del despliegue activo).
- `api.getUpdateStatus(refresh?: boolean): Promise<SystemUpdateStatus>`  
  Llama a `GET /api/system/update-status` (o `GET /api/system/update-status?refresh=1` cuando `refresh === true`, saltando la caché de 15 minutos del backend).
- `api.triggerSystemUpdate(): Promise<{ ok: boolean; mode: 'watchtower' | 'native'; upToDate?: boolean; message: string; restarting: boolean }>`  
  Llama a `POST /api/system/update` (solo `admin`, ejecuta Watchtower en Docker o `git pull` + recompilación y reinicio en `systemd`).

**Requisitos UI (`OverviewTab.tsx` o barra superior / topbar — solo `admin`):**
- Mostrar un banner/badge sutil de actualización exclusivamente para administradores cuando `updateAvailable === true` (evitar ruido visual si está actualizado o para usuarios no administradores).
- Incluir enlace externo seguro (`target="_blank" rel="noopener noreferrer"`) a `latestCommitUrl` (mostrando el commit abreviado y/o `latestCommitMessage` / `latestPublishedAt`).
- Incluir botón **Comprobar ahora** que invoque `api.getUpdateStatus(true)` (`refresh=true`) con estado de carga.
- **Actualización en 1 clic vs. respaldo manual:**
  - Si `updateAvailable && canAutoUpdate`: mostrar botón **«Actualizar ahora»** (con estado de carga/confirmación segura y feedback de `message` / `restarting: true`, manejando errores con `ApiError`) que invoque `api.triggerSystemUpdate()`.
  - Si `canAutoUpdate === false` (respaldo manual): mostrar un comando copiable adaptado automáticamente según `runtimeMode`:
    - Si `runtimeMode === 'docker'`: `docker compose pull && docker compose up -d`
    - Si `runtimeMode === 'native'`: `git pull && npm run build`

---

### 2.10 Marketplace Multi-Repositorio, Versionado y Actualización en Sitio (`HU-42`)

**Contrato TypeScript en `panel/src/types.ts` (añadido por Backend):**
```ts
export interface MarketplaceSourceItem {
  id: string;
  name: string;
  url: string;
  isOfficial: boolean;
  enabled: boolean;
  catalogVersion: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface MarketplaceProviderEntry extends ProviderManifest {
  sourceId?: string;
  sourceName?: string;
  isOfficial?: boolean;
  manifestHash?: string;
  manifestVersion?: string;
  installed?: boolean;
  installedHash?: string | null;
  updateAvailable?: boolean;
}

export interface MarketplaceCatalogState {
  manifests: MarketplaceProviderEntry[];
  offline: boolean;
  notice?: string;
  sources?: MarketplaceSourceItem[];
  catalogVersion?: string | null;
  checkedAt?: number | null;
  updatesAvailableCount?: number;
  enabledSourcesCount?: number;
}

export interface MarketplaceUpdateResult {
  ok: boolean;
  updated: string[];
  skipped: string[];
  providers: ProviderSummary[];
}
```

**Campos en `ProviderSummary` (`panel/src/types.ts`, devuelto por `GET /api/providers` y normalizado en `normalizeProviderSummary`):**
- `sourceId?: string | null`
- `manifestHash?: string | null`

> **Nota sobre `updateAvailable` para proveedores instalados:** `ProviderSummary` **no** incluye `updateAvailable` ni `manifestVersion`; para saber si un proveedor instalado tiene actualización disponible, emparejar `provider.id` contra `MarketplaceCatalogState.manifests` (p. ej. `catalog.manifests.find(m => m.id === p.id)?.updateAvailable`, además de `manifestVersion`, `manifestHash`, `installedHash` y `sourceName`).

**Métodos en `api` (`panel/src/api.ts`):**
- `api.getMarketplace(refresh?: boolean): Promise<MarketplaceCatalogState>`  
  Llama a `GET /api/marketplace` (o `GET /api/marketplace?refresh=1` cuando `refresh === true` para forzar descarga remota y comparación de versiones contra todas las fuentes activas).
- `api.getMarketplaceSources(): Promise<MarketplaceSourceItem[]>`  
  Llama a `GET /api/marketplace/sources` (lista el repositorio oficial recomendado `sxamx/bifrost-providers` —por defecto `enabled: false`— y los repositorios personalizados).
- `api.addMarketplaceSource(input: { name: string; url: string; enabled?: boolean }): Promise<MarketplaceSourceItem>`  
  Llama a `POST /api/marketplace/sources` (con validación SSRF estricta en backend para URLs HTTPS remotas).
- `api.updateMarketplaceSource(id: string, input: { name?: string; enabled?: boolean }): Promise<MarketplaceSourceItem>`  
  Llama a `PATCH /api/marketplace/sources/:id` (para activar/desactivar `enabled` o editar `name`).
- `api.deleteMarketplaceSource(id: string): Promise<{ ok: boolean; id: string }>`  
  Llama a `DELETE /api/marketplace/sources/:id` (elimina repositorios personalizados; el oficial permanece pre-registrado).
- `api.updateInstalledMarketplaceProviders(providerId?: string): Promise<MarketplaceUpdateResult>`  
  Llama a `POST /api/marketplace/update-installed` (con `{ providerId }` para actualizar un proveedor concreto o sin `providerId` para actualizar todos los proveedores con `updateAvailable === true`, actualizando `schema_json` en sitio sin borrar `provider_keys`, `models` ni `usage_logs`).

**Requisitos UI (`ProvidersTab.tsx` / `MarketplaceTab.tsx` y `ProviderVaultCard.tsx`):**
1. **Gestor de repositorios del Marketplace (opt-in):**
   - Mostrar un panel/sección colapsable de **Repositorios de proveedores** con el repositorio oficial recomendado (`sxamx/bifrost-providers`, `isOfficial: true`) pre-listado y un interruptor para activarlo (`enabled = true`) o desactivarlo (`enabled = false`), explicando que por defecto está desactivado (*opt-in*).
   - Incluir formulario para añadir un repositorio HTTPS personalizado (`name` + `url`, usando `api.addMarketplaceSource({ name, url, enabled? })`), controles de activar/desactivar y edición de nombre (`api.updateMarketplaceSource(id, { name?, enabled? })`), y botón eliminar para repositorios no oficiales (`api.deleteMarketplaceSource(id)`), mostrando `lastError` / `catalogVersion` / `lastCheckedAt` por fuente y `enabledSourcesCount` / `checkedAt` del catálogo, manejando errores SSRF/HTTP vía `ApiError`.
2. **Versionado, origen y comprobación de actualizaciones:**
   - Mostrar `catalogVersion` (y `checkedAt` / `enabledSourcesCount`) en la cabecera del Marketplace y `manifestVersion` (y `manifestHash` abreviado en tooltip/subtítulo) junto al badge de origen (`sourceName` o distintivo **Oficial** cuando `isOfficial === true`) en cada tarjeta del catálogo (`MarketplaceProviderEntry`).
   - Añadir el botón **«Comprobar actualizaciones»** que llame a `api.getMarketplace(true)` con estado de carga y actualice los indicadores de actualización (`updatesAvailableCount` y `updateAvailable`).
3. **Actualización en sitio sin pérdida de datos:**
   - En las tarjetas del catálogo (`MarketplaceProviderEntry`) con `installed === true && updateAvailable === true`, y en los proveedores instalados (`ProviderVaultCard.tsx`, determinando la actualización mediante `catalog.manifests.find(m => m.id === p.id)?.updateAvailable`), mostrar indicador de versión/hash (`installedHash` / `provider.manifestHash` frente a `manifestVersion` / `manifestHash`) y botón **«Actualizar»** / **«Actualizar proveedor»** que llame a `api.updateInstalledMarketplaceProviders(provider.id)`.
   - Cuando existan 1 o más proveedores instalados actualizables (`updatesAvailableCount > 0`), mostrar botón global **«Actualizar todos»** que invoque `api.updateInstalledMarketplaceProviders()` sin parámetros (procesando `updated`, `skipped` y `providers` de `MarketplaceUpdateResult`) y refresque `providers` y el catálogo sin perder claves ni modelos.

---

## 3. Checklist final de implementación UI

- [x] **`ProviderVaultCard.tsx`**: switch **Activar / Desactivar** (`status === 'disabled'`), badge `no_node`, botón **Probar clave** (`ProviderKeyTestResult`) y badge/tooltip de advertencia de privacidad (`HU-40`).
- [x] **`NodesTab.tsx`**: botón **Probar nodo** (`ExitNodeTestResult`) con estado de carga/latencia, botón **Actualizar nodo** (`api.updateNode`) con manejo de `updateAvailable === true | false | null` y feedback de carga/reinicio (`HU-41`), y advertencia de claves afectadas al eliminar nodo.
- [x] **`ModelsTab.tsx`**: interruptor de visibilidad admin (`api.setModelVisibility`), soporte y filtro para modelos deshabilitados y no-texto (`embeddings`), badge `hasCatalogInfo`, saneamiento de `formatReleaseDate` (`>= 2018` o `'No reportada'`) e indicador `providerPrivacy` (`HU-40`).
- [x] **`UsersTab.tsx`**: botón **Eliminar** en invitaciones pendientes (`api.deleteInvitation`), buscador de modelos en modales sin perder selección e interruptor/badge `enforceStrictQuota` *(ver ajustes menores pendientes en Sección 4)*.
- [x] **`ApiKeysTab.tsx`**: selector de expiración (`expiresInDays`), columna/badge de expiración y estado **Expirada**, y métricas compactas por clave (`usedTokens` / `requestsCount`).
- [x] **`MetricsTab.tsx`**: separación visual y formato `es-ES` con `tabular-nums` en tabla/chips de percentiles (`P50`–`P99`, `tok/s` y `ms`), `requestsCount` en tooltip de actividad y opción **Por API key** en `ActivityGroupBy`.
- [x] **`MarketplaceTab.tsx` / `ProvidersTab.tsx` (`HU-38`, `HU-40`)**: badges ZDR/retención (`zero`, `transient`, `retained`, `variable`), enlace a `policyUrl`, nota contextual para agregadores (`variable` como OpenRouter), detalle de `training` y badge de clasificación de límites (`rateLimitKind` / `rateLimitWindows`, incluyendo `concurrency`).
- [ ] **`MarketplaceTab.tsx` / `ProvidersTab.tsx` / `ProviderVaultCard.tsx` (`HU-42`)**: gestor de repositorios multi-fuente opt-in (`api.getMarketplaceSources` / `addMarketplaceSource` / `updateMarketplaceSource` / `deleteMarketplaceSource`), badges de versión (`catalogVersion`, `manifestVersion`, `manifestHash`) y origen (`sourceName`, `isOfficial`, `sourceId`), botón **«Comprobar actualizaciones»** (`api.getMarketplace(true)`) y botones **«Actualizar» / «Actualizar todos»** (`api.updateInstalledMarketplaceProviders`).
- [x] **`OverviewTab.tsx` (Cuota gratuita, `HU-39`)**: mostrar ventana activa (`hora` / `día` / `semana`), indicador de confianza (`Exacto por cabecera`, `Configurado`, `Inferido por 429`), `effectiveLimit`, estado `adaptiveAdjusted` y detalle por proveedor (`providerQuotas` / `FreeQuotaStatus.providers`). *(Pendiente replicar resumen en `MetricsTab.tsx` y mostrar `usableKeysCount`, ver Sección 4)*.
- [x] **`OverviewTab.tsx` / Topbar (`HU-41`)**: implementado y completado en PR #48, PR #51 y PR #52 (botón **«Comprobar ahora»** siempre accesible, versión visible en sidebar y progreso real por fases con auto-recarga).

---

## 4. Pendientes UI acumulados (Ronda 3 — para próxima PR de diseño)

Lista viva de ajustes, añadidos y correcciones que debe implementar la IA de diseño en la siguiente PR (sin tocar `panel/src/api.ts`, `panel/src/types.ts`, `core/`, `nodes/` ni `tests/`):

> **Resueltos en PR #50, PR #51 y PR #52:** progreso en tiempo real y auto-recarga del autoupdater + versión visible en sidebar (`App.tsx` / `OverviewTab.tsx`), botón «Comprobar ahora» siempre accesible (`OverviewTab.tsx`), manejo de `node.updateAvailable === null` (`NodesTab.tsx`), `requestsCount` en actividad (`MetricsTab.tsx`), `usedTokens` y `requestsCount` en `ApiKeysTab.tsx`, desglose `providerQuotas` en `OverviewTab.tsx`, formato `es-ES` con `tabular-nums` en percentiles de `MetricsTab.tsx`, filtrado de `disabledByAdmin` en `PlaygroundTab.tsx` y selector de `reasoning_effort` con opción `'none'` (`Desactivado / Estándar`).

1. **`UsersTab.tsx` (`HU-31`, `HU-35`)** — *Corregir + Añadir*:
   - Cambiar el estado inicial de `inviteEnforceStrict` de `false` a **`true`** (activado por defecto al crear invitaciones).
   - Mostrar etiqueta visual **«Flexible»** cuando `enforceStrictQuota === false` en las tablas de usuarios e invitaciones (actualmente solo muestra «Estricta» si es `true`).
   - *(Menor, `HU-31`)*: En invitaciones no usadas pero ya expiradas (`!inv.usedAt && inv.expiresAt <= now`), mostrar **«Expirada»** en vez de «Pendiente».
2. **`OverviewTab.tsx` y `MetricsTab.tsx` (`HU-39`)** — *Completar*:
   - En `OverviewTab.tsx`: mostrar también **`usableKeysCount`** (claves `active` + `rate_limited`) dentro de cada tarjeta del desglose `providerQuotasList`.
   - En `MetricsTab.tsx`: añadir el bloque/indicador de ventana activa (`windowLabel` o `hora`/`día`/`semana`), confianza (`Exacto por cabecera` / `Configurado` / `Inferido por 429`) y el desglose por proveedor (`freeQuota.providers`) con `unit`, `windowLabel`, `usableKeysCount` y `confidence`.
3. **`CompareTab.tsx` (`HU-30` y `HU-34`)** — *Corregir*:
   - Filtrar modelos con `disabledByAdmin === true` en `CompareTab.tsx` igual que en `PlaygroundTab.tsx` (`m.active !== false && !m.disabledByAdmin`).
   - Formatear el valor de velocidad `P50` (`tokensPerSec.p50`) y `TTFT P50` en `CompareTab.tsx` con `toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })` (en lugar de `.toFixed(1)` crudo).
4. **`ProvidersTab.tsx` / `MarketplaceTab.tsx` y `ProviderVaultCard.tsx` (`HU-42`)** — *Nuevo*:
   - **Panel gestor de repositorios (`MarketplaceSourceItem`):** añadir UI para listar fuentes (`api.getMarketplaceSources()`), activar/desactivar con toggle el repositorio oficial recomendado (`sxamx/bifrost-providers`, `isOfficial: true`, `enabled = false` por defecto opt-in) y añadir/habilitar/deshabilitar/eliminar repositorios HTTPS personalizados (`api.addMarketplaceSource({ name, url, enabled? })`, `api.updateMarketplaceSource(id, { name?, enabled? })`, `api.deleteMarketplaceSource(id)`), mostrando `url`, `catalogVersion`, `lastCheckedAt`, `lastError` y `enabledSourcesCount`.
   - **Badges de versión y origen:** mostrar `catalogVersion` y `checkedAt` en la cabecera del catálogo (`MarketplaceCatalogState`), y `manifestVersion` (junto con `manifestHash` abreviado) + badge de repositorio origen (`sourceName` / `isOfficial` / `sourceId`) en cada tarjeta del catálogo (`MarketplaceProviderEntry`) y en los proveedores instalados (`ProviderSummary.sourceId`, `ProviderSummary.manifestHash`).
   - **Botón «Comprobar actualizaciones»:** añadir botón en el Marketplace (y/o cabecera de Proveedores) que invoque `api.getMarketplace(true)` (`?refresh=1`) con estado de carga y feedback de actualizaciones detectadas (`updatesAvailableCount`).
   - **Botones «Actualizar» y «Actualizar todos» en sitio (`MarketplaceUpdateResult`):** determinar `updateAvailable` para proveedores instalados emparejando `provider.id` contra `MarketplaceCatalogState.manifests` (p. ej. `catalog.manifests.find(m => m.id === p.id)?.updateAvailable`); cuando `updateAvailable === true` (tanto en `ProviderVaultCard.tsx` como en tarjetas del catálogo con `installed === true`), mostrar el hash/versión instalada (`installedHash` / `provider.manifestHash`) frente a la disponible (`manifestVersion` / `manifestHash`) y botón **«Actualizar»** (`api.updateInstalledMarketplaceProviders(provider.id)`), más botón global **«Actualizar todos»** (`api.updateInstalledMarketplaceProviders()`) cuando `updatesAvailableCount > 0`, procesando `updated` / `skipped` / `providers` y refrescando el estado sin perder claves ni modelos.


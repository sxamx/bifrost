# Guía de Handoff UI — Bifrost V2

Documento técnico para implementar los cambios de interfaz de la V2 en el panel (`panel/src/`).  
Refleja las historias `HU-27` a `HU-44` descritas en [`HISTORIAS-V2.md`](HISTORIAS-V2.md).

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
9. `PlaygroundTab.tsx` *(historial de chats cifrado y privado por cuenta, `HU-43`)*

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

### 2.4 `UsersTab.tsx` (`HU-31`, `HU-33`, `HU-35`, `HU-44`)

**Propiedades ya disponibles en `types.ts`:**
- `ManagedUserItem.enforceStrictQuota?: boolean`
- `InvitationItem.enforceStrictQuota?: boolean`
- `InvitationItem.usedByUserId?: string | null` *(HU-44 — ID de la cuenta que canjeó la invitación, `null` si sigue pendiente o si la cuenta fue eliminada)*
- `InvitationItem.usedByUsername?: string | null` *(HU-44 — nombre de usuario que canjeó la invitación; se conserva incluso si la cuenta se elimina después)*
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
- **Historial de invitaciones (`HU-44`):** cuando `inv.usedAt !== null` y `inv.usedByUsername` esté presente, mostrar **`@{inv.usedByUsername}`** en la tabla de historial de invitaciones para identificar qué cuenta canjeó cada enlace.

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

### 2.11 `PlaygroundTab.tsx` — Historial de chats cifrado, persistencia resiliente y configuración por conversación (`HU-43`, `HU-43b`)

**Contrato TypeScript exacto en `panel/src/types.ts` (añadido por Backend):**
```ts
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type PlaygroundMessageRole = 'user' | 'assistant' | 'system';

export interface PlaygroundChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  systemPrompt?: string;
  chatId?: string;
  stream?: boolean;
}

export interface PlaygroundChatSettings {
  reasoningEffort?: ReasoningEffort;
  temperature?: number | null;
  maxTokens?: number | null;
  systemPrompt?: string | null;
}

export interface PlaygroundMessageMetrics {
  ttftMs?: number | null;
  tokensPerSec?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  error?: string | null;
}

export interface PlaygroundChatSummary {
  id: string;
  title: string;
  modelFullId: string | null;
  settings?: PlaygroundChatSettings | null;
  inProgress?: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaygroundChatMessage {
  id: string;
  chatId: string;
  role: PlaygroundMessageRole;
  content: string;
  reasoningContent: string | null;
  modelFullId: string | null;
  metrics: PlaygroundMessageMetrics | null;
  createdAt: number;
}

export interface PlaygroundChatDetail {
  chat: PlaygroundChatSummary;
  settings?: PlaygroundChatSettings | null;
  inProgress?: boolean;
  messages: PlaygroundChatMessage[];
}

export interface AppendPlaygroundMessageInput {
  role: PlaygroundMessageRole;
  content: string;
  reasoningContent?: string | null;
  modelFullId?: string | null;
  metrics?: PlaygroundMessageMetrics | null;
}

export interface AppendPlaygroundMessagesResult {
  chat: PlaygroundChatSummary;
  message: PlaygroundChatMessage;
  messages: PlaygroundChatMessage[];
}
```

**Métodos exactos en `api` (`panel/src/api.ts`):**
- `api.streamPlaygroundChat(input: PlaygroundChatRequest, onDelta?: (partialText: string) => void, options?: { signal?: AbortSignal }): Promise<PlaygroundChatResponse>`  
  Llama a `POST /api/playground/chat` con `stream: true` y reenvía `chatId`, `systemPrompt`, `reasoningEffort`, `temperature`, `maxTokens` y `signal`. Cuando se pasa `chatId`, el servidor guarda el mensaje del usuario **antes** de contactar al upstream, cifra `settings` por usuario y continúa leyendo/persistiendo la respuesta (o el error en `metrics.error`) en segundo plano aunque el cliente aborte o recargue la pestaña.
- `api.sendPlaygroundChat(input: PlaygroundChatRequest, onDelta?: (partialText: string) => void, options?: { signal?: AbortSignal }): Promise<PlaygroundChatResponse>`  
  Mismo contrato (soporta tanto streaming como `stream: false` con persistencia automática cuando se envía `chatId`).
- `api.getPlaygroundChats(): Promise<PlaygroundChatSummary[]>`  
  Llama a `GET /api/playground/chats` (lista los chats propios ordenados por `updatedAt DESC`, incluyendo `settings` e `inProgress`).
- `api.createPlaygroundChat(input?: { title?: string; modelFullId?: string | null; settings?: PlaygroundChatSettings | null }): Promise<PlaygroundChatSummary>`  
  Llama a `POST /api/playground/chats` (crea un chat nuevo con título por defecto `"Nuevo chat"` y `settings` cifrados opcionales).
- `api.getPlaygroundChat(chatId: string): Promise<PlaygroundChatDetail>`  
  Llama a `GET /api/playground/chats/:id` (devuelve `{ chat, settings, inProgress, messages }` solo si pertenece a la cuenta autenticada; `404` en caso contrario).
- `api.updatePlaygroundChat(chatId: string, input: { title?: string; modelFullId?: string | null; settings?: PlaygroundChatSettings | null }): Promise<PlaygroundChatSummary>`  
  Llama a `PATCH /api/playground/chats/:id` (renombra `title`, actualiza `modelFullId` y/o actualiza `settings` cifrados en reposo).
- `api.appendPlaygroundMessage(chatId: string, input: AppendPlaygroundMessageInput | { messages: AppendPlaygroundMessageInput[] }): Promise<AppendPlaygroundMessagesResult>`  
  Llama a `POST /api/playground/chats/:id/messages` (útil solo si se requiere guardado manual; **no debe llamarse** para duplicar mensajes cuando ya se pasó `chatId` en `streamPlaygroundChat` / `sendPlaygroundChat`).
- `api.deletePlaygroundChat(chatId: string): Promise<{ ok: boolean }>`  
  Llama a `DELETE /api/playground/chats/:id`.
- `api.clearPlaygroundChats(): Promise<{ ok: boolean; deletedCount: number }>`  
  Llama a `DELETE /api/playground/chats`.

**Requisitos UI (`PlaygroundTab.tsx`):**
1. **Barra lateral de conversaciones (`HU-43`):**
   - Lista de chats propios (`api.getPlaygroundChats()`), botón **«Nuevo chat»**, renombrar, eliminar chat individual, **«Limpiar historial»** con confirmación, y aviso visible de cifrado privado por cuenta (**AES-256-GCM**, inaccesible incluso para administradores, excluido de backups `.bifrost.enc`).
2. **Persistencia resiliente sin duplicados (`HU-43b`):**
   - Al enviar un prompt: si aún no existe un chat activo, crearlo primero con `api.createPlaygroundChat({ modelFullId, settings })` y pasar su `chatId` en `api.streamPlaygroundChat({ ..., chatId })`.
   - **NO duplicar** llamadas a `api.appendPlaygroundMessage(...)` desde frontend cuando ya se pasó `chatId` a `streamPlaygroundChat` / `sendPlaygroundChat`, porque el backend ya guarda el turno `user` antes de llamar al upstream y persiste automáticamente la respuesta del asistente (o el error seguro con `metrics.error`) al finalizar.
   - Si un mensaje recuperado del servidor tiene `msg.metrics?.error`, renderizarlo visualmente como estado de error del turno en la conversación (conservando el prompt del usuario para que nunca se pierda al recargar o cambiar de chat).
3. **Configuración cifrada por conversación (`HU-43b`):**
   - Al seleccionar un chat en la barra lateral (`api.getPlaygroundChat(chatId)`), restaurar `chat.modelFullId` (si está activo) y `settings` (`reasoningEffort`, `temperature`, `maxTokens`, `systemPrompt`) en los controles del Playground.
   - Cuando el usuario modifique `modelFullId` o cualquiera de los controles de `settings` sobre un chat existente, persistir el cambio con `api.updatePlaygroundChat(chatId, { modelFullId, settings })` (con debounce razonable para `systemPrompt` / inputs numéricos).
4. **Indicador de generación en segundo plano (`inProgress === true`):**
   - Mostrar un indicador/badge discreto en la barra lateral y en la cabecera/pie del chat activo (*«Generando en segundo plano…»*) cuando `chat.inProgress === true` o `detail.inProgress === true`.
   - Si el usuario abre o vuelve a un chat con `inProgress === true`, activar un polling suave (p. ej. cada `2s`–`3s` a `api.getPlaygroundChat(chatId)`) que se detenga automáticamente en cuanto `inProgress === false` o al cambiar de chat/desmontar el componente, actualizando la conversación con la respuesta completa o error persistido.

---

## 3. Checklist final de implementación UI

- [x] **`ProviderVaultCard.tsx`**: switch **Activar / Desactivar** (`status === 'disabled'`), badge `no_node`, botón **Probar clave** (`ProviderKeyTestResult`) y badge/tooltip de advertencia de privacidad (`HU-40`).
- [x] **`NodesTab.tsx`**: botón **Probar nodo** (`ExitNodeTestResult`) con estado de carga/latencia, botón **Actualizar nodo** (`api.updateNode`) con manejo de `updateAvailable === true | false | null` y feedback de carga/reinicio (`HU-41`), y advertencia de claves afectadas al eliminar nodo.
- [x] **`ModelsTab.tsx`**: interruptor de visibilidad admin (`api.setModelVisibility`), soporte y filtro para modelos deshabilitados y no-texto (`embeddings`), badge `hasCatalogInfo`, saneamiento de `formatReleaseDate` (`>= 2018` o `'No reportada'`) e indicador `providerPrivacy` (`HU-40`).
- [x] **`UsersTab.tsx`**: botón **Eliminar** en invitaciones pendientes (`api.deleteInvitation`), buscador de modelos en modales, interruptor/badge `enforceStrictQuota` (`Estricta`/`Flexible`), estado `Expirada`, y consumo diario/histórico (`usedTokensToday / dailyTokenLimit`, `usedTokens`, `requestsCount`) — resueltos en PR #53 y PR #56. *(Pendiente `HU-44` en Sección 4)*.
- [x] **`ApiKeysTab.tsx`**: selector de expiración (`expiresInDays`), columna/badge de expiración y estado **Expirada**, y métricas compactas por clave (`usedTokens` / `requestsCount`).
- [x] **`MetricsTab.tsx`**: separación visual y formato `es-ES` con `tabular-nums` en tabla/chips de percentiles (`P50`–`P99`, `tok/s` y `ms`), `requestsCount` en tooltip de actividad, opción **Por API key** en `ActivityGroupBy` y bloque de cuota adaptativa por proveedor (`HU-39`).
- [x] **`MarketplaceTab.tsx` / `ProvidersTab.tsx` / `ProviderVaultCard.tsx` (`HU-38`, `HU-40`, `HU-42`)**: badges ZDR/retención, límites (`rateLimitKind`/`rateLimitWindows`), gestor multi-fuente opt-in, badges de versión/origen, **«Comprobar actualizaciones»** y **«Actualizar» / «Actualizar todos»** en sitio (PR #53).
- [x] **`PlaygroundTab.tsx` (`HU-43`)**: barra lateral de historial de chats cifrados por cuenta, crear/renombrar/borrar/limpiar historial y aviso de cifrado privado (PR #56). *(Pendiente `HU-43b` en Sección 4)*.
- [x] **`OverviewTab.tsx` (`HU-39`, `HU-41`)**: cuota gratuita adaptativa con `usableKeysCount`, progreso real del autoupdater compatible con `202 Accepted` y auto-recarga resiliente (PR #51, PR #52, PR #53, PR #56).
- [ ] **`UsersTab.tsx` (`HU-44`)**: mostrar `@usedByUsername` en la tabla de **Historial de invitaciones** para invitaciones canjeadas.
- [ ] **`PlaygroundTab.tsx` (`HU-43b`)**: pasar `chatId` en `api.streamPlaygroundChat`, eliminar guardado duplicado en frontend, restaurar/persistir `modelFullId` + `settings` cifrados por chat y mostrar indicador *«Generando en segundo plano…»* + polling suave si `inProgress === true`.

---

## 4. Pendientes UI acumulados (Ronda 4 — `HU-43b` y `HU-44`)

Lista viva de añadidos que debe implementar la IA de diseño en la siguiente PR (sin tocar `panel/src/api.ts`, `panel/src/types.ts`, `core/`, `nodes/` ni `tests/`):

> **Resueltos en PR #53 y PR #56:** Marketplace multi-repo y actualizaciones en sitio (`HU-42`), `UsersTab.tsx` (`inviteEnforceStrict=true`, badge `Flexible`, estado `Expirada`, consumo diario `usedTokensToday / dailyTokenLimit` e histórico `usedTokens` + `requestsCount`), `usableKeysCount` en `OverviewTab.tsx` y bloque adaptativo en `MetricsTab.tsx` (`HU-39`), `CompareTab.tsx` (`disabledByAdmin` + formato `es-ES`), historial de chats del Playground (`HU-43`), autoupdater resiliente compatible con `202 Accepted` y auditoría QA de 44 hallazgos.

1. **`UsersTab.tsx` (`HU-44` — Historial de invitaciones vinculado a cuenta):**
   - En la tabla de **Historial de invitaciones**, cuando `inv.usedAt !== null` y `inv.usedByUsername` esté definido, mostrar **`@{inv.usedByUsername}`** (usando `.mono` o chip discreto junto al estado «Canjeada» o en una columna «Canjeada por») para que el admin vea qué cuenta usó cada invitación. Si `inv.usedByUsername` es `null` (invitaciones antiguas previas a `HU-44` o pendientes), mostrar `—` sin romper el layout.
2. **`PlaygroundTab.tsx` (`HU-43b` — Persistencia resiliente en servidor + configuración cifrada por chat):**
   - **Pasar `chatId` en `api.streamPlaygroundChat(...)`:** al enviar un prompt, crear el chat si no existe (`api.createPlaygroundChat({ modelFullId, settings })`) y llamar a `api.streamPlaygroundChat({ model, messages, temperature, maxTokens, reasoningEffort, systemPrompt, chatId }, onDelta, { signal })`. **Eliminar** la llamada redundante a `api.appendPlaygroundMessage(...)` tras recibir la respuesta, ya que el backend persiste tanto el mensaje `user` (antes de llamar al upstream) como la respuesta del asistente (o el error seguro con `metrics.error`) y actualiza el título autogenerado automáticamente.
   - **Restaurar y guardar `modelFullId` + `settings` por chat:** al seleccionar un chat (`api.getPlaygroundChat(chatId)`), restaurar `chat.modelFullId` y `settings` (`reasoningEffort`, `temperature`, `maxTokens`, `systemPrompt`) en el estado local del Playground; al cambiar estos controles sobre un chat activo, guardarlos con `api.updatePlaygroundChat(chatId, { modelFullId, settings })` (con debounce en campos de texto/número).
   - **Generación en segundo plano (`inProgress === true`):** si un chat tiene `inProgress === true` (tanto en el listado `PlaygroundChatSummary.inProgress` como en `PlaygroundChatDetail.inProgress`), mostrar un indicador visible *«Generando en segundo plano…»* en la barra lateral y en la conversación activa, y activar un polling suave cada `2s`–`3s` a `api.getPlaygroundChat(chatId)` hasta que `inProgress === false`, refrescando entonces los mensajes (incluyendo errores persistidos con `msg.metrics?.error`) y la lista lateral.
   - **Cambio de chat sin perder respuestas:** al cambiar de conversación mientras hay un stream activo en el cliente, cancelar únicamente el `AbortController` local del `fetch` (el servidor sigue leyendo el upstream en segundo plano y persiste la respuesta completa para cuando el usuario vuelva).




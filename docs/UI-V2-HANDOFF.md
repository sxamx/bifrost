# Guía de Handoff UI — Bifrost V2

Documento técnico para implementar los cambios de interfaz de la V2 en el panel (`panel/src/`).  
Refleja las historias `HU-27` a `HU-37` descritas en [`HISTORIAS-V2.md`](HISTORIAS-V2.md).

---

## 1. Alcance y archivos permitidos

### Componentes que SÍ debes actualizar (en `panel/src/components/`)
1. `ProviderVaultCard.tsx`
2. `NodesTab.tsx`
3. `ModelsTab.tsx`
4. `UsersTab.tsx`
5. `ApiKeysTab.tsx`
6. `MetricsTab.tsx`

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

> Nota: Algunos campos ya existen en `types.ts`/`api.ts` (ej. `enforceStrictQuota`, `status: 'no_node'`, `active`) y los nuevos métodos/propiedades estarán disponibles en `api.ts` y `types.ts` al momento de compilar el panel V2.

### 2.1 `ProviderVaultCard.tsx` (`HU-27`, `HU-29`)

**Propiedades en `ProviderKeyItem` (`types.ts`):**
- `enabled: boolean` — Indica si la clave está activa para enrutamiento (`false` por defecto al crearse).
- `status: ProviderKeyStatus` — `'active' | 'rate_limited' | 'error' | 'no_node'`.
- `lastError?: string | null` — Último error reportado por el upstream o por una prueba manual.
- `nodeId: string | null` — Nodo asignado (si es `null` y `status === 'no_node'`, la clave está fuera de servicio).

**Métodos en `api` (`api.ts`):**
- `api.toggleProviderKey(providerId: string, keyId: string, enabled: boolean): Promise<ProviderKeyItem>`  
  Conectar al interruptor **Activar / Desactivar** de cada clave.
- `api.testProviderKey(providerId: string, keyId: string): Promise<{ ok: boolean; latencyMs?: number; status: ProviderKeyStatus; error?: string | null }>`  
  Conectar al botón **Probar clave** (deshabilitar si `k.status === 'no_node'`).

**Requisitos UI:**
- Indicar visualmente cuando una clave recién creada está **Desactivada** (`enabled === false`) y permitir activarla con el switch.
- Mostrar badge específico para `status === 'no_node'` («Sin nodo / Fuera de servicio») y deshabilitar **Probar clave** mientras no tenga nodo asignado.
- Mostrar el resultado inline de **Probar clave** (latencia en `ms` si `ok: true`, o mensaje de error si `ok: false`).

---

### 2.2 `NodesTab.tsx` (`HU-27`, `HU-28`)

**Propiedades en `ExitNodeItem` (`types.ts`):**
- `id: string`, `name: string`, `mode: 'tailscale' | 'public_ip'`, `endpoint: string`, `status: 'online' | 'unresponsive' | 'offline'`, `assignedKeysCount?: number`.

**Métodos en `api` (`api.ts`):**
- `api.testNode(nodeId: string): Promise<{ ok: boolean; status: NodeStatus; latencyMs?: number; error?: string | null }>`  
  Conectar al botón **Probar nodo** en cada nodo.
- `api.deleteNode(nodeId: string): Promise<{ ok: boolean }>` *(ya existente)*

**Requisitos UI:**
- Añadir botón **Probar nodo** con estado `testing` por fila/tarjeta y feedback inline (`En línea · X ms` o error descriptivo).
- En el flujo/confirmación de **Eliminar nodo**, advertir explícitamente si `assignedKeysCount > 0` que esas claves pasarán a estado `no_node` (fuera de servicio) hasta que se les asigne otro nodo.

---

### 2.3 `ModelsTab.tsx` (`HU-30`)

**Propiedades en `ProviderModelItem` (`types.ts`):**
- `active?: boolean` — Estado global del modelo (`true` activo, `false` deshabilitado).
- `hasCatalogInfo?: boolean` — `true` si el modelo tiene ficha de catálogo/precios de referencia (`models.dev` / `LiteLLM`).
- `modalities?: { input: string[]; output: string[] }` — Incluye modelos no-texto (ej. `embeddings`).
- `releaseDate?: string | null` y `upstreamCreatedAt?: number | null`.

**Métodos en `api` (`api.ts`):**
- `api.toggleModel(fullId: string, active: boolean): Promise<ProviderModelItem>`  
  Conectar al interruptor **Habilitar / Deshabilitar modelo** (solo visible/operable para `admin`, pasando o leyendo el rol desde `App`/props si aplica).
- `api.getModels(): Promise<ProviderModelItem[]>` *(ya existente)*

**Requisitos UI:**
- **No** descartar silenciosamente los modelos con `active === false` cuando el admin los esté gestionando (o añadir filtro/vista «Todos / Activos / Deshabilitados» para que el admin pueda reactivarlos).
- Permitir ver y alternar modelos no-texto (como `embeddings`) en el catálogo sin ocultarlos.
- Mostrar un distintivo o indicador visual cuando `model.hasCatalogInfo` sea `true` (y diferenciarlo cuando sea `false`).
- Corregir `formatReleaseDate`: validar que el timestamp convertido sea razonable (p. ej. año `>= 2018`) para evitar fechas corruptas como `1993-04-26`, mostrando `'No reportada'` en su lugar.

---

### 2.4 `UsersTab.tsx` (`HU-31`, `HU-33`, `HU-35`)

**Propiedades ya disponibles en `types.ts`:**
- `ManagedUserItem.enforceStrictQuota?: boolean`
- `InvitationItem.enforceStrictQuota?: boolean`
- `CreateInvitationInput.enforceStrictQuota?: boolean`
- `ManagedUserItem.allowedModels: string[]` / `InvitationItem.allowedModels: string[]`

**Métodos en `api` (`api.ts`):**
- `api.deleteInvitation(invitationId: string): Promise<{ ok: boolean }>`  
  Conectar al botón **Eliminar** en la lista de invitaciones pendientes.
- `api.createInvitation(input: CreateInvitationInput)` *(ya existente; incluir `enforceStrictQuota` en el payload)*.
- `api.updateUserQuotaAndModels(userId, { dailyTokenLimit, quotaResetMode, enforceStrictQuota, allowedModels })` *(ya existente; incluir `enforceStrictQuota` en el payload)*.

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
- `api.createKey(name: string, expiresAt?: number | null): Promise<CreateKeyResponse>` *(o parámetro equivalente de expiración)*

**Requisitos UI:**
- Añadir selector opcional de vencimiento en el formulario de creación de API key (ej. *Sin vencimiento*, *7 días*, *30 días*, *90 días* o *Fecha personalizada*).
- Mostrar la fecha de expiración en cada fila/tarjeta de clave y un estado visual claro de **Expirada** cuando `expiresAt` sea menor o igual al tiempo actual.
- Si están disponibles `usedTokens` / `requestsCount` (o enlace directo a `MetricsTab` filtrado por API key), mostrarlos de forma compacta con `tabular-nums`.

---

### 2.6 `MetricsTab.tsx` (`HU-34`, `HU-37`)

**Tipos en `types.ts`:**
- `ActivityGroupBy = 'model' | 'provider' | 'user' | 'apiKey'`
- `SpeedMetricsData` (`ModelSpeedEntry`: `ttftMs: PercentileTuple`, `tokensPerSec: PercentileTuple`)

**Métodos en `api` (`api.ts`):**
- `api.getMetricsActivity(range: ActivityRange, groupBy: ActivityGroupBy): Promise<ActivityMetricsData>` *(ya existente; soporta `groupBy = 'apiKey'` además de `'model' | 'provider' | 'user'`)*.

**Requisitos UI:**
- **Corrección de tabla/chips de percentiles (`HU-34`):** separar visualmente la etiqueta (`P50`, `P75`, `P90`, `P95`, `P99`) del valor numérico en `tokensPerSec` y `ttftMs` (ej. gap/espaciado entre `<strong>{s.label}</strong>` y el valor, usar `tabular-nums` / `.mono`, formato `toLocaleString('es-ES', { maximumFractionDigits: 1 })` y unidad explícita `tok/s` o `ms`).
- **Agrupación por API key y por usuario (`HU-37`):** añadir la opción **Por API key** en el selector de agrupación de actividad (junto a **Por modelo**, **Por proveedor** y **Por usuario**).

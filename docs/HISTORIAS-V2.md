# Historias de Usuario — V2 (`HU-27` a `HU-41`)

Continuación del backlog funcional de Bifrost tras la v1.0.0 (`HU-01` a `HU-26`). Todas las historias siguen el formato de criterios de aceptación verificables y mantienen las garantías de seguridad y arquitectura descritas en [`DECISIONS.md`](DECISIONS.md) y [`ARQUITECTURA.md`](ARQUITECTURA.md).

---

## Prioridad P0 — Operación crítica de claves y nodos

### HU-27 — Claves de proveedor desactivadas por defecto, interruptor activar/desactivar y transición a `no_node`

**Como** administrador de Bifrost,  
**quiero** que las claves de proveedor se creen desactivadas por defecto, poder activarlas o desactivarlas manualmente desde el panel y que pasen automáticamente a estado `no_node` al eliminar su nodo asignado,  
**para** evitar tráfico accidental antes de verificar una clave o nodo y garantizar que ninguna clave opere sin su nodo de salida.

**Criterios de aceptación:**
1. Al crear una clave mediante `POST /api/providers/:id/keys`, la clave se persiste desactivada por defecto (`enabled = false`), sin entrar en rotación del router hasta que el admin la active explícitamente.
2. En la tarjeta del proveedor (`ProviderVaultCard`), cada clave muestra un interruptor de **Activar / Desactivar** que invoca el endpoint correspondiente y actualiza el estado sin recargar la página.
3. El router (`/v1/*` y `/api/playground/chat`) excluye cualquier clave con `enabled = false` durante la selección y failover.
4. Al eliminar un nodo de salida (`DELETE /api/nodes/:id`), todas las claves vinculadas a ese nodo pasan atómicamente a `status = 'no_node'` (con `node_id = null`) y se registra el evento en `system_logs`.
5. Mientras una clave tenga `status = 'no_node'`, no puede enrutar peticiones (nunca hace fallback a la IP del Core) y el panel muestra claramente el badge de fuera de servicio hasta que se le reasigne un nodo válido.

---

### HU-28 — Botón «Probar nodo»

**Como** administrador,  
**quiero** un botón **Probar nodo** en la vista de nodos de salida,  
**para** comprobar bajo demanda si el túnel `HTTP CONNECT` y el agente del nodo responden correctamente y medir su latencia antes de asignarle claves.

**Criterios de aceptación:**
1. Cada fila o tarjeta de nodo en `NodesTab` incluye un botón **Probar nodo** con estado de carga mientras dura la comprobación.
2. Al pulsarlo, el Core ejecuta una verificación activa del nodo (conectividad del túnel y estado de salud del agente) sin exponer tokens ni secretos al frontend.
3. La UI muestra el resultado inmediato: éxito con latencia medida (`ms`) y actualización del estado (`online`), o error descriptivo (`unresponsive` / `offline` y causa resumida).
4. El resultado de la prueba queda registrado en `system_logs` bajo la categoría `node` cuando se detecta un fallo o cambio de estado.

---

### HU-29 — Botón «Probar clave»

**Como** administrador,  
**quiero** un botón **Probar clave** junto a cada clave de proveedor,  
**para** validar que la credencial es aceptada por el proveedor upstream a través de su nodo asignado antes de activarla en producción.

**Criterios de aceptación:**
1. Cada clave en `ProviderVaultCard` dispone de un botón **Probar clave** (deshabilitado si la clave está en estado `no_node`, indicando que requiere nodo asignado).
2. Al pulsarlo, el Core envía una petición ligera de verificación (por ejemplo, listado de modelos o petición mínima) enrutada obligatoriamente por el `nodeId` de esa clave.
3. Si el upstream responde correctamente, la UI muestra confirmación con latencia (`ms`) y limpia `lastError`; si falla (`401`, `403`, `429`, timeout o error de red), actualiza `status` / `lastError` y muestra el motivo legible al admin.
4. Probar una clave no la activa automáticamente si estaba desactivada; el admin mantiene el control explícito del interruptor.

---

## Prioridad P1 — Catálogo, usuarios, telemetría y diagnóstico

### HU-30 — Activar/desactivar modelos globalmente, indicador de ficha de catálogo y saneamiento de fechas

**Como** administrador,  
**quiero** habilitar o deshabilitar modelos individualmente (incluidos modelos no-texto como *embeddings*), ver si cuentan con ficha de catálogo enriquecida y evitar fechas corruptas en la ficha,  
**para** controlar con precisión qué modelos expone Bifrost y ofrecer información fiable en el catálogo.

**Criterios de aceptación:**
1. `ModelsTab` permite a los administradores activar o desactivar cualquier modelo del catálogo (incluyendo modelos de `embeddings` u otras modalidades no-texto), persistiendo el campo `active` en el servidor.
2. Los modelos deshabilitados (`active = false`) dejan de estar disponibles en `/v1/models`, `/v1/chat/completions`, `/v1/embeddings` y Playground para usuarios finales; el admin puede seguir viéndolos (con filtro/estado) para reactivarlos.
3. Cada modelo expone un indicador booleano `hasCatalogInfo` que permite mostrar en la UI un distintivo claro cuando el modelo dispone de ficha canónica/precios de referencia en el catálogo (`models.dev` / `LiteLLM`), diferenciándolo de los modelos sin metadatos externos.
4. El formateo de fecha de lanzamiento (`releaseDate` / `upstreamCreatedAt`) descarta o marca como «No reportada» timestamps corruptos o fuera de rango razonable (como `1993-04-26`, p. ej. fechas anteriores a `2018-01-01` o valores `0`/negativos mal escalados).

---

### HU-31 — Eliminar invitaciones pendientes

**Como** administrador,  
**quiero** eliminar o revocar invitaciones pendientes desde la pestaña de usuarios,  
**para** invalidar enlaces de acceso que ya no deben utilizarse y mantener limpia la lista de invitaciones.

**Criterios de aceptación:**
1. En `UsersTab`, cada invitación pendiente (no usada y no expirada) muestra un botón **Eliminar** (con confirmación o acción directa segura).
2. Al confirmar, se invoca `DELETE /api/invitations/:id`, la invitación desaparece de la lista inmediatamente y cualquier intento posterior de aceptarla en `/?invite=...` devuelve error HTTP `404`/`410`.
3. Las invitaciones ya utilizadas no se ven afectadas en los registros de usuarios existentes.

---

### HU-32 — Registro de errores de Playground y Upstream en `system_logs`

**Como** administrador,  
**quiero** que los errores ocurridos en el Playground y en las llamadas hacia proveedores upstream queden registrados en `system_logs`,  
**para** diagnosticar fallos de modelos, límites o respuestas inválidas desde la pestaña de Logs sin revisar archivos del servidor.

**Criterios de aceptación:**
1. Todo error devuelto por el upstream o producido durante una ejecución en `/api/playground/chat` o en el router `/v1/*` genera una entrada en `system_logs` con nivel `error` o `warn` y categoría identificable (`failover`, `system` o `playground`).
2. El campo `meta` del log incluye contexto útil para depuración (modelo, proveedor, código HTTP, `keyId` enmascarado o `nodeId`), garantizando que **nunca** se registren claves en texto plano ni el contenido privado de los prompts.
3. Los registros son consultables desde `LogsTab` mediante los filtros existentes de nivel, categoría y búsqueda de texto.

---

### HU-33 — Buscador de modelos en modales de invitaciones y edición de usuarios

**Como** administrador,  
**quiero** un campo de búsqueda dentro de los modales de creación de invitación y edición de usuario al seleccionar `allowedModels`,  
**para** localizar rápidamente modelos concretos cuando hay decenas o cientos sincronizados.

**Criterios de aceptación:**
1. Tanto el modal **Nueva invitación** como el modal **Editar usuario** en `UsersTab` incluyen un input de búsqueda sobre la lista de modelos disponibles (cuando no está marcado «Todos los modelos (`*`)»).
2. La búsqueda filtra en tiempo real por `fullId`, `name` o `providerId` (insensible a mayúsculas/minúsculas).
3. Los modelos ya seleccionados conservan su estado de selección aunque queden temporalmente ocultos por el filtro de búsqueda.

---

### HU-34 — Corrección de formato numérico en tabla de percentiles (`MetricsTab`)

**Como** usuario o administrador que consulta las métricas de velocidad,  
**quiero** que los valores de percentiles (`P50`–`P99`) en `MetricsTab` se muestren correctamente separados, alineados y formateados,  
**para** leer sin ambigüedad los valores de `tok/s` y latencia TTFT (`ms`).

**Criterios de aceptación:**
1. En las tarjetas/tabla de percentiles de `MetricsTab`, existe separación visual clara entre la etiqueta del percentil (`P50`, `P75`, `P90`, `P95`, `P99`) y su valor numérico (sin concatenaciones como `P5045.2` o `P50120ms`).
2. Todos los valores numéricos usan tipografía tabular (`tabular-nums` / clase `mono`), formato localizado (`es-ES`) y unidades explícitas (`tok/s` para throughput, `ms` para TTFT).
3. El renderizado mantiene legibilidad tanto en escritorio como en pantallas estrechas sin desbordar las celdas ni los *tooltips*.

---

### HU-35 — Interruptor de cuota estricta (`enforceStrictQuota`) en invitaciones y usuarios

**Como** administrador,  
**quiero** configurar el interruptor de **cuota estricta** (`enforceStrictQuota`) tanto al crear una invitación como al editar un usuario existente,  
**para** decidir si el consumo se corta en vivo durante el streaming al alcanzar el límite diario o si solo se valida antes de iniciar la petición.

**Criterios de aceptación:**
1. El modal **Nueva invitación** en `UsersTab` incluye un interruptor/checkbox **Cuota estricta** (activado por defecto, `true`) que envía `enforceStrictQuota` en `POST /api/invitations`.
2. El modal **Editar usuario** muestra el valor actual de `enforceStrictQuota` del usuario y permite modificarlo mediante `PATCH /api/users/:id`.
3. En la tabla de usuarios e invitaciones se indica visualmente cuando un usuario/invitación tiene cuota estricta activa frente a cuota flexible.

---

## Prioridad P2 — API keys con expiración y analítica granular

### HU-36 — Fecha de vencimiento en API keys internas (`sk-bf-...`)

**Como** usuario o administrador,  
**quiero** poder asignar una fecha de vencimiento opcional al crear una API key interna (`sk-bf-...`),  
**para** emitir credenciales temporales para scripts, pruebas o integraciones acotadas en el tiempo.

**Criterios de aceptación:**
1. El formulario de creación en `ApiKeysTab` ofrece un selector opcional de expiración (sin vencimiento o fecha/plazo configurable, p. ej. 7 días, 30 días, 90 días o fecha personalizada).
2. El backend almacena `expiresAt` (timestamp UTC) en la tabla de API keys internas y lo devuelve en `GET /api/keys` y `POST /api/keys`.
3. Cualquier petición a `/v1/*` con una API key cuyo `expiresAt <= now` es rechazada con HTTP `401` (`API key expired`).
4. En `ApiKeysTab`, cada clave muestra su fecha de expiración (o «Sin vencimiento») y un estado visual diferenciado si ya expiró.

---

### HU-37 — Métricas de consumo por API key y por usuario

**Como** administrador (y usuario para sus propias claves),  
**quiero** consultar el consumo de tokens y peticiones desglosado por **API key** y por **usuario**,  
**para** identificar qué cliente, integración o cuenta está consumiendo la cuota disponible.

**Criterios de aceptación:**
1. El backend registra el `apiKeyId` asociado a cada petición autenticada con `sk-bf-...` en la telemetría de uso.
2. `GET /api/metrics/activity` acepta `groupBy=apiKey` además de `model`, `provider` y `user`.
3. `MetricsTab` incluye la opción **Por API key** en el selector de agrupación de actividad (y mantiene **Por usuario** para administradores), mostrando `promptTokens`, `completionTokens`, `reasoningTokens`, `totalTokens` y `requestsCount`.
4. Opcionalmente, `ApiKeysTab` muestra el consumo acumulado o reciente asociado a cada clave interna.

---

### HU-40 — Indicadores de confianza, retención de datos (ZDR) y privacidad en marketplace, proveedores y modelos

**Como** usuario o administrador de Bifrost,  
**quiero** visualizar de forma clara la política de retención de datos (*Zero Data Retention* / ZDR), entrenamiento con prompts y enlace a la política oficial en el marketplace, en los proveedores instalados y en cada modelo,  
**para** tomar decisiones informadas antes de enviar prompts sensibles a un proveedor o agregador.

**Criterios de aceptación:**
1. El esquema de `ProviderManifest` soporta metadatos opcionales `privacy` con: `retention` (`'zero' | 'transient' | 'retained' | 'variable'`), `training` (`'never' | 'opt_out' | 'allowed' | 'unknown'`), y campos opcionales `retentionDays`, `policyUrl` y `note`.
2. En el Marketplace, cada tarjeta de proveedor muestra su distintivo de privacidad/ZDR (por ejemplo: *ZDR estricto* para `'zero'`, *Retención temporal* para `'transient'`, *Sin ZDR / Retiene prompts* para `'retained'`, *Variable* para agregadores como OpenRouter) junto con el enlace a `policyUrl` cuando esté disponible.
3. En la bóveda de proveedores (`ProviderVaultCard`), los proveedores instalados/activos que retienen prompts (`retention === 'retained'`) o permiten entrenamiento (`training === 'allowed'` u `'opt_out'`, como NVIDIA NIM free-tier) muestran un distintivo/tooltip de advertencia visible.
4. En `ModelsTab`, cada modelo muestra el indicador de privacidad/ZDR de su proveedor (`providerPrivacy` / `privacy`) para que los usuarios conozcan el tratamiento de datos antes de enrutar prompts.
5. Para agregadores o routers como OpenRouter (`retention: 'variable'`), la interfaz explica explícitamente mediante nota/tooltip (`InfoTip` o texto contextual) que la retención y el entrenamiento dependen del proveedor/modelo upstream subyacente seleccionado.

---

### HU-41 — Detección de actualizaciones desde GitHub y publicación automatizada en GHCR

**Como** administrador de Bifrost,  
**quiero** que el panel detecte automáticamente si existen nuevas versiones o commits publicados en GitHub y que cada release o cambio en `main` genere una imagen Docker verificada en GHCR,  
**para** mantener mi instancia actualizada de forma segura, con instrucciones adaptadas a mi modo de ejecución (`docker` o `native`) y sin riesgo de perder los datos persistentes (`/app/data`).

**Criterios de aceptación:**
1. **Capa 1 — Detección y aviso en el panel:**
   - El backend consulta GitHub (`sxamx/bifrost`, rama `main` / releases) mediante `GET /api/system/update-status`, cacheando el resultado durante **6 horas** y soportando `?refresh=1` para comprobación bajo demanda.
   - Compara la versión y commit actuales en ejecución (`version` + `buildCommit`) contra el último commit/publicación remota, detecta `runtimeMode` (`'docker' | 'native'`) y devuelve el estado tipado (`SystemUpdateStatus`).
   - En el panel (solo visible para usuarios con rol `admin`), cuando `updateAvailable === true`, se muestra un banner/tarjeta sutil de actualización en `OverviewTab` (o barra superior) con enlace al commit remoto, botón **Comprobar ahora** (`refresh=true`) y comando copiable adaptado al `runtimeMode` (`docker compose pull && docker compose up -d` para Docker o `git pull && npm run build` para ejecución nativa).
2. **Capa 2 — Publicación automatizada y segura en GHCR:**
   - El flujo de GitHub Actions ejecuta la compilación (`build`) y la suite completa de pruebas (`tests`) antes de publicar; la imagen `ghcr.io/sxamx/bifrost` solo se construye y publica si todas las pruebas pasan.
   - Los datos del usuario, base de datos y configuración (`/app/data`) permanecen completamente separados de la imagen Docker (montados mediante volumen externo), garantizando actualizaciones limpias sin pérdida ni sobreescritura de datos.

---

## Prioridad P3 — Planificado / Documentado (Cuotas adaptativas y Marketplace)

### HU-38 — Metadatos de límite en el marketplace (`bifrost-providers`)

**Como** mantenedor del marketplace y usuario de Bifrost,  
**quiero** que los manifiestos de proveedores en `bifrost-providers` declaren el tipo de límite de su capa gratuita (`none` / `requests` / `tokens`),  
**para** que Bifrost interprete correctamente la cuota de cada proveedor sin suposiciones erróneas.

**Criterios de aceptación (planificado):**
1. El esquema de `ProviderManifest` incorpora un campo opcional de metadatos de cuota (por ejemplo `rateLimitKind: 'none' | 'requests' | 'tokens'` y ventanas soportadas).
2. Los manifiestos existentes y nuevos en `bifrost-providers` pueden declarar si el proveedor no aplica cuota fija (`none`), limita por número de peticiones (`requests`) o limita por volumen de tokens (`tokens`).
3. El panel muestra esta clasificación en la ficha del proveedor instalado y la utiliza como entrada para el medidor de cuota.

---

### HU-39 — Algoritmo adaptativo de detección de límites por ventana (hora / día / semana)

**Como** usuario de Bifrost,  
**quiero** que el medidor de cuota se adapte automáticamente a límites por hora, día o semana combinando el manifiesto, las cabeceras HTTP `x-ratelimit-*` y la telemetría real de errores `429`,  
**para** obtener una estimación precisa de la cuota restante aunque el proveedor no publique límites uniformes diarios.

**Criterios de aceptación (planificado):**
1. El motor de cuotas evalúa tres señales por orden de fiabilidad: (a) cabeceras `x-ratelimit-remaining` / `x-ratelimit-reset` devueltas por el upstream, (b) metadatos declarados en el manifiesto (`HU-38`) y tope manual de la clave, y (c) detección adaptativa tras respuestas `429` observadas en ventanas móviles de **hora**, **día** y **semana**.
2. Cuando un proveedor cambia su ventana de reinicio o impone un techo menor al configurado manualmente, el algoritmo ajusta la estimación de capacidad disponible por ventana y registra el ajuste en telemetría interna.
3. El bloque «Cuota gratuita» en `OverviewTab` / `MetricsTab` indica la ventana activa detectada (`hora`, `día` o `semana`) y el nivel de confianza de la estimación (exacto por cabecera, configurado o inferido).

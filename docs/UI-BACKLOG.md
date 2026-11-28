# Backlog de UI — Bifrost Panel

Registro vivo de tareas pendientes de interfaz (`panel/`) y decisiones de producto en espera.

> **Regla permanente:** Todo PR de Backend que modifique contratos de API o requiera cambios visuales **debe actualizar este archivo** en el mismo PR. Las tareas de UI se implementan únicamente en olas dedicadas de UI, sin mezclar cambios de componentes con PRs de Backend.

---

## Decisiones ya cerradas (NO cambiar)

- **Selector único de salida (`Sin nodo` / `Máquina principal` / `Nodo externo`) y `Sin nodo` por defecto:** reemplaza el botón separado `Desactivar clave`. Al crear una clave nueva desde el panel, se crea por defecto en `Sin nodo` (`egressMode: 'none'`, `status: 'no_node'`, `nodeId: null`), bloqueando el 100 % de las operaciones salientes (`/v1/chat/completions`, `/v1/embeddings`, `POST .../test` y `syncProviderModels` / `detect-models`). Seleccionar `Máquina principal` (`egressMode: 'direct'`) o `Nodo externo` (`egressMode: 'node'` + `nodeId`) activa el tráfico por esa salida; volver a `Sin nodo` (`egressMode: 'none'`) detiene todo tráfico saliente.
- **Contexto de error en Playground:** mantener el comportamiento actual sin cambios.
- **Visibilidad de `uptime` y `speed` para invitados:** mantener ambas métricas visibles para usuarios invitados por ahora.

---

## UI-1 — Prioridad Alta

| ID | Área / Archivo | Descripción técnica |
| --- | --- | --- |
| `UX-NODE-01` | `ProviderVaultCard` / `ProvidersTab` | Reemplazar el botón separado `Desactivar clave` por un selector único de salida (`Sin nodo` / `Máquina principal` / `Nodo externo`) consumiendo `key.egressMode` (`'none' \| 'direct' \| 'node'`), `api.setKeyEgress(providerId, keyId, { egressMode, nodeId?, confirmForce? })` (sobre `PATCH /api/providers/:id/keys/:keyId/node`) y el default de `api.addProviderKey` (`egressMode: 'none'`, `status: 'no_node'`). Mantener el flujo de confirmación `409 NODE_PROVIDER_COLLISION` al elegir `Nodo externo`, deshabilitar/indicar bloqueo en la acción «Probar clave» cuando `egressMode === 'none'` o `status === 'no_node'`, y mostrar claramente el estado de nodo offline cuando `egressMode === 'node'` y `status === 'no_node'`. |
| `LOG-01` | `OverviewTab` | Eliminar el fallback que mezcla unidades `tokens` y `peticiones` al resumir cuota; respetar unidades homogéneas y estados `null`. |
| `LOG-05` | `MetricsTab` | Respetar estrictamente valores `null` (sin datos) en percentiles, uptime y caché; nunca renderizar `null` como `0` o `0%`. |
| `UI-02` | `panel/public/sw.js` | Endurecer el Service Worker PWA para manejar actualizaciones, fallos de red y respuestas no cacheables de forma robusta sin dejar la SPA bloqueada. |
| `UI-03` | `ModelsTab` | Usar coincidencia exacta al resolver/seleccionar modelos para evitar colisiones por subcadenas parciales. |
| `UI-04` | `CompareTab` | Preservar la selección actual de modelos del usuario cuando falle una petición o recarga, en lugar de borrar la comparación. |
| `NEM-04` | Benchmarks / Epoch AI | Mostrar la métrica `ECI` de Epoch AI y normalizar correctamente escalas `0..1` a porcentaje `0..100%`. |
| `LIC-01..05` | Pie de benchmarks y catálogo | Aplicar cumplimiento **mínimo exacto** en la misma línea de pie (sin banners intrusivos): enlace clicable `CC BY 4.0`, cita de 1 línea para Epoch AI, **OpenCharts solo enlace directo sin etiqueta `CC BY 4.0`**, y enlace a `models.dev`. |
| `SEC-13` | Enlaces externos | Implementar y aplicar un helper `safeExternalHref` para validar URLs externas (`http:`/`https:`) provenientes de manifiestos y metadatos antes de renderizar enlaces `href`. |
| `BF-02` | Actualización de manifiestos | Mostrar diálogo de confirmación explícita al actualizar un manifiesto instalado cuando el cambio altere campos sensibles (`baseUrl`, `auth` o `sourceId`). |
| `BF-07` | `BackupsTab` | Añadir campo de reautenticación de contraseña de administrador al exportar respaldos que incluyan claves/credenciales cifradas. |

---

## UI-2 — Prioridad Media

| ID | Área / Archivo | Descripción técnica |
| --- | --- | --- |
| `LOG-11` | `OverviewTab` | Eliminar sparklines ficticios/sintéticos y mostrar únicamente datos reales o estado vacío limpio. |
| `LOG-12` | Cuotas / `OverviewTab` | Mostrar de forma explícita `00:00 UTC` en reinicios diarios y `Sin límite fijo` cuando no exista techo configurado/inferido. |
| `LOG-17` | `NodesTab` | Mostrar `tlsFingerprint` y `publicIpWarning` para nodos en modo `public_ip` en el alta y detalle del nodo. |
| `LOG-13` | `UsersTab` | Soportar y mostrar claramente cuota ilimitada (`dailyTokenLimit: null`) al crear/editar y listar usuarios. |
| `LOG-14` | Playground | Indicar claramente cuando un modelo está deshabilitado y añadir botón de cancelar generación en curso (`AbortController`). |
| `LOG-15` | `BackupsTab` y `App.tsx` | Añadir nota informativa indicando que el historial del Playground no se incluye en respaldos y ejecutar refresco completo de estado en `App.tsx` tras restaurar un respaldo. |
| `LOG-16` | Formularios | Reforzar validaciones del lado cliente antes de enviar peticiones (campos obligatorios, rangos numéricos, formatos de endpoint/URL). |
| `UI-05` | `LogsTab` | Corregir paginación de logs y limpiar/manejar correctamente el estado anterior cuando ocurre un error de consulta. |
| `UI-06` | `TechTerm` | Mejorar posicionamiento y experiencia táctil de `TechTerm` en móvil y corregir conflictos de `z-index`. |
| `UI-07` | `InfoTip` y modales | Cerrar `InfoTip` al presionar `Escape` y gestionar correctamente foco y cierre accesible en modales. |
| `UI-08` | `panel/index.html` / PWA iOS | Configurar `apple-mobile-web-app-status-bar-style` con `black-translucent` y ajustar áreas seguras (`safe-area-inset`). |
| `UI-09` | Responsive móvil | Corregir desbordamientos horizontales (*overflow*) en tablas, tarjetas y barras de acción en pantallas estrechas. |
| `UI-10` | `App.tsx` / Paleta `⌘K` | Deshabilitar el atajo `⌘K` en la pantalla de inicio de sesión y reiniciar completamente el estado local al cerrar sesión (logout). |

---

## UI-3 — Prioridad Baja / Limpieza

| ID / Referencia | Ubicación | Descripción técnica |
| --- | --- | --- |
| Referencias residuales `bifrost-providers` (6) | `panel/src/App.tsx:1303`, `panel/src/components/OnboardingCard.tsx:36`, `panel/src/components/ProvidersTab.tsx:552,627,754,1010` | Reemplazar las 6 referencias heredadas a `bifrost-providers` por `mazzapata/providers`. |
| `LOG-18`–`LOG-20` | Vistas de métricas y logs | Ajustes menores de consistencia en etiquetas, unidades y formatos de visualización. |
| `UI-11`–`UI-14` | Panel general | Pulido visual menor, espaciado y consistencia tipográfica/semántica (siempre sin `cursor: help`). |
| Texto sin traducir `"Updated ..."` | `panel/src/components/ModelBenchmarksPanel.tsx:1034` | Unificar texto `"Updated ..."` al español coherente con el resto del panel. |

---

## UI-FUTURO — Decisiones en standby (NO implementar sin diseñar antes con el dueño)

> **IMPORTANTE:** Ninguno de los siguientes puntos debe implementarse sin una definición de diseño y aprobación previa del dueño del repositorio.

- **Límite opcional de peticiones por minuto/hora (`RPM` / `RPH`) para invitados:** diseño de configuración por usuario invitado + gráfico de peticiones totales.
- **Retención configurable de métricas e indicador de recursos:** selector de retención (`30` / `90` / `120` días / `Ilimitado`) + indicador de uso de espacio en disco y RAM pensado para despliegues en VM de 1 GB de RAM.
- **Documentación integrada / guía rápida «Cómo conectar clientes»:** sección en el panel con ejemplos claros para configurar clientes compatibles con OpenAI usando `sk-bf-...`.

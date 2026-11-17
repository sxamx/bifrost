# Orden de implementación

Cada historia de `docs/HISTORIAS.md` es una unidad que se puede pedir por separado: "haz la HU-06". Este documento dice en qué orden conviene pedirlas y qué bloquea a cada una. Para cada historia hay que leer también `docs/ARQUITECTURA.md`, `docs/PROTOCOLO-NODOS.md`, `docs/DECISIONS.md`, `docs/PENDIENTES.md` y `docs/PISTAS.md`.

## Reglas para quien implemente

1. Antes de escribir código, lee la historia completa, sus criterios de aceptación y la sección correspondiente de `docs/ARQUITECTURA.md`.
2. Si la historia depende de un pendiente marcado como abierto en `docs/PENDIENTES.md`, no inventes la respuesta: pregunta o implementa solo la parte desbloqueada.
3. Los datos de catálogos y benchmarks se obtienen de la fuente, nunca se escriben a mano.
4. Los colores y componentes salen de `design/IDENTIDAD.md`. Las maquetas en `design/mockups/` son referencia visual, no código.
5. Ninguna historia se considera terminada sin probar sus criterios de aceptación.

## Fases

### Fase 1: base (100 % desbloqueada)
- **HU-01** Instalación con Docker Compose y `install.sh` + `systemd`. La app arranca vacía.
- **HU-03** Crear la cuenta de admin al instalar.
- **HU-03b** Generar y revocar API keys internas (`sk-bf-...`).
- **HU-26** Arranque automático tras reinicio, validando `master.key`.
- **HU-02** Asistente de primer uso.

### Fase 2: proveedores y claves (100 % desbloqueada para OpenRouter y fichas locales)
- **HU-06** Agregar proveedor desde el marketplace (o ficha local validada contra `schemas/provider.schema.json`).
- **HU-06b** Detectar modelos con la clave del admin (`api` o `static`).
- **HU-06c** Recargar y comparar modelos.
- **HU-07** Guardar clave/cuenta cifrada (`AES-256-GCM`).
- **HU-09** Reintento con otra clave y reanudación de streaming cortado.
- **HU-10** Quitar proveedor o clave.

### Fase 3: nodos de salida (100 % desbloqueada según `docs/PROTOCOLO-NODOS.md`)
- **HU-11** Agregar nodo con comando (`HTTP CONNECT`).
- **HU-11b** Conexión por Tailscale (o IP pública con TLS y advertencia).
- **HU-11c** Rotación de token cada 24 h con ventana de gracia de 5 min.
- **HU-11d** Una clave por nodo, con advertencia al forzar.
- **HU-08** Reparto de claves entre nodos.
- **HU-12** Detección de nodo caído (> 120 s).
- **HU-13** Quitar nodo.

### Fase 4: modelos
- **HU-14** Modelos gratuitos por proveedor. Depende de verificación puntual en `PENDIENTES #6` (NVIDIA NIM, OpenCode Zen y cruce `canonical_model_id` de `models.dev/api.json`).
- **HU-14b** Logos de proveedor automáticos, con colores de la app.
- **HU-14c** Benchmarks en cuatro fuentes públicas. Depende de verificación puntual en `PENDIENTES #20` (Epoch internal runs y `coding-index.json` / `llm-prices.json`).
- **HU-15** Copiar identificador `proveedor/modelo`.
- **HU-16** Actualización automática cada 6 horas en proveedores con `modelsSource: "api"`.

### Fase 5: métricas y logs (100 % desbloqueada)
- **HU-17** Cuota del día en el resumen.
- **HU-18** Latencia por percentiles.
- **HU-18b** Velocidad (TTFT, tok/s) y caché.
- **HU-19** Uptime de 60 días sobre tráfico real.
- **HU-20** Errores de herramientas y salida estructurada.
- **HU-20b** Actividad de tokens (rango de tiempo + agrupación por modelo/proveedor/usuario).
- **HU-20c** Apartado de Logs del sistema y failover para el admin.

### Fase 6: comparar y probar (100 % desbloqueada)
- **HU-21** Comparador de hasta tres modelos.
- **HU-22** Playground con cuota real, TTFT y tok/s.

### Fase 7: marketplace (100 % desbloqueada)
- **HU-23** Explorar e instalar bajo demanda desde `sxamx/bifrost-providers`.
- **HU-24** Publicar ficha o adaptador en `bifrost-providers` validado con `schemas/provider.schema.json`.

### Fase 8: cuenta y respaldos (100 % desbloqueada)
- **HU-04** Invitaciones de un solo uso.
- **HU-05** Asignar modelos y cuota diaria en tokens (UTC en servidor).
- **HU-25** Exportación cifrada `.bifrost.enc` con casillas.
- **HU-25b** Importar y restaurar respaldo `.bifrost.enc`.

## Bloqueos abiertos

| Pendiente | Bloquea |
|---|---|
| #6 / #14 Catálogo de NVIDIA NIM, OpenCode Zen y cruce `models.dev/api.json` | HU-14 (proveedores distintos a OpenRouter) |
| #20 Identificación de runs propios en Epoch AI y verificación `coding-index.json` / `llm-prices.json` | HU-14c |

## Maquetas

Hechas: resumen, métricas, detalle de modelo (con benchmarks), estilos de tarjetas.
Pendientes (`#18`): activity (`HU-20b`), latencia/velocidad (`HU-18b`), logs (`HU-20c`) y pantallas de admin (usuarios, nodos, configuración, respaldos `.bifrost.enc`), más el SVG final de Bifrost.

# Pendientes por aclarar

Preguntas o verificaciones técnicas que siguen abiertas. Lo resuelto ya pasó a `docs/DECISIONS.md`.

## Resueltos recientemente

- **Nombre y repositorios:** `Bifrost` (`sxamx/bifrost` y `sxamx/bifrost-providers`, sin 3er repo de datos).
- **Instalación y arranque (HU-01, HU-26):** Docker Compose (principal) + script `install.sh` con `systemd` para VMs sin Docker.
- **Invitados y API keys internas (HU-03b, HU-04, HU-05):** cada usuario genera sus `sk-bf-...`; el invitado ve modelos asignados, cuota, benchmarks y Playground; reloj 100 % UTC en servidor SQLite.
- **Marketplace (`bifrost-providers`):** instalación bajo demanda; soporte para `official-json` y `experimental-adapter`; gestión de múltiples cuentas dentro de cada integración instalada.
- **Failover y Logs (HU-09, HU-20c):** reintento ante error/cuota, reanudación de respuestas cortadas en streaming y apartado de Logs para el admin.
- **Actualización de modelos (HU-16):** cada 6 horas, solo para proveedores con `modelsSource: "api"`.
- **Uptime (HU-19) y Actividad (HU-20b):** uptime sobre tráfico real (≥ 99 % verde, 95–99 % ámbar, < 95 % rojo); selector de actividad por rango de tiempo y agrupación por modelo/proveedor/usuario.
- **Exportación e Importación (HU-25, HU-25b):** archivo único `.bifrost.enc` (`gzip` + `AES-256-GCM`).
- **Esquemas y protocolos (antes ítems 15 y 16):** definidos en `schemas/provider.schema.json`, `schemas/model.schema.json` y `docs/PROTOCOLO-NODOS.md`.

## Abiertos (verificaciones técnicas antes de Fase 4)

6. **Catálogo de modelos (HU-14, HU-16):** OpenRouter está confirmado. Falta verificar cómo exponen su catálogo y cuotas gratuitas **NVIDIA NIM** y **OpenCode Zen** (y otros proveedores iniciales del marketplace), y comprobar en vivo el cruce `canonical_model_id` de `models.dev/api.json` contra OpenRouter (`docs/PISTAS.md`).
14. **Precios de referencia sin catálogo:** decidir si en proveedores `static` sin cruce en `models.dev/api.json` se muestra precio `0` (gratis), precio manual en la ficha o `"No disponible"`.
20. **Benchmarks — verificación puntual de fuentes (HU-14c):**
   - Confirmar cómo identificar programáticamente las filas de *internal runs* en los CSV de **Epoch AI**.
   - Revisar la licencia de `coding-index.json` y `llm-prices.json` de **ArtificialWatch** (análogo a `bench-index.json`).
   - Detalles en `docs/investigacion/matriz-derechos-por-campo-2026-11-14.md`.

## Diseño pendiente (no bloquea Fases 1–3)

18. **Mockups de admin y logo final:** pantallas de usuarios/invitaciones, nodos, logs del sistema, configuración e importar/exportar respaldo `.bifrost.enc`, más la integración del SVG final de Bifrost.

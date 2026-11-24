# Decisiones

## Decidido

- **Nombre oficial:** **Bifrost** (repositorios en GitHub: `sxamx/bifrost` para la app principal y `mazzapata/providers` para el marketplace).
- **Repos separados:** solo 2 repositorios (app + marketplace). Sin tercer repositorio de datos; cada instancia de Bifrost descarga y cachea en SQLite directamente desde las fuentes abiertas verificadas.
- **Instalación oficial y autoarranque (HU-01, HU-26):** soportar **ambos** métodos — **Docker Compose** como opción principal recomendada, y script `install.sh` con servicio `systemd` para VMs Linux sin Docker.
- **Enfoque:** cuotas gratuitas (*free tier*), self-hosted, open-source bajo licencia **MIT**.
- **Stack técnico:** TypeScript en todo el proyecto. Núcleo con **Hono** sobre Node.js. Panel en **React + Vite** (el núcleo sirve el panel ya compilado, sin segundo servidor). Base de datos **SQLite**.
- **Seguridad y criptografía:**
  - Claves de proveedores y credenciales de cuentas cifradas en SQLite con `AES-256-GCM` usando la llave maestra del servidor (`BIFROST_MASTER_KEY` en archivo de configuración con permisos `0600`).
  - Contraseñas de usuarios con `scrypt`.
  - API keys internas (`sk-bf-...`) almacenadas como hash `SHA-256` (solo se muestra el prefijo tras su creación).
  - Exportación de respaldos en archivo único `.bifrost.enc` (`JSON` + `gzip` + `AES-256-GCM` con contraseña definida al exportar) e importación/restauración en otra instancia (`HU-25b`).
- **Usuarios, invitaciones y API keys internas:**
  - El admin crea enlaces de invitación de un solo uso; el invitado define usuario y contraseña (sin correo).
  - Cada usuario (admin o invitado) crea sus propias **API keys internas (`sk-bf-...`)** para usar en clientes compatibles con OpenAI.
  - El invitado ve en el panel sus modelos asignados, su cuota, benchmarks y Playground; nunca ve claves reales, nodos, usuarios, logs del sistema ni respaldos.
- **Cuotas y control anti-manipulación:**
  - Cuota de invitados configurable por el admin en **tokens diarios** (reinicio a `00:00 UTC` o ventana móvil de 24 h).
  - El conteo y el reloj corren **100 % en el servidor** (SQLite + reloj UTC del servidor); los cambios de hora en el cliente no afectan el límite.
  - Bloque principal "Cuota gratuita de hoy" (`HU-17`): se calcula sobre el tope diario configurable por clave + lectura de cabeceras `x-ratelimit-*` cuando el proveedor las envíe.
- **Marketplace (`mazzapata/providers`):**
  - Repo público en GitHub revisado por el dueño (y colaboradores designados).
  - Las integraciones **no** se instalan automáticamente; el usuario explora el catálogo e instala solo las que desea.
  - Dos tipos de paquete:
    1. `official-json`: ficha declarativa para APIs oficiales (cero código ejecutable).
    2. `experimental-adapter`: adaptador/sidecar aislado que expone un endpoint compatible con OpenAI para integraciones no estándar, claramente etiquetado como experimental.
  - Dentro de cada integración instalada en el panel, el usuario puede registrar **una o varias cuentas/claves** (cifradas y repartidas por IP/nodos).
- **Detección y actualización de modelos:**
  - Fichas con origen declarado: `api` (detectados con la clave/cuenta del usuario) o `static` (lista fija con fecha de revisión).
  - Actualización automática en segundo plano **cada 6 horas**, aplicando **únicamente** a los proveedores instalados que soporten catálogo dinámico (`modelsSource: "api"`).
- **Nodos de salida y protocolo:**
  - Conexión preferida por **Tailscale**. Si no hay Tailscale, se acepta **IP pública** (con TLS y advertencia al admin).
  - Túnel TCP `HTTP CONNECT` autenticado con token rotativo por nodo (rotación cada 24 h con ventana de gracia de 5 min; sin respuesta > 120 s → `sin respuesta`).
  - El nodo solo reenvía tráfico ya cifrado; **nunca ve claves en texto plano ni el contenido de las peticiones**.
  - Reparto de claves: cada clave/cuenta queda asignada a un solo nodo. Si el admin fuerza otro nodo, aparece una advertencia que debe confirmar.
- **Failover y Logs del sistema:**
  - Ante cuota agotada (`429`) o error de red/proveedor, la petición se reintenta automáticamente con otra clave del mismo proveedor.
  - Si una respuesta en streaming se corta a mitad de generación, Bifrost intenta reanudarla con otra clave del mismo proveedor.
  - **Logs (`HU-20c`):** apartado dedicado en el panel para el admin que registra errores de clave, failovers, reanudaciones de streaming, caídas de nodos y eventos del sistema (sin exponer secretos).
- **Uptime, métricas y actividad:**
  - Uptime de 60 días (`HU-19`): basado en **peticiones reales** (sin pings automáticos para no gastar cuota). Verde ≥ 99 %, ámbar 95–99 %, rojo < 95 %, gris sin tráfico.
  - Velocidad (`HU-18b`): TTFT y tokens/s en percentiles (`P50, P75, P90, P95, P99`), más tasa de aciertos de caché, calculados desde telemetría propia.
  - Actividad (`HU-20b`): volumen de tokens separado en `prompt`, `completion` y `reasoning`, con selector por **rango de tiempo** y agrupación/filtro por **modelo, proveedor o usuario**.
- **Catálogo, precios y benchmarks:**
  - Catálogo y precios: `models.dev` (`api.json` para precios/proveedores y `models.json` para ficha canónica, licencia MIT) + contraste con `LiteLLM` (MIT).
  - Benchmarks públicos sin clave (regla de falla cerrada de `docs/investigacion/matriz-derechos-por-campo-2026-11-14.md`): **LMArena** (`agent/latest`, CC BY 4.0), **Epoch AI** (solo runs propios, CC BY), **ArtificialWatch** (solo `index` y `percentile` propios, CC BY 4.0) y **OpenCharts** (solo índices propios con enlace).
  - Fuentes excluidas del repo público: Artificial Analysis (cada usuario puede usar su propia clave de forma opcional en uso interno si así se implementa, nunca en repo público), OpenRouter scraping/copia no autorizada, ModelGrep, LLM Stats, PublicAI, Design Arena.
  - Logos de proveedor: automáticos desde `models.dev`, pintados con los colores de la app (`--sub` en modo claro) y cacheados localmente.
- **UI e interacción:**
  - Modo oscuro: después de la primera versión.
  - Playground: pantalla propia usando la cuota real y mostrando tok/s y TTFT.
  - Regla general de interacción: todo elemento con información al pasar el mouse lo indica de forma visible (cambio de color/tono o ícono `ⓘ`) y muestra un mini popup. El popup al clic se reserva para detalle extenso. Prohibido el cursor de ayuda (`?`).

## Pendiente

- Verificar en vivo el cruce `canonical_model_id` de `models.dev/api.json` contra OpenRouter y definir catálogos de NVIDIA NIM y OpenCode Zen (`PENDIENTES #6`, `#14`).
- Resolver los puntos puntuales de licencias en `PENDIENTES #20` (identificador programático de runs propios en Epoch AI y verificación de `coding-index.json` / `llm-prices.json` en ArtificialWatch).
- Integrar el logotipo SVG definitivo de Bifrost cuando esté listo y diseñar los mockups de pantallas de administración (usuarios, nodos, logs, configuración, respaldos).

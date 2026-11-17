# Historias de usuario

Cada historia tiene criterios de aceptación comprobables. Las referencias visuales apuntan a `design/`.

Roles:
- **Admin:** quien instala y administra el router.
- **Usuario invitado:** colega o persona a la que el admin comparte modelos y cuota, sin ver las claves.

---

## 1. Instalación y primer arranque

**HU-01.** Como admin, quiero instalar el router con un comando, para tenerlo andando sin configuración manual.
- Al terminar, el panel responde en el puerto configurado.
- La instalación no trae proveedores ni modelos.

**HU-02.** Como admin, quiero ver un asistente de primer uso, para agregar mi primer proveedor sin leer documentación.
- Con la app vacía, la pantalla de inicio dice qué hacer y ofrece "Agregar proveedor".
- El asistente se oculta cuando existe al menos un proveedor.

## 2. Cuentas y acceso

**HU-03.** Como admin, quiero crear mi cuenta con usuario y contraseña al instalar, para que nadie más administre el router.
- La primera cuenta es admin.
- Sin cuenta, el panel obliga a crearla antes de cualquier otra pantalla.

**HU-03b.** Como usuario (admin o invitado), quiero generar mis propias API keys internas (`sk-bf-...`), para conectar mis editores o scripts al endpoint `/v1/*`.
- El usuario puede crear, nombrar y revocar sus propias API keys internas.
- La clave completa (`sk-bf-...`) se muestra una sola vez al crearse; en BD solo se guarda su hash `SHA-256` y su prefijo.
- El acceso a `/v1/models` y `/v1/chat/completions` respeta los modelos asignados y la cuota del dueño de la key.

**HU-04.** Como admin, quiero invitar a un colega, para que use modelos sin ver mis claves.
- La invitación genera un enlace de un solo uso.
- El invitado ve sus modelos asignados, su cuota, benchmarks y Playground; no ve claves reales de proveedores, nodos, usuarios, logs del sistema ni respaldos.

**HU-05.** Como admin, quiero asignar a cada usuario los modelos que puede usar y una cuota diaria en tokens, para controlar el acceso.
- Un usuario solo ve los modelos asignados.
- La cuota y el reloj se controlan 100 % en el servidor en UTC (los cambios de hora en el cliente no alteran el límite).
- Al agotar su cuota, sus peticiones reciben HTTP `429` con el mensaje y la hora exacta de reposición (`reset_at` en UTC).

## 3. Proveedores y claves

**HU-06.** Como admin, quiero agregar un proveedor desde el marketplace, para no escribir su configuración a mano.
- El catálogo muestra proveedores disponibles sin instalar ninguno automáticamente; el usuario instala solo los que elige.
- Dentro de la integración instalada, el usuario puede registrar una o varias cuentas/claves.
- Sin conexión al catálogo, la app avisa y no se rompe.

**HU-06b.** Como admin, quiero detectar los modelos de un proveedor con mi clave, para no escribirlos a mano.
- Al guardar la clave, aparece el botón "Detectar modelos". Antes de presionarlo, el proveedor no muestra modelos.
- Si el proveedor tiene origen `api`, la lista viene de su catálogo con la clave del admin.
- Si el proveedor tiene origen `static`, la lista viene de la ficha y muestra la fecha de la última revisión.
- Pista técnica: el catálogo de OpenRouter y el filtro de modelos gratuitos están en `docs/PISTAS.md`.

**HU-06c.** Como admin, quiero recargar la lista de modelos, para ver cambios sin volver a configurar nada.
- "Recargar" compara la lista nueva con la actual y muestra un resumen: "2 nuevos, 1 retirado".
- Los modelos retirados salen de la lista, pero los que ya tenían peticiones quedan en el historial.

**HU-07.** Como admin, quiero agregar una clave o cuenta a un proveedor instalado, para usar su cuota gratuita.
- La clave se guarda cifrada con `AES-256-GCM` usando `master.key`.
- Después de guardarla, la pantalla muestra solo los últimos 4 caracteres.

**HU-08.** Como admin, quiero que cada clave quede asignada a un nodo, para que cada clave salga por una IP distinta.
- Con dos claves del mismo proveedor y dos nodos, cada nodo recibe una clave.
- Una clave nueva va al nodo con menos claves de ese proveedor.
- Entre proveedores distintos no hay regla de reparto.

**HU-09.** Como admin, quiero que una clave con error se salte o reanude la respuesta sin afectar a las demás, para que el servicio siga.
- Ante cuota agotada (`429`) o error de red/proveedor antes del primer token, la petición se reintenta automáticamente con otra clave disponible del mismo proveedor.
- Si una respuesta en streaming se corta a mitad de generación, Bifrost intenta reanudarla con otra clave del mismo proveedor usando el contexto acumulado.
- La clave con error aparece marcada en el panel con su motivo y el evento queda registrado en Logs (`HU-20c`).

**HU-10.** Como admin, quiero quitar un proveedor o una clave, para mantener la lista limpia.
- Antes de quitar, la app pide confirmación.
- Las peticiones en curso terminan; las nuevas no usan esa clave.

## 4. Nodos de salida

**HU-11.** Como admin, quiero agregar un nodo con un comando, para sumar una VM como salida.
- El comando de instalación del nodo muestra su token una sola vez.
- El nodo aparece en el panel como "en línea" en menos de un minuto (protocolo `HTTP CONNECT` en `docs/PROTOCOLO-NODOS.md`).

**HU-12.** Como admin, quiero ver si un nodo está caído, para reaccionar antes de que afecte a los usuarios.
- Un nodo sin respuesta al heartbeat por más de 120 segundos cambia a "sin respuesta".
- Sus claves pasan automáticamente a estado "sin servicio" (`no_node`) y se registra en Logs.

**HU-13.** Como admin, quiero quitar un nodo, para retirar una VM.
- Antes de quitarlo, la app muestra qué claves quedarán sin servicio.

**HU-11b.** Como admin, quiero conectar un nodo por Tailscale, para que no tenga puertos abiertos a internet.
- El nodo solo escucha en su dirección de Tailscale.
- Si Tailscale no está instalado, el asistente lo advierte y ofrece la conexión por IP pública sobre TLS.

**HU-11c.** Como admin, quiero que el token de cada nodo rote periódicamente, para que una filtración tenga un plazo limitado.
- La rotación ocurre cada 24 horas sin cortar el servicio: el token anterior sigue válido durante una ventana de gracia de 5 minutos.
- El panel muestra cuándo fue la última rotación.

**HU-11d.** Como admin, quiero que cada clave salga siempre por su propio nodo, para que no se mezclen IPs de salida dentro de un mismo proveedor.
- Por defecto, la clave queda asignada a un solo nodo.
- Si fuerzo otro nodo, aparece una advertencia que debo confirmar, explicando el riesgo de baneo.

## 5. Modelos

**HU-14.** Como admin, quiero ver los modelos gratuitos disponibles en cada proveedor, para elegir cuál usar.
- Cada modelo muestra modalidades, precio, contexto y fecha de lanzamiento.
- Los datos vienen de la API pública del catálogo (`models.dev`), no de texto escrito a mano.

**HU-14b.** Como admin, quiero ver el logo de cada proveedor junto a sus modelos y benchmarks, para reconocerlo de un vistazo.
- El logo se obtiene automáticamente de la fuente de datos (`models.dev`), no se escribe ni se incrusta a mano en el código.
- El logo se pinta con los colores de la app (token `--sub` en modo claro) y se ve bien en modo oscuro cuando exista. No aparece en negro ni en color de otra marca.
- Si el proveedor no tiene logo, se muestra su inicial dentro de un círculo.
- Los logos se guardan en caché local, para que se vean sin internet después de la primera carga.
- Antes de usar logos de terceros en la app, se revisa su licencia (ver `docs/PISTAS.md`).
- Los logos de las fuentes de benchmarks (LMArena, Epoch AI, ArtificialWatch, OpenCharts) son archivos SVG, obtenidos de forma automática y con licencia verificada antes de usarse. La maqueta usa letras mientras tanto.
- Ejemplo de referencia: `design/mockups/detalle-modelo.html` (hoy hardcodeado solo para ver cómo queda; no es el comportamiento final).

**HU-14c.** Como admin, quiero ver los benchmarks de cada modelo desde fuentes públicas y reutilizables, para comparar calidad sin pedir claves.
- Fuentes: LMArena (dataset `agent/latest`, CC BY 4.0), Epoch AI (solo filas de sus propios runs, CC BY), ArtificialWatch (índices y percentiles propios, CC BY 4.0) y OpenCharts (índices y bandas propios, con enlace).
- No se muestran puntajes crudos de terceros que no tengan licencia verificada (ver `docs/investigacion/matriz-derechos-por-campo-2026-11-14.md`).
- LMArena muestra puntaje, intervalo de confianza, sesiones y categoría. Su escala no es Elo ni porcentaje y se muestra tal cual.
- ArtificialWatch muestra el radar de percentiles con la fuente de cada eje. El percentil no es porcentaje de aciertos.
- Al pasar el mouse por una prueba de ArtificialWatch, una columna de LMArena o una fila de cobertura de OpenCharts, aparece un mini popup con lo que mide. Lo mismo para cada término técnico (FLOP, token, percentil, intervalo de confianza): se explica al pasar el mouse, no en otra parte.
- Los popups que se abren al tocar se reservan para detalle que no cabe en el mini popup: cómo se calcula la puntuación de LMArena o la nota de ArtificialWatch, y el grado A de OpenCharts.
- Cada bloque tiene su atribución con enlace y fecha de captura.
- Al tocar un modelo en el ranking, la app lleva a la tabla de ese modelo (su ficha de benchmarks). La maqueta no lo implementa; es requisito para la app.
- Los datos se obtienen de los endpoints públicos sin clave, con caché y manejo de errores (ver `docs/PISTAS.md`).
- Diseño de referencia: `docs/capturas/openrouter-benchmarks/` (patrones visuales) y `design/IDENTIDAD.md`, sección "Patrones de componentes". La maqueta ya muestra las cuatro fuentes públicas.

**HU-15.** Como admin, quiero copiar el identificador de un modelo en formato `proveedor/modelo`, para usarlo en mis programas.
- El identificador aparece arriba del detalle del modelo, con botón de copiar.
- Según `design/IDENTIDAD.md`, el identificador es visible y copiable en cada modelo.

**HU-16.** Como admin, quiero que la lista de modelos gratuitos se actualice sola en los proveedores compatibles, para no revisar cada proveedor a mano.
- Un job en segundo plano corre cada **6 horas**, aplicando **únicamente** a proveedores habilitados con `modelsSource: "api"`.
- Un modelo que deja de ser gratuito sale de la lista en la siguiente actualización.
- Un modelo nuevo gratuito aparece con la fecha UTC en que se detectó.

## 6. Resumen, métricas y logs

**HU-17.** Como admin, quiero ver en el resumen mi cuota del día, para saber cuánto me queda.
- Según `design/IDENTIDAD.md`, la cuota es el bloque principal de la pantalla.
- Se calcula usando el tope diario configurable por clave y las cabeceras `x-ratelimit-*` cuando el proveedor las envíe.
- El bloque muestra el porcentaje y el tiempo estimado hasta reponerse (`00:00 UTC` o ventana de 24 h).

**HU-18.** Como admin, quiero ver la latencia por percentiles, para entender la experiencia típica y la peor.
- El gráfico muestra P50, P75, P90, P95 y P99 juntos.
- Al pasar el mouse, aparecen los valores de todos los percentiles en ese momento.

**HU-18b.** Como admin, quiero ver la velocidad de cada modelo, para elegir el que responde más rápido.
- Se muestran el tiempo al primer token y los tokens por segundo, con percentiles P50, P75, P90, P95 y P99 juntos.
- Se muestra la tasa de aciertos de caché por proveedor.
- Al pasar el mouse, aparecen los valores de todos los percentiles en ese momento.

**HU-19.** Como admin, quiero ver el uptime de cada proveedor en los últimos 60 días, para comparar su estabilidad.
- Calculado sobre **peticiones reales** (sin pings automáticos para no consumir cuota).
- Cada día aparece como una barra: verde (≥ 99 %), ámbar (95–99 %, caídas parciales), rojo (< 95 %, caída relevante) o gris (sin tráfico ese día).
- Al pasar el mouse sobre una barra, aparece la fecha y el uptime de ese día.

**HU-20.** Como admin, quiero ver los errores en herramientas y en salida estructurada por proveedor, para saber cuál falla más.
- Las barras muestran el porcentaje por proveedor en los últimos 7 días.

**HU-20b.** Como admin, quiero ver la actividad total de mis tokens, para entender cuánto uso hago y en qué.
- Muestra el volumen total de tokens entre todos los modelos, separado en prompt, completion y reasoning.
- Un selector (combobox) permite filtrar por **rango de tiempo** (hoy, 7 días, 30 días) y agrupar/filtrar por **modelo, proveedor o usuario**.

**HU-20c.** Como admin, quiero consultar un apartado de Logs del sistema, para auditar errores de claves, failovers, reanudaciones de streaming y caídas de nodos.
- Pantalla exclusiva para el admin (`/api/logs`).
- Muestra nivel (`info`, `warn`, `error`), categoría (`failover`, `stream_resume`, `node`, `sync`, `auth`, `backup`, `system`), fecha UTC y mensaje.
- Nunca muestra claves, tokens ni secretos en texto plano.

## 7. Comparar y probar

**HU-21.** Como admin, quiero comparar hasta tres modelos que yo elija, para decidir cuál usar.
- La comparación empieza vacía, con un solo modelo cargado.
- Cada modelo agregado aparece como columna; cada uno se puede quitar.

**HU-22.** Como admin, quiero probar un modelo en un playground propio, para revisar su respuesta sin tocar mis programas.
- El playground es una pantalla aparte, con su propia configuración (modelo, razonamiento, temperatura, límite de tokens).
- El uso del playground descuenta de la cuota igual que cualquier petición y muestra TTFT y tok/s.

## 8. Marketplace

**HU-23.** Como admin, quiero explorar proveedores publicados en `bifrost-providers`, para encontrar integraciones nuevas.
- Cada paquete muestra su categoría, tipo (`official-json` o `experimental-adapter`), estado de verificación y fecha de publicación.
- Solo aparecen paquetes aprobados y no se instala ninguno automáticamente.

**HU-24.** Como persona que quiere publicar, quiero subir mi proveedor al repositorio `bifrost-providers`, para que otros lo usen.
- La publicación queda en estado "pendiente" hasta que un admin del catálogo la revise.
- Una ficha que no cumple `schemas/provider.schema.json` se rechaza con el motivo exacto.

## 9. Cuenta y respaldos

**HU-25.** Como admin, quiero exportar mi configuración cifrada con contraseña, para respaldarla o moverla a otra VM.
- La contraseña se pide al exportar, no al iniciar la app.
- Antes de exportar, el admin marca con casillas qué incluir: configuración, claves, usuarios, nodos, etc.
- Genera un archivo único `.bifrost.enc` (`gzip` + `AES-256-GCM`); sin la contraseña, no se puede abrir.

**HU-25b.** Como admin, quiero importar un respaldo `.bifrost.enc` en una instancia de Bifrost, para restaurar o migrar mi servidor sin reconfigurar todo.
- El admin sube el archivo `.bifrost.enc` e introduce la contraseña usada al exportar.
- Si la contraseña es incorrecta o el archivo está corrupto, no modifica la base de datos y muestra un error claro.

**HU-26.** Como admin, quiero que la app arranque sola después de reiniciar la VM, para no tener que intervenir.
- Al reiniciar (Docker `unless-stopped` o `systemd`), la base de datos se abre con `master.key`, sin pedir contraseña.
- Si `master.key` falta o es inválida, el servicio aborta el arranque y el registro lo dice claramente.

Ver `docs/PENDIENTES.md`.

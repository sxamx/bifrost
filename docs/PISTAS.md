# Pistas para el implementador

Notas cortas para quien implemente el código. No son especificación: son lo que ya se verificó y cómo volver a verificarlo. Antes de confiar en algo, repite la prueba.

Regla general: nunca pegues una clave real en un archivo, un issue, un commit ni un chat. Usa una variable de entorno.

---

## OpenRouter: catálogo de modelos (HU-06b, HU-14, HU-16)

**Estado (13 nov 2026):** `GET https://openrouter.ai/api/v1/models` respondió `200 OK` con JSON (`{"data": [...]}`). La respuesta incluía campos de precio, modalidades, contexto y fecha, y el encabezado `Cache-Control` tiene `max-age=120`.

**Confirmado sin clave:** el admin ejecutó `curl -i https://openrouter.ai/api/v1/models` sin ninguna cabecera de autenticación (Windows, 13 nov 2026) y recibió la lista. El catálogo es público. La prueba 2 (con clave) sigue sirviendo para comprobar que la lista no cambia según la cuenta.

### Prueba 1: ¿el catálogo es público?

```bash
curl -sS -i https://openrouter.ai/api/v1/models | head -n 20
```

- Si responde `200`, el catálogo no necesita clave.
- Si responde `401` o `403`, el catálogo necesita clave. Entonces prueba la 2.

### Prueba 2: con clave

```bash
export OPENROUTER_API_KEY="..."   # tu clave, no la escribas en el repo
curl -sS https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | head -c 2000
```

Compara la cantidad de modelos y los campos con la prueba 1. Si cambia algo, documenta la diferencia aquí.

### Campos que usamos

| Necesidad | Campo |
|---|---|
| Identificador `proveedor/modelo` | `id` (ej. `inclusionai/ling-3.2-flash:free`) |
| Nombre visible | `name` |
| Modalidades | `architecture.input_modalities`, `architecture.output_modalities` |
| Precio | `pricing.prompt`, `pricing.completion` (texto, en USD por token) |
| Contexto | `context_length` |
| Fecha de lanzamiento | `created` (Unix, segundos) |
| Retiro programado | `expiration_date` (puede ser `null`) |
| Qué endpoints soporta | `endpoints` |
| Parámetros soportados | `supported_parameters` |
| Benchmarks | `benchmarks` (no siempre viene) |

### Cómo decidir si un modelo es gratuito

- Gratis si `pricing.prompt` y `pricing.completion` valen `"0"`.
- Además, el identificador suele terminar en `:free`. Úsalo como señal extra, no como única regla.
- Un modelo con precio mayor que `"0"` no es gratis aunque tenga `:free` en otra variante. Decide por el precio.

### Trampa: variantes que no son de chat

Hay entradas como `google/gemini-4-hydrogen:batch` que aparecen en la lista pero solo tienen el endpoint `/api/v1/batches`. Para el router, un modelo sirve solo si `endpoints` incluye `/api/v1/chat/completions`. Filtra por eso antes de mostrarlo.

### Otras notas

- La respuesta es grande (cientos de KB). Parsea el JSON completo y no lo guardes crudo en la base de datos.
- Cachea el resultado por unos minutos. El servidor ya lo cachea 120 s.
- La lista cambia. HU-16 pide que los modelos que dejan de ser gratis salgan en la siguiente actualización, así que no asumas que la lista de ayer sirve hoy.
- Al detectar modelos (HU-06b) y recargar (HU-06c), guarda `created` y la fecha en que el router vio el modelo por primera vez, porque la API no dice cuándo apareció en el catálogo local.

---

## Fuente de datos reales (precios, límites, capacidades)

Objetivo: una fuente que no sea la lista de un router. Debe dar precio, contexto, modalidades y fechas de cada modelo, con datos del proveedor o de terceros confiables.

### Candidata 1: models.dev (la mejor opción por ahora)

- Base de datos abierta (licencia MIT), mantenida por el equipo de SST y usada por opencode.
- Trae: límites de contexto y salida, modalidades, soporte de herramientas, razonamiento y salida estructurada, precios en USD por millón de tokens (entrada, salida, caché), fechas de lanzamiento y de última actualización, estado (alpha, beta, deprecated), y proveedores con su endpoint compatible con OpenAI.
- No necesita clave. Confirmado el 13 nov 2026: el admin ejecutó `curl` sin cabeceras y recibió el JSON.

Estructura del JSON (confirmada con una respuesta real):

- Nivel superior: un objeto por proveedor, con clave igual al ID del proveedor (ej. `byteplus`).
- Cada proveedor trae `id`, `name`, `api` (URL base compatible con OpenAI), `env` (nombre de la variable de la clave, ej. `BYTEPLUS_API_KEY`), `npm` (paquete del SDK), `doc` (enlace de documentación) y `models`.
- Cada modelo, dentro de `models`, trae `id`, `name`, `description`, `family`, `attachment`, `reasoning`, `reasoning_options`, `tool_call`, `structured_output`, `temperature`, `knowledge`, `release_date`, `last_updated`, `modalities` (input y output), `open_weights`, `limit` (`context` y `output`) y `cost` (`input`, `output`, `cache_read`, `cache_write`, y a veces `tiers` por tamaño de contexto).
- `canonical_model_id` (ej. `deepseek/deepseek-v4-flash`) sirve para cruzar con el ID de OpenRouter. Hay que probarlo.
- No vimos un campo explícito de "gratis". Para detectar gratuitos hay que mirar si `cost.input` y `cost.output` valen `0`. Confirmar con un modelo gratis real.
- Los precios están en USD por millón de tokens (a diferencia de OpenRouter, que los da por token).
- Los logos de proveedor vienen de `https://models.dev/logos/{provider}.svg`. Ya están copiados en `design/mockups/logos/` (anthropic, google, nvidia, openai) para que la maqueta funcione sin internet. Hay que revisar la licencia de los logos antes de usarlos en la app final. Los SVG usan `currentColor`, así que en una etiqueta `<img>` se ven en negro; si se quiere otro color, hay que incrustarlos en línea.

Prueba:

```bash
curl -sS https://models.dev/api.json | head -c 2000
curl -sS "https://models.dev/api.json?type=all" | head -c 2000
```

Compara los campos con lo que necesitamos (HU-14). Confirma si los precios vienen por proveedor o solo por modelo, y si el identificador coincide con el de OpenRouter (`proveedor/modelo`). Si no coincide, necesitamos un mapeo.

### Candidata 2: LiteLLM, mapa de costos (por verificar)

- Proyecto LiteLLM publica un JSON de precios y límites de modelos (`model_prices_and_context_window.json`), mantenido por la comunidad.
- No está verificado el archivo exacto ni su formato actual. Antes de usarlo, descárgalo y revisa los campos.
- Es útil como segunda fuente para contrastar precios.

### Candidata 3: Artificial Analysis (benchmarks, por verificar)

- Tiene una API gratuita con clave (cabecera `x-api-key`, clave en `artificialanalysis.ai/login`).
- Su documentación no confirma si incluye precios, contexto o velocidad. Sí se orienta a benchmarks.
- Exige atribución a artificialanalysis.ai en todo uso.
- Útil para el índice de benchmarks (HU-18 y el detalle de modelo), no como fuente de precios.

### Criterio para elegir

1. Que sea pública o con clave gratuita.
2. Que tenga precio por modelo y fecha de actualización.
3. Que el identificador se pueda relacionar con `proveedor/modelo`.
4. Que su licencia permita usarla en un proyecto MIT.

## Pendientes relacionados

- Catálogo de NVIDIA NIM y de OpenCode Zen: sin definir (ver `docs/PENDIENTES.md`, ítem 6).
- Fuente del precio para proveedores sin API de catálogo (ítem 14).

---

## Fuentes de benchmarks: qué se puede usar (verificado el 13 nov 2026)

### Artificial Analysis: API oficial v2
- Base: `https://artificialanalysis.ai/api/v2`. Autenticación con cabecera `x-api-key`. La clave se crea gratis en `artificialanalysis.ai/login`.
- Nivel gratuito: 100 peticiones por ventana de 24 h, compartidas por todas las claves del mismo alcance (usuario u organización). Respuestas con `X-RateLimit-*`; un `429` trae `Retry-After`.
- Gratis incluye: lista de modelos con índices principales, rendimiento mediano (`performance`) y precios de entrada y salida a nivel de lista. El modelo individual y el precio completo requieren plan Pro.
- Atribución obligatoria en todo uso público.
- Campos confirmados: `artificial_analysis_intelligence_index`, `artificial_analysis_coding_index`, `artificial_analysis_agentic_index`, y seis índices de capacidad. El campo `performance` deja de devolver datos el 10 dic 2026, así que hay que usar `performance_v3`.
- Prueba para el agente: `curl -sS https://artificialanalysis.ai/api/v2/language/models -H "x-api-key: $AA_KEY"`. La clave va en variable de entorno.
- Un servidor MCP oficial existe según el propio sitio (`mcp.artificialanalysis.ai/mcp`), pero no lo verifiqué. Sirve para desarrollo, no para la app.

### Design Arena: API con solicitud
- Existe una página de solicitud de acceso a la API (`designarena.ai/developers/apply`). Se revisa a mano, y la clave llega por correo.
- Pide nombre, correo, descripción de uso (mínimo 20 caracteres) y volumen esperado por hora. No se publicó precio ni nivel gratuito.
- Atribución obligatoria: crédito a Design Arena y enlace a `designarena.ai`.
- Campos conocidos por el esquema de OpenRouter: `arena`, `category`, `elo`, `rank` (1 = mejor) y `win_rate`. Ese esquema viene de los datos de Design Arena que OpenRouter muestra.
- Pendiente: pedir la clave y probar qué endpoints devuelve.

### Vals AI: sin verificar
- No confirmé una API pública. Hay que revisar `vals.ai` y el repositorio `vals-ai` de Hugging Face antes de decidir.
- Lo que sí es probable: los datos de los benchmarks están en Hugging Face, pero el índice general puede no estar publicado.

### Consecuencia para la app
- Artificial Analysis permite 100 peticiones al día, así que hay que cachear la respuesta por varias horas.
- Design Arena necesita aprobación previa. Mientras tanto, la app puede usar los datos de OpenRouter, si confirmamos que los expone.

---

## Evaluación de APIs públicas (requisito: que cualquiera pueda instalar la app sin traer clave)

| Fuente | Sin clave | Qué aporta | Estado |
|---|---|---|---|
| OpenRouter `/api/v1/models` | Sí (verificado) | Catálogo, precios, contexto, modalidades | Usar para el catálogo |
| models.dev `/api.json` | Sí (verificado) | Catálogo, precios, límites, fechas, logos | Usar como fuente de datos del modelo |
| Artificial Analysis v2 | No, clave gratis por usuario, 100 peticiones al día | Índices, velocidad, precios de lista | Requiere decisión: ver abajo |
| Design Arena | No, solicitud con revisión | Elo y ranking por categoría | Requiere solicitud de acceso |
| Hugging Face Open LLM Leaderboard (informe del agente) | Sí | Datos antiguos | Descartado: la versión v1 está archivada y no cubre modelos actuales |
| Papers With Code (informe del agente) | — | — | Descartado: cerrado por Meta en julio 2025 |
| Hugging Face Hub API | Sí | Metadatos de modelos abiertos en Hugging Face | Solo sirve para modelos abiertos, no para los de API comercial |

### Propuesta para benchmarks con API pública (DESCARTADA por los términos de Artificial Analysis, ver la sección de términos más abajo)
El repo de catálogo (público, del dueño) ejecuta cada día un trabajo programado que consulta Artificial Analysis con la clave del dueño y publica un archivo JSON en el repo. La app lee ese archivo desde GitHub, sin clave. Limitaciones:
- Revisar que los términos de uso de Artificial Analysis permitan redistribuir sus datos. Si no lo permiten, la alternativa es que cada instalación use su propia clave, de forma opcional.
- Mantener la atribución en la app.
- Design Arena: lo mismo, después de que aprueben la solicitud.

---

## Términos de Artificial Analysis (revisados el 14 nov 2026)

Documentos revisados: Términos de Uso del sitio (v1.0, abril 2024), Términos de la Plataforma de Datos (aplican también al nivel gratuito de la API) y la página de la API.

Lo que dicen, en lo que nos afecta:
- **Datos en crudo (§2.3 y §2.4(a) de la Plataforma de Datos):** no se pueden distribuir archivos de datos en crudo a terceros, ni reproducirlos en formato estructurado, tabular o legible por máquina, en ningún nivel. Esto incluye publicar un JSON en un repo público.
- **Producto para clientes (§2.4(c)):** no se pueden poner datos en crudo dentro de un producto, API o servicio disponible para terceros. La app pública entraría aquí si trae los datos incluidos.
- **Uso interno (§2.3, todos los niveles):** sí se permite, incluido compartir gráficos públicamente y citar puntos de datos individuales.
- **Datos derivados (§2.3, solo Pro y Comercial):** se pueden distribuir con atribución y con la declaración de que son elaboración propia. Requiere plan Pro.
- **Atribución (§5.1):** obligatoria en todos los niveles, con la frase "Source: Artificial Analysis (artificialanalysis.ai)" o el logo visible en los gráficos.
- **Redistribución y derechos adicionales:** la página de la API dice "For redistribution rights or bespoke contract terms, contact the team." Es decir, se requiere acuerdo por escrito.
- **Términos del sitio (§2.2):** uso personal no comercial. No copiar ni republicar contenido.

### Conclusión
- **No** podemos publicar el JSON de Artificial Analysis en un repo público, ni incluirlo en la app para terceros, sin un permiso escrito.
- **Sí** podemos: que cada persona use su propia clave gratuita para uso propio (uso interno), con atribución visible.
- **Opción para pedir:** escribir al equipo de Artificial Analysis para pedir derechos de redistribución para un proyecto open source gratuito.
- **Pendiente:** revisar también los términos de Design Arena y de OpenRouter antes de publicar sus datos en el repo de datos. OpenRouter ya es una API pública; hay que confirmar que sus términos permitan reproducir su catálogo.

---

## Endpoints públicos recomendados (informe del 14 nov 2026)

Lista de endpoints que el informe propone como fuentes. ⭐ = prioridad alta en el informe.

| Fuente | Endpoint | Datos | Estado de licencia según el informe |
|---|---|---|---|
| models.dev ⭐ | `https://models.dev/models.json` (y `api.json` para precios) | Modelos, contexto, capacidades (`models.json`); precios y proveedores (`api.json`) | MIT |
| ArtificialWatch ⭐ | `https://artificialwatch.com/data/bench-index.json` | Rankings generales, índices y percentiles | CC BY 4.0 solo para índices y percentiles propios; los `raw` de otras fuentes no |
| ArtificialWatch ⭐ | `https://artificialwatch.com/data/coding-index.json` | Benchmarks de programación | Sin verificar. Aplicar la misma regla que bench-index |
| ArtificialWatch | `https://artificialwatch.com/data/llm-prices.json` | Precios, contexto y datos de modelos | Sin verificar |
| OpenCharts ⭐ | `https://www.opencharts.com/benchmarks/rankings.json` | Rankings e índices de capacidades | Verde parcial: reutilizar índices propios con enlace |
| LiteLLM | JSON de modelos (`model_prices_and_context_window.json`) | Precios, límites y características | MIT |
| LMArena ⭐ | Dataset público (`lmarena-ai/leaderboard-dataset`) | Rankings, puntuaciones e intervalos de confianza | CC BY 4.0 |
| Epoch AI ⭐ | Descarga de datos | Resultados de numerosos benchmarks | Verde parcial: solo filas propias de Epoch |

**Pendiente antes de usar:**
- `coding-index.json` y `llm-prices.json` no están verificados en la investigación. Hay que revisar su licencia, igual que bench-index.
- Las filas `raw` de ArtificialWatch siguen siendo de cada fuente original. No se exportan.
- Verificar el endpoint de OpenCharts antes de usarlo.

### Prueba técnica de acceso (14 nov 2026, sin clave, sin cookies)

Probado por otra IA con solicitudes HTTP reales. Todos respondieron 200 y los datos se pudieron leer:

| Fuente | Resultado | Notas |
|---|---|---|
| models.dev `models.json` | OK, ~516 KB, 614 modelos | CORS permitido |
| ArtificialWatch `bench-index.json` | OK | CORS permitido |
| ArtificialWatch `coding-index.json` | OK | CORS permitido |
| ArtificialWatch `llm-prices.json` | OK | CORS permitido |
| OpenCharts `rankings.json` | OK, ~1,19 MB | CORS permitido |
| LiteLLM `model_prices_and_context_window.json` | OK, ~4,08 MB, 5.992 entradas | Se sirve como `text/plain`, pero es JSON válido |
| LMArena (API de datasets de Hugging Face, `agent/latest`) | OK | CORS permitido |
| Epoch AI `benchmark_data.zip` | OK, ~2,31 MB, 92 archivos | Sin CORS: solo desde backend. Contiene CSV, no JSON |

**Importante:** que el acceso funcione no significa que la licencia lo permita. El informe deja claro que el derecho de uso se verifica campo por campo, y eso sigue pendiente.

---

## Matriz de derechos por campo (14 nov 2026)

Documento completo: `docs/investigacion/matriz-derechos-por-campo-2026-11-14.md`. Es un análisis técnico y contractual, no un dictamen jurídico. Resumen de lo que habilita:

- **models.dev `api.json` y `models.json` (MIT):** identidad, contexto, modalidades, capacidades y precios **por ruta de proveedor**. `models.json` **no tiene precios**. Los `benchmarks[]` embebidos se tratan como 🟡 hasta verificar la fuente de cada uno.
- **LiteLLM (MIT):** precios y capacidades para contraste. Filtrar entradas auxiliares como `sample_spec`.
- **ArtificialWatch (CC BY 4.0):** `index`, `percentile` y precios (`llm-prices`, con atribución también a models.dev). **No** los `scores[].raw`.
- **OpenCharts:** índices, grades y bandas propios, con enlace. No espejar el JSON completo.
- **LMArena `agent/latest` (CC BY 4.0):** score, intervalos, muestras y costo mediano por tarea. La licencia por fila describe el modelo evaluado, no el dataset.
- **Epoch AI:** solo filas de runs propios de Epoch. Las filas de terceros quedan ❓.

Reglas que quedan fijadas:
- Que un endpoint responda 200 sin token no da derechos.
- Un campo sin licencia verificada se excluye de exportaciones públicas.
- Un `null` nunca se muestra como 0.
- Las visualizaciones no mezclan escalas incompatibles.
- Velocidad, TTFT y tokens/s vienen de telemetría propia de cada instalación.

Hallazgo técnico: algunas peticiones con el User-Agent por defecto de Python recibieron 403. No hay que eludir esos bloqueos. Hay que revisar las cabeceras desde el entorno real de la app.

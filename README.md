# Bifrost

Gateway y router self-hosted de cuotas gratuitas de modelos de IA. Expone una API compatible con OpenAI (`/v1/chat/completions`, `/v1/models`) y reparte las peticiones entre las cuentas y claves de varios proveedores, cada una atada a un nodo de salida.

La app se instala **vacía**. Los proveedores e integraciones se instalan bajo demanda desde el marketplace (`bifrost-providers`).

> Estado: arquitectura y especificación listas. Iniciando implementación (Fase 1).

## Estructura

| Carpeta | Qué va ahí |
|---|---|
| [`docs/`](docs/) | Visión, decisiones, arquitectura, protocolo de nodos, historias y orden de implementación. |
| [`core/`](core/) | Núcleo del router: API OpenAI, enrutamiento por clave, salud, failover, SQLite cifrado. |
| [`panel/`](panel/) | Panel web React/Vite: resumen, proveedores, métricas, comparador, playground y logs. |
| [`nodes/`](nodes/) | Nodos de salida: túnel ligero que reenvía tráfico cifrado sin ver claves ni contenido. |
| [`schemas/`](schemas/) | JSON Schemas oficiales para fichas de proveedor e información de modelos. |
| [`tests/`](tests/) | Pruebas y criterios de aceptación. |

## Documentos

- [Visión](docs/VISION.md)
- [Decisiones](docs/DECISIONS.md)
- [Arquitectura técnica](docs/ARQUITECTURA.md)
- [Protocolo núcleo–nodo](docs/PROTOCOLO-NODOS.md)
- [Historias de usuario](docs/HISTORIAS.md)
- [Orden de implementación](docs/ORDEN-DE-IMPLEMENTACION.md)
- [Pendientes por aclarar](docs/PENDIENTES.md)

## Licencia

[MIT](LICENSE)

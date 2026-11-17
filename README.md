# Bifrost

Gateway y router self-hosted de cuotas gratuitas de modelos de IA. Expone una API compatible con OpenAI (`/v1/chat/completions`, `/v1/models`) y reparte las peticiones entre las cuentas y claves de varios proveedores, cada una atada a un nodo de salida.

La app se instala **vacía**. Los proveedores e integraciones se instalan bajo demanda desde el marketplace (`bifrost-providers`).

## Inicio rápido

### Opción 1: Docker Compose (recomendada)

```bash
docker compose up -d
```

El panel y la API responden en `http://localhost:8080`.

### Opción 2: Instalación nativa en Linux (`systemd`)

```bash
bash scripts/install.sh
```

## Estructura

| Carpeta | Qué va ahí |
|---|---|
| [`core/`](core/) | Núcleo HTTP (Hono + Node.js): API OpenAI (`/v1/*`), API del panel (`/api/*`), SQLite cifrado. |
| [`panel/`](panel/) | Panel web (React + Vite + TypeScript): configuración inicial, resumen, proveedores, métricas y API keys. |
| [`nodes/`](nodes/) | Nodos de salida: túnel `HTTP CONNECT` que reenvía tráfico cifrado sin ver claves ni contenido. |
| [`schemas/`](schemas/) | JSON Schemas oficiales para fichas de proveedor e información de modelos. |
| [`scripts/`](scripts/) | Instalador nativo Linux (`install.sh`) y unidad `systemd`. |
| [`docs/`](docs/) | Visión, decisiones, arquitectura técnica y protocolo núcleo–nodo. |
| [`tests/`](tests/) | Pruebas automatizadas de integración y criterios de aceptación. |

## Documentación

- [Visión](docs/VISION.md)
- [Decisiones](docs/DECISIONS.md)
- [Arquitectura técnica](docs/ARQUITECTURA.md)
- [Protocolo núcleo–nodo](docs/PROTOCOLO-NODOS.md)
- [Roadmap e Historias de Usuario (Issues)](https://github.com/sxamx/bifrost/issues)

## Licencia

[MIT](LICENSE)

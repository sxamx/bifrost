# nodes

Agente ligero de los nodos de salida. Cada nodo actúa como un túnel TCP `HTTP CONNECT` que reenvía tráfico ya cifrado: **no tiene claves ni ve el contenido**.

Especificación completa: [`docs/PROTOCOLO-NODOS.md`](../docs/PROTOCOLO-NODOS.md).

## Reglas

- Conexión por **Tailscale** preferida. Sin Tailscale, IP pública sobre TLS con advertencia al admin.
- Autenticación con token rotativo por nodo (rotación cada 24 h con ventana de gracia de 5 minutos).
- Heartbeat cada 30 s (sin respuesta > 120 s → `sin respuesta`).
- Cada clave/cuenta de proveedor queda asignada a un solo nodo. Forzar otra asignación requiere confirmación.

Historias relacionadas: `HU-11`, `HU-11b`, `HU-11c`, `HU-11d`, `HU-12` y `HU-13` en [`docs/HISTORIAS.md`](../docs/HISTORIAS.md).

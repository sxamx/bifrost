# Protocolo Núcleo ↔ Nodo de Salida

Este documento especifica el protocolo entre `core/` y `nodes/` para cumplir `HU-11`, `HU-11b`, `HU-11c`, `HU-11d`, `HU-12` y `HU-13`.

---

## 1. Principio de Cero Conocimiento

El nodo de salida **nunca** ve:
- La clave API del proveedor (`Authorization: Bearer ...`).
- El contenido del prompt ni la respuesta del modelo.

Para lograrlo, el nodo funciona como un **túnel TCP transparente mediante `HTTP CONNECT`**. `core/` abre un túnel TCP a través del nodo hacia el host del proveedor (ej. `openrouter.ai:443`) y realiza el **handshake TLS de extremo a extremo** directamente desde `core/` contra el proveedor. El nodo solo ve paquetes TLS cifrados saliendo por su IP.

---

## 2. Transporte y Seguridad

1. **Modo `tailscale` (recomendado, HU-11b):**
   - El binario/servicio de `nodes/` se enlaza únicamente a la interfaz/IP de Tailscale (`100.x.y.z`, puerto por defecto `9443`).
   - El tráfico viaja cifrado por WireGuard (Tailscale) sin abrir puertos a internet.
2. **Modo `public_ip` (alternativa con advertencia):**
   - Si no hay Tailscale, `nodes/` escucha sobre TLS (`HTTPS` con certificado autofirmado cuyo fingerprint SHA-256 se registra al vincular el nodo, o TLS estándar).
   - El panel muestra una advertencia explícita al admin sobre exposición de puerto.

---

## 3. Autenticación y Rotación de Token (HU-11, HU-11c)

- Al crear un nodo en el panel, `core/` genera un `node_token` aleatorio de 32 bytes y entrega el comando de instalación con el token **una sola vez**.
- En cada petición `CONNECT` o heartbeat, `core/` envía la cabecera:
  `Proxy-Authorization: Bearer <node_token>`
- **Rotación automática (cada 24 horas):**
  1. `core/` genera un `new_token` y envía `POST /_bifrost/rotate` al nodo autenticado con el token actual.
  2. El nodo acepta ambos tokens (`current_token` y `new_token`) durante una **ventana de gracia de 5 minutos**.
  3. `core/` actualiza `token_hash` y guarda `prev_token_hash` con expiración de 5 minutos en SQLite.
  4. Pasados 5 minutos, el token anterior deja de ser válido sin cortar ninguna petición en curso.

---

## 4. Heartbeat y Detección de Caída (HU-12)

- **Intervalo de sondeo:** `core/` consulta `GET /_bifrost/health` a cada nodo cada **30 segundos**.
- **Respuesta esperada (`200 OK`):**
  ```json
  {
    "ok": true,
    "uptime_sec": 86400,
    "version": "0.1.0",
    "active_tunnels": 2
  }
  ```
- **Regla de caída (`HU-12`):**
  - Si un nodo no responde durante más de **120 segundos** (4 fallos consecutivos), su estado pasa a `unresponsive` (`sin respuesta`).
  - Todas las `provider_keys` asignadas a ese nodo pasan automáticamente a estado `no_node` (`sin servicio`) y se registra un evento en `system_logs`.
  - Cuando el nodo vuelve a responder al heartbeat, vuelve a `online` y sus claves vuelven a `active`.

---

## 5. Regla de Asignación de Claves (HU-08, HU-11d)

- Cada clave nueva se asigna al nodo `online` que tenga **menos claves de ese mismo proveedor** (reparto equitativo por proveedor).
- Una clave queda atada a un único `node_id`.
- Si el admin intenta reasignar una clave a un nodo que ya tiene otra clave del mismo proveedor, el panel muestra una advertencia de riesgo de baneo por IP compartida y exige confirmación explícita (`forced_node = 1`).

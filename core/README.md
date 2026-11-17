# core

Núcleo del router. Aquí va:

- API compatible con OpenAI (`/v1/chat/completions`, `/v1/models`).
- Asignación de cada clave a un nodo, con reparto equitativo por proveedor.
- Salud por clave, failover y continuación de respuestas cortadas.
- Lectura de la ficha de cada proveedor desde `schemas/`.
- Base de datos SQLite con las claves cifradas.

No aquí: interfaz web (va en `panel/`) ni programa de nodos (va en `nodes/`).

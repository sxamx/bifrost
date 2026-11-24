# panel

Interfaz web de Bifrost (React + Vite + TypeScript). `core/` sirve los archivos compilados desde `panel/dist/`.

Pantallas previstas, según `design/IDENTIDAD.md`:

- Resumen y cuota del día.
- Proveedores, marketplace (`mazzapata/providers`) y cuentas/claves.
- Modelos, con detalle por modelo y benchmarks.
- Métricas: uptime (60 días), latencia por percentil, velocidad/caché, errores en herramientas y actividad.
- Logs del sistema y failover (solo admin).
- Comparador de modelos (hasta 3 modelos).
- Playground, en pantalla propia.
- Administración: nodos, usuarios/invitaciones, API keys internas (`sk-bf-...`) y respaldos (`.bifrost.enc`).

El panel solo habla con la API `/api/*` de `core/`. No guarda claves ni habla con proveedores directamente.

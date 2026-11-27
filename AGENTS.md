# AGENTS.md — Normas Permanentes de Ingeniería de Bifrost

Este documento define las reglas obligatorias de arquitectura, organización, flujo de trabajo, seguridad, licencias y pruebas para cualquier contribución al repositorio **Bifrost** (`sxamx/bifrost`).

---

## 1. Arquitectura y Stack

Bifrost es un gateway y router self-hosted de cuotas gratuitas de modelos de IA con API compatible con OpenAI (licencia MIT), organizado en tres módulos TypeScript:

| Módulo | Ruta | Stack y responsabilidad |
| --- | --- | --- |
| **Core** | `core/` | **Hono** sobre **Node.js 24 LTS** + **SQLite en modo WAL** (`node:sqlite`, `foreign_keys = ON`). Expone `/api/*` y `/v1/*`, cifra secretos en reposo, gestiona cuotas UTC, telemetría y sirve la SPA compilada desde `panel/dist` en un único servidor (puerto por defecto `8080`). |
| **Panel** | `panel/` | **React + Vite PWA** (TypeScript). Interfaz web compilada a estáticos (`panel/dist`) servidos por `core/`. En desarrollo hace proxy de `/api` y `/v1` hacia `http://localhost:8080`. |
| **Nodes** | `nodes/` | Agente ligero de nodo de salida **HTTP CONNECT** de cero conocimiento (Node.js + TypeScript). Reenvía tráfico TLS cifrado de extremo a extremo sin descifrar cabeceras ni prompts. Soporta modo **Tailscale** (preferido) y modo **`public_ip`** con TLS y *pinning* de huella SHA-256. |

---

## 2. Separación Crítica de Repositorios

- **`sxamx/bifrost`** (este repositorio): debe permanecer **100 % genérico, limpio y agnóstico**.
  - Prohibido incluir *spoofing*, credenciales, configuraciones privadas o referencias no permitidas.
  - Prohibido incluir datos personales de cualquier tipo en código, documentación, pruebas, commits o PRs.
- **`mazzapata/providers`**: repositorio externo oficial del catálogo/marketplace de proveedores (opt-in en el panel; soporta `official-json` y `experimental-adapter`). No debe incrustarse ni mezclarse lógica privada de proveedores dentro de `sxamx/bifrost`.

---

## 3. División Estricta de Archivos (Backend vs UI)

Para evitar conflictos y regresiones visuales, existe una frontera estricta entre cambios de **Backend** y cambios de **UI**:

- **Exclusivo de UI:**
  - `panel/src/components/**`
  - `panel/src/styles/theme.css`
  - `panel/src/App.tsx`
  - `panel/public/**`
  - `panel/index.html`
- **Exclusivo de Backend / Infraestructura / Tests:**
  - `core/**`
  - `nodes/**`
  - `schemas/**`
  - `scripts/**`
  - `tests/**`
  - `Dockerfile`, `docker-compose.yml`, `.github/workflows/**`, `tsconfig.test.json`

### Reglas de frontera

1. Un cambio de **Backend** tiene **PROHIBIDO** modificar `panel/src/components/`, `panel/src/styles/theme.css`, `panel/src/App.tsx`, `panel/public/` o `panel/index.html` (salvo archivos de tooling explícitamente autorizados en el Issue, como `panel/vite.config.ts`).
2. **Actualización obligatoria de backlog UI:** todo PR de Backend que modifique contratos de API, añada campos consumibles por el panel o requiera ajustes visuales **debe actualizar [`docs/UI-BACKLOG.md`](docs/UI-BACKLOG.md)** en el mismo PR, documentando el contrato exacto y la prioridad.
3. Un cambio de **UI** no debe alterar la lógica de negocio ni contratos de `core/` o `nodes/` sin coordinación explícita en un Issue.

---

## 4. Flujo de Trabajo Obligatorio

Todo cambio en el repositorio sigue este flujo sin excepciones:

1. **Issue primero:** abrir o referenciar un Issue con alcance, archivos permitidos y criterios de aceptación.
2. **Rama nueva:** crear una rama dedicada desde `main` (nunca trabajar ni hacer push directo sobre `main`).
3. **Compilación y pruebas:** ejecutar y verificar en verde `npm run build`, `npm test`, `npx --prefix core tsc -p tsconfig.test.json` y `node scripts/validate-schemas.mjs`.
4. **Pull Request hacia `main`:** abrir PR con referencia explícita `Closes #<numero>`.
5. **Revisión independiente en modo solo lectura:** una revisión técnica independiente audita el diff y emite veredicto (`APPROVE` o `REQUEST_CHANGES`).
6. **Merge solo con aprobación del dueño:** ningún cambio se fusiona a `main` sin la aprobación explícita del dueño del repositorio.

### Regla obligatoria de autoría de commits y PRs

- Todos los commits y Pull Requests deben quedar **estrictamente a nombre del dueño del repositorio** usando la identidad Git configurada (`git config user.name` y `git config user.email`; verificar siempre antes de ejecutar `git commit`).
- **PROHIBIDO** añadir trailers `Co-authored-by:` en mensajes de commit.
- **PROHIBIDO** incluir menciones a IA, bots, agentes o modelos en mensajes de commit, títulos/cuerpos de PR o comentarios de revisión.

---

## 5. Invariantes de Diseño Aprobadas

Estas decisiones de diseño están cerradas y no deben romperse en futuros cambios:

1. **Claves nuevas en estado `disabled` por defecto:** al crear nuevas claves de proveedor en el flujo del panel se crean como `status: 'disabled'` de forma intencional, para permitir asignar el nodo de salida antes de enrutar tráfico real. El backend debe respetar siempre `status: 'disabled'` / `enabled: false` sin auto-activar claves deshabilitadas.
2. **Política de licencias de benchmarks y catálogo (mínimo exacto exigido):**
   - Cumplir exactamente el mínimo requerido por cada fuente, **ni más ni menos**, integrado de forma limpia en la misma línea de pie (sin banners intrusivos).
   - `CC BY 4.0` con enlace clicable para fuentes bajo esa licencia (p. ej. LMArena, ArtificialWatch).
   - Cita breve de 1 línea para **Epoch AI**.
   - **OpenCharts NO es CC BY 4.0**: solo enlace directo a la fuente.
   - Enlace directo a **`models.dev`**.
3. **Prohibido `cursor: help`:** está terminantemente prohibido usar `cursor: help` en CSS, HTML, JS o TS/TSX. Esta regla se valida automáticamente en CI.
4. **Preservación de historial en `usage_logs`:** nunca borrar registros históricos de `usage_logs` de forma automática sin una política de retención configurable aprobada explícitamente por el dueño.
5. **Seguridad y criptografía:**
   - Secretos de proveedores y tokens de nodos cifrados en SQLite con `AES-256-GCM` y llave maestra `BIFROST_MASTER_KEY` (permisos `0600` en sistemas POSIX).
   - API keys internas (`sk-bf-...`) y tokens de nodo almacenados solo como hash `SHA-256`; contraseñas de usuarios con `scrypt`.
   - Redacción obligatoria de secretos en logs y mensajes de error (`system_logs`, respuestas HTTP).
   - Protección anti-SSRF con fallo cerrado (*fail-closed*) en nodos, adaptadores experimentales y fuentes de marketplace.
   - Cero archivos sensibles versionados (`.key`, `.db`, `.sqlite`, `.enc`, `.env`, `keys.json`, `state.json`, `data/`, `secrets/`).
6. **Pruebas deterministas, offline y multiplataforma:**
   - La suite de tests debe pasar al 100 % **sin acceso a internet** (usando `createOfflineFetch` de `tests/helpers/test-app.ts` para aislar `models.dev` y bloquear hosts externos no mockeados).
   - Compatibilidad total en **Linux y Windows** (condicionando aserciones POSIX `0o600` y sub-chequeos de `bash` cuando no esté disponible en Windows, y lanzando `tsx` mediante `process.execPath` con `--import tsx`).
   - Liberación determinista de recursos: cerrar siempre SQLite (`db.close()`) dentro de bloques `finally` y cerrar servidores HTTP de prueba usando `closeAllConnections?.()`.

---

## 6. Checklist de Revisión Independiente

Antes de emitir `APPROVE` en una revisión independiente (modo solo lectura), verificar:

- [ ] **Seguridad:** autenticación/autorización (`admin` vs `guest`), protección anti-SSRF, sanitización de enlaces externos, redacción de secretos en logs/errores y ausencia total de credenciales o datos personales.
- [ ] **Regresiones y contratos:** compatibilidad hacia atrás en `/api/*` y `/v1/*`, esquemas JSON válidos (`node scripts/validate-schemas.mjs`) y actualización de `docs/UI-BACKLOG.md` si un PR de Backend afecta contratos o UI.
- [ ] **Frontera Backend vs UI:** ningún archivo fuera del alcance permitido fue modificado (especialmente `panel/src/components/`, `panel/src/styles/theme.css`, `panel/src/App.tsx`).
- [ ] **Calidad de pruebas:** tests offline sin llamadas reales a internet, deterministas, compatibles con Windows y Linux, con `db.close()` en `finally` y `closeAllConnections?.()` en servidores de prueba.
- [ ] **CI y Tooling:** `npm run build`, `npm test`, `npx --prefix core tsc -p tsconfig.test.json` y validaciones de higiene (sin `cursor: help`, sin archivos prohibidos, autoría limpia sin `Co-authored-by:` ni menciones a IA).

# schemas

Formatos JSON Schema (Draft 2020-12) oficiales que el núcleo `core/` valida al instalar proveedores y normalizar modelos.

- [`provider.schema.json`](provider.schema.json): ficha de proveedor oficial (`official-json`) o adaptador experimental (`experimental-adapter`), autenticación, origen de modelos (`api` / `static`) y reglas de filtrado gratuito.
- [`model.schema.json`](model.schema.json): representación normalizada de un modelo (`proveedor/modelo`, modalidades, límites y capacidades).

# Visión

## Qué es

Un gateway que permite usar las cuotas gratuitas de varios proveedores de IA
desde una sola API y un panel web.

## Para quién

- Personas que quieren aprovechar cuotas gratuitas sin configurar cada proveedor a mano.
- Equipos pequeños que quieren compartir acceso a modelos sin compartir las claves.

## Principios

- **App vacía:** la instalación no trae proveedores. Se agregan desde el marketplace.
- **Proveedores son datos:** una ficha de configuración, no código ejecutable.
- **Claves cifradas:** nunca en texto plano en la base de datos.
- **Nodos livianos:** los nodos de salida solo reenvían tráfico; no tienen claves.
- **Solo APIs oficiales:** el proyecto no incluye ni promueve el uso de interfaces web de proveedores.

## Fuera de alcance por ahora

- Proveedores de pago.
- Modelos locales.
- Generación de imágenes.
- Marketplace de Cloudflare.

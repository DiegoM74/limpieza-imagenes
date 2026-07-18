# Cover Editor

Herramienta unificada en Python para la limpieza de imágenes y portadas de novelas ligeras, enfocada en la eliminación de texto preservando al maximo la calidad, colores e ilustración original.

## Como Funciona

Cuando se utiliza inteligencia artificial (IA) para eliminar texto de una imagen (inpainting), la IA tiende a alterar los colores, degradados, detalles y la resolución general de toda la imagen al reconstruirla.

Esta herramienta soluciona ese problema combinando tres elementos:
1. La imagen original (con texto).
2. Una versión limpia generada por IA (donde el texto ha sido removido).
3. Una máscara en blanco y negro (donde el color blanco indica exactamente las zonas de texto a eliminar).

El script alinea automáticamente ambas imágenes usando algoritmos de visión computacional (SIFT + RANSAC) y reemplaza únicamente las zonas cubiertas por la máscara. De esta forma, el 100% del arte original fuera del texto se conserva intacto.

## Requisitos

Es necesario contar con Python y las siguientes librerías:

```bash
pip install opencv-contrib-python pillow numpy
```

Nota: Es importante instalar `opencv-contrib-python` en lugar de `opencv-python` básico para disponer del detector de puntos de referencia SIFT.

## Comandos y Uso

El script no requiere ingresar las extensiones de archivo (.jpg o .png) de forma obligatoria en la línea de comandos; el sistema las buscará automáticamente si no se especifican.

### 1. Comando: clean

Alinea la imagen limpia sobre la original, ajusta el color y aplica la máscara para generar el resultado final.

Requisito: Debe existir un archivo de máscara (por defecto `mascara.png` en el mismo directorio de ejecución) que delimite las zonas de texto.

Uso básico (recomendado):
```bash
python cover_editor.py clean cover clean --color-match
```

Opciones disponibles para `clean`:
* `--mask <ruta>`: Especifica el nombre o ruta del archivo de la máscara (por defecto: `mascara.png`).
* `--color-match`: Ajusta los colores de la imagen limpia para que coincidan con la original. Es la opción recomendada para evitar saltos de iluminación y variaciones de color generadas por la IA.
* `--color-match-local`: Aplica el ajuste de color únicamente dentro de la máscara, tomando como referencia los píxeles adyacentes del contorno exterior. Útil cuando los colores generales de la limpia por IA difieren demasiado del fondo original.
* `--method [stats | reinhard | lut]`: Define el algoritmo matemático para el ajuste de color. El valor por defecto es `stats`. Puedes cambiarlo a `reinhard` o `lut` si notas tonalidades extrañas en el resultado final.
* `--dilate <int>`: Modifica los píxeles de dilación para la muestra de contexto de color (por defecto: 20). Útil en fondos con degradados amplios.
* `--blur <float>`: Ajusta el difuminado del borde de fusión en píxeles (por defecto: 4).
* `--waifu2x`: Activa la optimización automática de la calidad de la imagen limpia a través de waifu2x antes de procesarla.
* `--waifu2x-path <ruta>`: Especifica la ubicación del ejecutable `waifu2x-ncnn-vulkan.exe` si no se encuentra en el directorio del script.

### 2. Comando: align

Alinea la imagen limpia sobre la original y guarda la imagen resultante bajo el nombre `alineada.jpg`. Este comando es útil para verificar la alineación antes de aplicar la máscara.

Uso básico:
```bash
python cover_editor.py align cover clean
```

Opciones disponibles para `align`:
* `--waifu2x`: Ejecuta waifu2x en la imagen limpia antes de alinear.
* `--waifu2x-path <ruta>`: Especifica la ubicación del ejecutable `waifu2x-ncnn-vulkan.exe`.

## Integración con waifu2x

El script tiene soporte para integrar `waifu2x-ncnn-vulkan` de manera interna. Esto mejora la calidad de la imagen limpia generada por la IA (la cual suele perder resolución) antes de realizar la alineación y el compositing.

### Configuración del ejecutable
Por defecto, el script buscará el ejecutable `waifu2x-ncnn-vulkan.exe` de la siguiente manera:
1. Buscando directamente en el directorio raíz del script.
2. Buscando dentro de cualquier carpeta en el directorio actual cuyo nombre comience con `waifu2x` (por ejemplo, `waifu2x/`, `waifu2x-ncnn-vulkan-20250915-windows/`, etc.).

Si se encuentra en otra ubicación, puedes indicarla usando el parámetro `--waifu2x-path`.

### Uso
Para utilizar esta funcionalidad, agrega el argumento `--waifu2x` al comando:
```bash
python cover_editor.py clean cover clean --color-match --waifu2x
```
El proceso de escalado se realiza en segundo plano utilizando un archivo temporal, el cual es eliminado automáticamente al finalizar la ejecución.

## Preparación de la Máscara (Flujo de Trabajo en Krita)

Para crear la máscara de texto recomendada:
1. Abre la imagen original en Krita.
2. Crea una nueva capa vacía sobre ella.
3. Pinta con color blanco sólido únicamente sobre las zonas donde se encuentra el texto que quieres eliminar.
4. Oculta la capa de la imagen original (dejando visible solo la capa de la máscara pintada de blanco y el fondo transparente de Krita).
5. Exporta esta imagen resultante como `mascara.png` en formato PNG.
6. Una vez ejecutado el script, puedes importar la imagen final `limpia.jpg` al proyecto de Krita; al mantener exactamente la misma resolución, encajará perfectamente centrada y alineada.

## Prompt de IA Recomendado para Limpieza (Inpainting)

Para generar la versión limpia de la imagen mediante IA, se recomienda utilizar el siguiente prompt de edición de imágenes:

```text
Edit only the areas covered by Japanese text in this image. Remove all text characters completely. Fill the text areas using only the existing background colors and gradients visible immediately surrounding each text region. Do not alter any character artwork, colors, shading, line art, or any pixel outside the text bounding areas. Use inpainting only — do not regenerate or redraw any part of the image. Preserve all original art style, color values, and details exactly.
```

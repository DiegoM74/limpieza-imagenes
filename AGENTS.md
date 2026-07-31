# Documentación para Agentes de IA (AGENTS.md)

Este documento describe la arquitectura y la lógica interna de la versión web de este proyecto (no script de consola) para que cualquier modelo de IA pueda comprenderlo y modificarlo de forma inmediata sin necesidad de análisis exploratorio redundante.

---

## Objetivo del Proyecto

Limpieza y restauración de portadas de novelas ligeras eliminando las zonas de texto y reemplazándolas por áreas correspondientes de una imagen limpia (sin texto). Para preservar el arte original al 100%, solo se modifican los píxeles demarcados por una máscara, alineando ambas imágenes y ajustando sus colores para que la fusión sea imperceptible.

---

## Estructura de Archivos

- `cover_editor.py`: Script de terminal original en Python. Utiliza OpenCV (SIFT + RANSAC) y Pillow para alinear, ajustar el color (Stats, Reinhard, LUT) y aplicar la máscara.
- `index.html`: Estructura HTML de la aplicación web (SPA estática para Cloudflare Pages).
- `style.css`: Hoja de estilos en modo oscuro sólido. Usa variables CSS globales para colores, la tipografía única _Open Sans_, y reglas ordenadas jerárquicamente siguiendo el flujo del DOM.
- `app.js`: Lógica de procesamiento en el cliente (JavaScript) usando OpenCV.js, Canvas y control de flujo de interfaz.
- `waifu2x-engine.js`: Motor de super-resolución y reducción de ruido ejecutado 100% Client-Side mediante ONNX Runtime Web (WebGPU/WASM).
- `icons.svg`: Sprite SVG con los símbolos vectoriales de los iconos utilizados en la interfaz.

---

## Especificaciones Técnicas de la Aplicación Web

### 1. Motor de Visión Computacional (OpenCV.js) y Gestión de Memoria WASM

- **Origen**: Carga asíncrona mediante WebAssembly desde `https://docs.opencv.org/4.x/opencv.js`.
- **Representación**: OpenCV.js lee las imágenes del DOM en formato RGBA (`CV_8UC4`).
- **Gestión de Memoria y Resiliencia (`safeDeleteCvObjects`)**: Todos los objetos de OpenCV.js (`Mat`, `KeyPointVector`, `MatVector`, `ORB`, `BFMatcher`, `DMatchVector`) están protegidos mediante llamadas de eliminación en bloques `try...finally`. Ante cualquier error o excepción en el pipeline, se garantiza la liberación completa de la memoria en el heap de WebAssembly.

### 2. Algoritmo de Alineación (Homografía)

- Dado que SIFT no está disponible por defecto en compilaciones estándar de OpenCV.js, se implementa **ORB** (Oriented FAST and Rotated BRIEF) configurado con hasta 10,000 puntos clave (`new cv.ORB(10000)`) para asegurar suficiente densidad de características en portadas de alta resolución.
- **Procesamiento Asíncrono en Tiempo Real**: La ejecución de `processImages` es asíncrona (`async/await`) liberando el hilo principal del navegador mediante pequeñas pausas (`yieldToUI`), lo que permite renderizar el log de la consola y su desplazamiento en tiempo real.
- **Interruptores Beta de Alineación**:
  - `param-homography`: Permite deformar la perspectiva de la imagen limpia generada por IA para encajar los puntos clave con la portada original.
  - `param-mask-priority`: Procesa la máscara al inicio para dilatar una **Zona de Contexto** multi-región alrededor de todas las zonas blancas de la máscara (sin importar cuántos bloques de texto estén repartidos por la imagen). Filtra y prioriza únicamente los puntos clave (ORB) cercanos a dichas zonas para calcular la Homografía con la máxima exactitud donde ocurrirá el reemplazo.
  - `param-fallback-direct`: Controla el fallback a **Matriz de Alineación Directa (1:1 / Escalado)** cuando se detecta imprecisión o baja cantidad de puntos. Desactivado por defecto para garantizar que imágenes de IA con diferencias de zoom o encuadre siempre usen la Homografía calculada sin forzar sobreposiciones 1:1 rígidas.
- **Proceso**:
  1. Carga inicial de la Máscara y generación de la **Zona de Contexto dilata** (`cv.dilate`).
  2. Conversión de la Portada Original y la Imagen Limpia a escala de grises (`cv.COLOR_RGBA2GRAY`).
  3. Detección de puntos clave y descriptores con `cv.ORB(10000)`.
  4. Coincidencia con `cv.BFMatcher` usando distancia de Hamming (`cv.NORM_HAMMING`).
  5. Filtrado de matches mediante el Test de Razón de Lowe (límite `0.80`) y clasificación según su proximidad a la Zona de Contexto de la Máscara.
  6. Cálculo de la matriz homográfica focalizada con `cv.findHomography` usando `cv.RANSAC` (umbral de descarte `5.0`) sobre los puntos cercanos a las máscaras.
  7. Validación de inliers ($\ge 4$) y aplicación de la homografía $H$. Si `param-fallback-direct` está desactivado (por defecto), la homografía calculada se aplica obligatoriamente para preservar los encuadres de IA. Si la opción de fallback está activada por el usuario y la homografía falla, se permite la sustitución directa 1:1.
  8. Transformación de perspectiva de la limpia con `cv.warpPerspective` usando interpolación lineal (`cv.INTER_LINEAR`).

### 3. Métodos de Ajuste de Color (Color Match)

- Los modos **Ajuste General** (`color-match`) y **Ajuste Local** (`color-match-local`) son mutuamente exclusivos en la interfaz.
- **Estadísticas (Stats)**: Coincidencia del valor de media y desviación estándar canal por canal en espacio de color RGB.
- **Reinhard**: Igual que Stats pero mapeando los canales en el espacio de color perceptual Lab (`cv.COLOR_RGB2Lab` y vuelta).
- **LUT (Histogram Matching)**: Mapeo de histogramas mediante igualación de la función de distribución acumulada (CDF) de los canales calculada vía `cv.calcHist` y aplicada con `cv.LUT`.
- **Modo Local (`color-match-local`)**:
  1. Dilata la máscara de texto original usando un kernel de unos (`cv.dilate`) del tamaño del slider.
  2. Resta la máscara original a la dilatada para obtener un **anillo de contexto de fondo** (píxeles sanos adyacentes al texto).
  3. Calcula las estadísticas de color únicamente sobre ese anillo de contexto.
  4. Aplica la corrección de color y la inserta (`copyTo`) únicamente en los píxeles internos de la máscara original.

### 4. Mezcla Final y Compresión de Descarga

- Aplica un difuminado gaussiano (`cv.GaussianBlur`) sobre la máscara gris (`maskGray`) usando el valor de blur seleccionado para suavizar los bordes.
- La combinación final de píxeles se realiza mediante un bucle de alta velocidad en JavaScript sobre arrays de tipo `Uint8ClampedArray` (evitando conversiones pesadas en OpenCV.js) aplicando la fórmula:
  $$\text{Resultado} = \text{Original} \times (1 - M) + \text{LimpiaAlineadaCorregida} \times M$$
  donde $M$ es el valor del píxel de la máscara difuminada normalizado $[0, 1]$.
- **Exportación PNG Optimizado**: Se utiliza la librería `UPNG.js` asistida por `pako` para codificar la imagen restaurada final con compresión de nivel 9 y espacio de color RGB de 24 bits.

### 5. Editor de Máscara Interactivo

- **Estructura**: Un wrapper absoluto `.canvas-wrapper` dentro de `.editor-canvas-container` con `overflow: hidden`.
- **Zoom y Pan**: Implementados modificando el estilo de transformación CSS `translate(editorPanX, editorPanY) scale(editorScale)` mediante rueda de ratón (zoom) y arrastre con botón derecho, botón central del ratón, la herramienta Mover o manteniendo presionada la barra espaciadora.
- **Conversión de Coordenadas**: Para dibujar con exactitud en la resolución nativa de la imagen, las coordenadas de pantalla se recalculan restando el desplazamiento y dividiendo entre la escala actual:
  $$\text{Local} = \frac{\text{Pantalla} - \text{Pan}}{\text{Escala}}$$
- **Edición**: Al cargar una máscara preexistente (por ejemplo, subida por archivo), si no cuenta con canal alpha, el editor mapea los píxeles oscuros ($R,G,B < 50$) a transparente y fuerza los píxeles claros a blanco sólido, permitiendo editar máscaras exportadas de Krita/Photoshop de inmediato.
- **Deshacer (Undo)**: Soporte para atajo `Ctrl+Z` (o `Cmd+Z`) para revertir trazos de dibujo/borrador o limpieza general, gestionado a través de una pila de estados (`undoStack`) con un tope de 25 capturas mediante `getImageData`.
- **Control del Ciclo de Vida**: Al guardar la máscara desde el editor o subirla externamente, se habilitan los botones `.btn-remove-file` para eliminarla y `.btn-edit-mask` para reabrirla en el lienzo interactivo.
- **Confirmación Integrada**: El borrado total ("Limpiar Todo") se asiste con un modal personalizado (`#confirm-modal`) que evita bloqueos del navegador mediante promesas.
- **Estabilidad del Slider**: Rango de opacidad configurado con paso `0.1` y visualización estática formateada (`toFixed(1)`) de ancho fijo en CSS para mitigar el desplazamiento de componentes adyacentes.

### 6. Deslizador de Comparación Estático

- El manejador `#compare-handle` es hijo de `.compare-viewer` (estático), manteniéndose siempre visible en pantalla sin importar el zoom del lienzo.
- Al cambiar el zoom, el paneo, o arrastrar el deslizador, se actualiza el porcentaje de recorte local convirtiendo el porcentaje de pantalla estático a coordenadas locales del lienzo usando la transformación activa, aplicando un `clip-path: inset(0 0 0 localPercent%)` a la capa superior.

### 7. Guía Integrada de Parámetros

- **Iconos de Información (`.btn-info-icon`)**: Botones SVG vectoriales `(i)` ubicados junto a cada opción en la sección de parámetros de `index.html`.
- **Modal Interactivo (`#guide-modal`)**: Presenta tarjetas detalladas para cada parámetro de la aplicación, desglosando la descripción corta, pros, contras, advertencias y recomendaciones de uso para guiar a usuarios casuales.
- **Navegación Focalizada (`setupParameterGuide`)**: Hacer clic en el icono de información de cualquier opción abre la guía e inmediatamente resalta y desplaza la vista suavemente hacia la tarjeta explicativa correspondiente.

### 8. Motor de Super-resolución Waifu2x Client-Side (ONNX Runtime Web)

- **Origen y Ejecución**: Implementado en `waifu2x-engine.js` mediante la librería **ONNX Runtime Web** (`ort.webgpu.min.js`). Corre **100% del lado del cliente** en el navegador del usuario utilizando aceleración **WebGPU** (con fallback automático a WebAssembly **WASM** multi-hilo).
- **Modelos Compatibles**: Modelos ONNX de Waifu2x (`models-cunet` optimizado para novelas ligeras/anime y `models-upconv_7_anime`), parametrizados por nivel de reducción de ruido (`noise0` a `noise3`) y factor de escala (`2x` y `4x` mediante pasadas secuenciales `2x`).
- **Algoritmo de Teselado (Tiling con Overlap)**:
  - Divide la imagen fuente en cuadrículas de teselas de tamaño configurable (por defecto `256px`) con solapamiento exterior (`overlap` de `16px`).
  - Previene caídas por memoria VRAM/RAM (OOM o WebGL Context Loss) al procesar portadas en alta resolución.
  - Recorta el margen de overlap en cada tesela inferida antes de coser la imagen final, eliminando artefactos de costura o borde (seam lines).
- **Disposición de Tensores VRAM**: Todos los tensores de inferencia (`inputTensor` y mapas de salida de `session.run`) se descartan explícitamente mediante `.dispose()` en cada iteración de tesela, evitando fugas de memoria en la GPU.
- **Integración con Pipeline de Alineación**:
  - Al activar la casilla `param-waifu2x`, la imagen limpia (`imgClean`) se intercepta y procesa primero en el motor Waifu2x.
  - La imagen súper-resuelta y descontaminada de ruido resultante reemplaza la limpia original antes de la extracción de puntos clave ORB y la alineación por homografía $H$ en OpenCV.js.

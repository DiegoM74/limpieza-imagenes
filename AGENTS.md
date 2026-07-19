# Documentación para Agentes de IA (AGENTS.md)

Este documento describe la arquitectura y la lógica interna de este proyecto para que cualquier modelo de IA pueda comprenderlo y modificarlo de forma inmediata sin necesidad de análisis exploratorio redundante.

---

## Objetivo del Proyecto
Limpieza y restauración de portadas de novelas ligeras eliminando las zonas de texto y reemplazándolas por áreas correspondientes de una imagen limpia (sin texto). Para preservar el arte original al 100%, solo se modifican los píxeles demarcados por una máscara, alineando ambas imágenes y ajustando sus colores para que la fusión sea imperceptible.

---

## Estructura de Archivos
*   `cover_editor.py`: Script de terminal original en Python. Utiliza OpenCV (SIFT + RANSAC) y Pillow para alinear, ajustar el color (Stats, Reinhard, LUT) y aplicar la máscara.
*   `index.html`: Estructura HTML de la aplicación web (SPA estática para Cloudflare Pages).
*   `style.css`: Hoja de estilos en modo oscuro sólido. Usa variables CSS globales para colores y la tipografía única *Open Sans*. Centrada en PC.
*   `app.js`: Lógica de procesamiento en el cliente (JavaScript) usando OpenCV.js y Canvas.
*   `icons.svg`: Sprite SVG con los símbolos vectoriales de los iconos utilizados en la interfaz.

---

## Especificaciones Técnicas de la Aplicación Web

### 1. Motor de Visión Computacional (OpenCV.js)
*   **Origen**: Carga asíncrona mediante WebAssembly desde `https://docs.opencv.org/4.x/opencv.js`.
*   **Representación**: OpenCV.js lee las imágenes del DOM en formato RGBA (`CV_8UC4`).

### 2. Algoritmo de Alineación (Homografía)
*   Dado que SIFT no está disponible por defecto en compilaciones estándar de OpenCV.js, se implementa **ORB** (Oriented FAST and Rotated BRIEF).
*   **Proceso**:
    1.  Conversión de la Portada Original y la Imagen Limpia a escala de grises (`cv.COLOR_RGBA2GRAY`).
    2.  Detección de puntos clave y descriptores con `cv.ORB`.
    3.  Coincidencia con `cv.BFMatcher` usando distancia de Hamming (`cv.NORM_HAMMING`).
    4.  Filtrado de matches mediante el Test de Razón de Lowe (límite `0.75`).
    5.  Cálculo de la matriz homográfica con `cv.findHomography` usando el método `cv.RANSAC` (umbral de descarte `5.0`).
    6.  Transformación de perspectiva de la limpia con `cv.warpPerspective` usando interpolación lineal (`cv.INTER_LINEAR`).

### 3. Métodos de Ajuste de Color (Color Match)
*   **Estadísticas (Stats)**: Coincidencia del valor de media y desviación estándar canal por canal en espacio de color RGB.
*   **Reinhard**: Igual que Stats pero mapeando los canales en el espacio de color perceptual Lab (`cv.COLOR_RGB2Lab` y vuelta).
*   **LUT (Histogram Matching)**: Mapeo de histogramas mediante igualación de la función de distribución acumulada (CDF) de los canales calculada vía `cv.calcHist` y aplicada con `cv.LUT`.
*   **Modo Local (`color-match-local`)**: 
    1.  Dilata la máscara de texto original usando un kernel de unos (`cv.dilate`) del tamaño del slider.
    2.  Resta la máscara original a la dilatada para obtener un **anillo de contexto de fondo** (píxeles sanos adyacentes al texto).
    3.  Calcula las estadísticas de color únicamente sobre ese anillo de contexto.
    4.  Aplica la corrección de color y la inserta (`copyTo`) únicamente en los píxeles internos de la máscara original.

### 4. Mezcla Final (Compositing)
*   Aplica un difuminado gaussiano (`cv.GaussianBlur`) sobre la máscara gris (`maskGray`) usando el valor de blur seleccionado para suavizar los bordes.
*   La combinación final de píxeles se realiza mediante un bucle de alta velocidad en JavaScript sobre arrays de tipo `Uint8ClampedArray` (evitando conversiones pesadas en OpenCV.js) aplicando la fórmula:
    $$\text{Resultado} = \text{Original} \times (1 - M) + \text{LimpiaAlineadaCorregida} \times M$$
    donde $M$ es el valor del píxel de la máscara difuminada normalizado $[0, 1]$.

### 5. Editor de Máscara Interactivo
*   **Estructura**: Un wrapper absoluto `.canvas-wrapper` dentro de `.editor-canvas-container` con `overflow: hidden`.
*   **Zoom y Pan**: Implementados modificando el estilo de transformación CSS `translate(editorPanX, editorPanY) scale(editorScale)` mediante rueda de ratón (zoom) y arrastre con botón derecho, botón central del ratón, la herramienta Mover o manteniendo presionada la barra espaciadora.
*   **Conversión de Coordenadas**: Para dibujar con exactitud en la resolución nativa de la imagen, las coordenadas de pantalla se recalculan restando el desplazamiento y dividiendo entre la escala actual:
    $$\text{Local} = \frac{\text{Pantalla} - \text{Pan}}{\text{Escala}}$$
*   **Edición**: Al cargar una máscara preexistente (por ejemplo, subida por archivo), si no cuenta con canal alpha, el editor mapea los píxeles oscuros ($R,G,B < 50$) a transparente y fuerza los píxeles claros a blanco sólido, permitiendo editar máscaras exportadas de Krita/Photoshop de inmediato.
*   **Deshacer (Undo)**: Soporte para atajo `Ctrl+Z` (o `Cmd+Z`) para revertir trazos de dibujo/borrador o limpieza general, gestionado a través de una pila de estados (`undoStack`) con un tope de 25 capturas mediante `getImageData`.
*   **Control del Ciclo de Vida**: Al guardar la máscara desde el editor o subirla externamente, se habilitan los botones `.btn-remove-file` para eliminarla y `.btn-edit-mask` para reabrirla en el lienzo interactivo.
*   **Confirmación Integrada**: El borrado total ("Limpiar Todo") se asiste con un modal personalizado (`#confirm-modal`) que evita bloqueos del navegador mediante promesas.
*   **Estabilidad del Slider**: Rango de opacidad configurado con paso `0.1` y visualización estática formateada (`toFixed(1)`) de ancho fijo en CSS para mitigar el desplazamiento de componentes adyacentes.

### 6. Deslizador de Comparación Estático
*   El manejador `#compare-handle` es hijo de `.compare-viewer` (estático), manteniéndose siempre visible en pantalla sin importar el zoom del lienzo.
*   Al cambiar el zoom, el paneo, o arrastrar el deslizador, se actualiza el porcentaje de recorte local convirtiendo el porcentaje de pantalla estático a coordenadas locales del lienzo usando la transformación activa, aplicando un `clip-path: inset(0 0 0 localPercent%)` a la capa superior.

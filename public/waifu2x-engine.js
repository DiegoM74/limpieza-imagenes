/**
 * ==============================================================================
 * Motor de Super-resolución Waifu2x Client-Side (waifu2x-engine.js)
 * ==============================================================================
 * Inferencia de redes neuronales Waifu2x (CUnet y UpConv_7) corriendo 100% en el
 * navegador del usuario mediante ONNX Runtime Web con aceleración WebGPU
 * (y fallback automático a WebAssembly WASM multi-hilo).
 *
 * Implementa teselado (tiling) con solapamiento (overlap) para prevenir errores
 * de memoria VRAM/RAM y réplica simétrica de bordes para evitar artefactos.
 *
 * Para más información técnica consultar AGENTS.md.
 * ==============================================================================
 */

window.Waifu2xEngine = (function () {
  "use strict";

  let sessionCache = {};
  let currentBackend = "detecting";

  /**
   * Detecta si WebGPU está soportado en el navegador del usuario.
   * @returns {Promise<string>} Nombre descriptivo del backend activo.
   */
  async function detectBackend() {
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          currentBackend = "webgpu";
          return "WebGPU (Acelerado por GPU)";
        }
      } catch (e) {
        console.warn("[Waifu2xEngine] Error al inicializar WebGPU:", e);
      }
    }
    currentBackend = "wasm";
    return "WebAssembly (CPU)";
  }

  /**
   * Genera las posibles rutas locales y URLs CDN del modelo ONNX según los parámetros.
   */
  function getModelUrls(modelType, noiseLevel, scaleFactor, basePath = "") {
    const prefix = modelType === "upconv" ? "upconv_7" : "cunet";
    const noise =
      noiseLevel === "none" || noiseLevel === "0" ? "0" : noiseLevel;

    let fileName = `noise${noise}_scale2x.onnx`;
    if (noise === "0" && scaleFactor !== "1x") {
      fileName = "scale2x.onnx";
    } else if (scaleFactor === "1x" || scaleFactor === "none") {
      fileName = `noise${noise}.onnx`;
    }

    return [
      `${basePath}models/waifu2x/onnx_models/${prefix}/art/${fileName}`,
      `${basePath}models/waifu2x/${prefix}/art/${fileName}`,
      `${basePath}models/waifu2x/${prefix}_${fileName}`,
      `${basePath}models/waifu2x/${fileName}`,
      `https://raw.githubusercontent.com/nagadomi/nunif/master/waifu2x/onnx_models/${prefix}/art/${fileName}`,
    ];
  }

  /**
   * Carga e inicializa la sesión de ONNX Runtime Web con caché de modelos.
   */
  async function getOrCreateSession(
    modelType,
    noiseLevel,
    scaleFactor,
    logCallback,
    basePath = ""
  ) {
    const key = `${modelType}_${noiseLevel}_${scaleFactor}`;
    if (sessionCache[key]) {
      return sessionCache[key];
    }

    if (typeof ort === "undefined") {
      throw new Error(
        "ONNX Runtime Web (ort) no está disponible en la página.",
      );
    }

    // Configurar nivel de log e hilos de WebAssembly adaptados al entorno
    if (ort.env) {
      ort.env.logLevel = "error";
      if (ort.env.wasm) {
        if (!window.crossOriginIsolated) {
          ort.env.wasm.numThreads = 1;
        } else {
          ort.env.wasm.numThreads = Math.max(
            1,
            (navigator.hardwareConcurrency || 4) - 1,
          );
        }
      }
    }

    const candidates = getModelUrls(modelType, noiseLevel, scaleFactor, basePath);
    let session = null;
    let lastError = null;

    const providers =
      currentBackend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];

    if (logCallback)
      logCallback(
        `Cargando modelo neuronal Waifu2x ONNX (${modelType} Ruido:${noiseLevel})...`,
      );

    for (const url of candidates) {
      try {
        session = await ort.InferenceSession.create(url, {
          executionProviders: providers,
          logSeverityLevel: 3,
          logVerbosityLevel: 3,
        });
        console.log(
          `[Waifu2xEngine] Modelo ONNX cargado correctamente desde: ${url}`,
        );
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!session) {
      console.error("[Waifu2xEngine] Error al cargar modelo ONNX:", lastError);
      throw new Error(
        `No se encontró el modelo ONNX real de Waifu2x. Por favor ejecuta 'python download_models.py' en la terminal.`,
      );
    }

    sessionCache[key] = session;
    return session;
  }

  /**
   * Pausa asíncrona fluida para liberar el hilo de animación del navegador (UI).
   */
  function yieldToUI() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } else {
        setTimeout(resolve, 10);
      }
    });
  }

  /**
   * Inferencia de súper-resolución mediante Red Neuronal Waifu2x por Teselas.
   *
   * @param {HTMLCanvasElement|HTMLImageElement|ImageData} inputSource Fuente de la imagen.
   * @param {Object} options Opciones de ejecución: { model, noise, scale, tileSize, overlap }
   * @param {Function} progressCallback Callback de progreso: (percent, msg)
   * @returns {Promise<HTMLCanvasElement>} Canvas resultante reescalado por la red neuronal.
   */
  async function processImage(
    inputSource,
    options = {},
    progressCallback = null,
  ) {
    const modelType = options.model || "cunet";
    const noiseLevel = options.noise || "2";
    const requestedScale = options.scale || "2x";
    const tileSize = options.tileSize || 256;
    const overlap = options.overlap || 16;
    const basePath = options.modelBasePath || "";
    const margin = 14; // Margen convolucional U-Net CUnet

    // Normalizar fuente de entrada a un HTMLCanvasElement
    let srcW, srcH, srcCtx;
    if (inputSource instanceof HTMLCanvasElement) {
      srcW = inputSource.width;
      srcH = inputSource.height;
      srcCtx = inputSource.getContext("2d", { willReadFrequently: true });
    } else if (
      inputSource instanceof HTMLImageElement ||
      inputSource instanceof Image ||
      (inputSource && inputSource.tagName === "IMG")
    ) {
      srcW = inputSource.naturalWidth || inputSource.width;
      srcH = inputSource.naturalHeight || inputSource.height;
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = srcW;
      tmpCanvas.height = srcH;
      srcCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
      srcCtx.drawImage(inputSource, 0, 0, srcW, srcH);
      inputSource = tmpCanvas;
    } else if (inputSource instanceof ImageData) {
      srcW = inputSource.width;
      srcH = inputSource.height;
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = srcW;
      tmpCanvas.height = srcH;
      srcCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
      srcCtx.putImageData(inputSource, 0, 0);
      inputSource = tmpCanvas;
    } else {
      throw new Error("Fuente de imagen no válida para Waifu2xEngine.");
    }

    if (currentBackend === "detecting") {
      await detectBackend();
    }

    const numPasses = requestedScale === "4x" ? 2 : 1;
    let currentCanvas = inputSource;

    const tmpTileCanvas = document.createElement("canvas");
    const tmpTileCtx = tmpTileCanvas.getContext("2d", {
      willReadFrequently: true,
    });

    for (let pass = 1; pass <= numPasses; pass++) {
      const passNoise = pass === 1 ? noiseLevel : "0";
      const passW = currentCanvas.width;
      const passH = currentCanvas.height;
      const targetW = passW * 2;
      const targetH = passH * 2;

      const passCtx = currentCanvas.getContext("2d", {
        willReadFrequently: true,
      });

      const session = await getOrCreateSession(
        modelType,
        passNoise,
        "2x",
        (msg) => {
          if (progressCallback) progressCallback(0, msg);
        },
        basePath
      );

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = targetW;
      outputCanvas.height = targetH;
      const outCtx = outputCanvas.getContext("2d", {
        willReadFrequently: true,
      });

      const numTilesX = Math.ceil(passW / tileSize);
      const numTilesY = Math.ceil(passH / tileSize);
      const totalTiles = numTilesX * numTilesY;
      let completedTiles = 0;

      const padLeftTarget = overlap + margin;
      const padTopTarget = overlap + margin;
      const padRightTarget = overlap + margin;
      const padBottomTarget = overlap + margin;

      for (let ty = 0; ty < numTilesY; ty++) {
        for (let tx = 0; tx < numTilesX; tx++) {
          const tileX = tx * tileSize;
          const tileY = ty * tileSize;
          const tileW = Math.min(tileSize, passW - tileX);
          const tileH = Math.min(tileSize, passH - tileY);

          const readX = Math.max(0, tileX - padLeftTarget);
          const readY = Math.max(0, tileY - padTopTarget);
          const readRight = Math.min(passW, tileX + tileW + padRightTarget);
          const readBottom = Math.min(passH, tileY + tileH + padBottomTarget);

          const readW = readRight - readX;
          const readH = readBottom - readY;

          const actualPadLeft = tileX - readX;
          const actualPadTop = tileY - readY;

          const padAlignW =
            Math.ceil((tileW + padLeftTarget + padRightTarget) / 16) * 16;
          const padAlignH =
            Math.ceil((tileH + padTopTarget + padBottomTarget) / 16) * 16;

          const tileData = passCtx.getImageData(readX, readY, readW, readH);

          const tileResult = await processTileOnnx(
            session,
            tileData,
            readW,
            readH,
            actualPadLeft,
            actualPadTop,
            padLeftTarget,
            padTopTarget,
            padAlignW,
            padAlignH,
          );

          const { outImageData, outW, outH } = tileResult;

          // Ajustar dimensiones del canvas temporal solo si es necesario (evita reset de contexto)
          if (tmpTileCanvas.width !== outW || tmpTileCanvas.height !== outH) {
            tmpTileCanvas.width = outW;
            tmpTileCanvas.height = outH;
          }
          tmpTileCtx.putImageData(outImageData, 0, 0);

          // Cálculo del encogimiento dinámico de convolución (shrinkage) de CUnet
          const shrinkW = Math.max(0, Math.round((padAlignW * 2 - outW) / 2));
          const shrinkH = Math.max(0, Math.round((padAlignH * 2 - outH) / 2));

          const cropX = padLeftTarget * 2 - shrinkW;
          const cropY = padTopTarget * 2 - shrinkH;
          const cropW = tileW * 2;
          const cropH = tileH * 2;

          outCtx.drawImage(
            tmpTileCanvas,
            cropX,
            cropY,
            cropW,
            cropH,
            tileX * 2,
            tileY * 2,
            cropW,
            cropH,
          );

          completedTiles++;
          const percent = Math.floor((completedTiles / totalTiles) * 100);
          if (progressCallback) {
            const passMsg =
              numPasses > 1 ? ` Pasada ${pass}/${numPasses}: ` : " ";
            progressCallback(
              percent,
              `Waifu2x ${passMsg}Procesando tesela ${completedTiles}/${totalTiles} (${percent}%)...`,
            );
          }

          await yieldToUI();
        }
      }

      currentCanvas = outputCanvas;
    }

    return currentCanvas;
  }

  /**
   * Inferencia neuronal de ONNX Runtime en una única tesela (tile) con gestión segura de memoria VRAM.
   */
  async function processTileOnnx(
    session,
    tileImageData,
    rawW,
    rawH,
    actualPadLeft,
    actualPadTop,
    padLeftTarget,
    padTopTarget,
    padAlignW,
    padAlignH,
  ) {
    const inputSize = padAlignW * padAlignH;
    const float32Data = new Float32Array(3 * inputSize);
    const src = tileImageData.data;

    const offsetX = padLeftTarget - actualPadLeft;
    const offsetY = padTopTarget - actualPadTop;

    // Rellenar el tensor [1, 3, padAlignH, padAlignW] con replicación de bordes exacta
    for (let y = 0; y < padAlignH; y++) {
      const srcY = y - offsetY;
      const srcYClamped = Math.min(Math.max(0, srcY), rawH - 1);

      for (let x = 0; x < padAlignW; x++) {
        const srcX = x - offsetX;
        const srcXClamped = Math.min(Math.max(0, srcX), rawW - 1);

        const srcIdx = (srcYClamped * rawW + srcXClamped) * 4;
        const dstIdx = y * padAlignW + x;

        float32Data[dstIdx] = src[srcIdx] / 255.0; // Canal R
        float32Data[inputSize + dstIdx] = src[srcIdx + 1] / 255.0; // Canal G
        float32Data[2 * inputSize + dstIdx] = src[srcIdx + 2] / 255.0; // Canal B
      }
    }

    const inputName = session.inputNames[0];
    const inputTensor = new ort.Tensor("float32", float32Data, [
      1,
      3,
      padAlignH,
      padAlignW,
    ]);
    let results = null;

    try {
      const feeds = {};
      feeds[inputName] = inputTensor;

      results = await session.run(feeds);

      const outputName = session.outputNames[0];
      const outputTensor = results[outputName] || Object.values(results)[0];

      if (!outputTensor) {
        throw new Error(
          "La inferencia de ONNX Runtime no devolvió un tensor de salida.",
        );
      }

      let outData = null;
      if (typeof outputTensor.getData === "function") {
        outData = await outputTensor.getData();
      } else {
        outData = outputTensor.data;
      }

      if (!outData || outData.length === 0) {
        throw new Error(
          "No se pudieron extraer los datos del tensor de salida.",
        );
      }

      const dims = outputTensor.dims || [1, 3, padAlignH * 2, padAlignW * 2];
      const outH = dims[2] || padAlignH * 2;
      const outW = dims[3] || padAlignW * 2;
      const planeSize = outH * outW;

      const outImageData = new ImageData(outW, outH);
      const dst = outImageData.data;

      // Conversión NCHW Float32 [0.0 - 1.0] -> RGBA (Uint8)
      for (let i = 0; i < planeSize; i++) {
        let r = outData[i] * 255.0;
        let g = outData[planeSize + i] * 255.0;
        let b = outData[2 * planeSize + i] * 255.0;

        dst[i * 4] = Math.min(255, Math.max(0, r));
        dst[i * 4 + 1] = Math.min(255, Math.max(0, g));
        dst[i * 4 + 2] = Math.min(255, Math.max(0, b));
        dst[i * 4 + 3] = 255;
      }

      return { outImageData, outW, outH };
    } finally {
      // Liberar tensores VRAM / RAM explícitamente en ONNX Runtime
      if (inputTensor && typeof inputTensor.dispose === "function") {
        try {
          inputTensor.dispose();
        } catch (_) {}
      }
      if (results) {
        for (const k in results) {
          if (results[k] && typeof results[k].dispose === "function") {
            try {
              results[k].dispose();
            } catch (_) {}
          }
        }
      }
    }
  }

  return {
    detectBackend,
    processImage,
    getBackendName: () => currentBackend,
  };
})();

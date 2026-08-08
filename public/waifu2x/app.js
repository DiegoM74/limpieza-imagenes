/**
 * ==============================================================================
 * Escalador Waifu2x por Lotes (app.js)
 * ==============================================================================
 */

let openCvLoaded = false;
let filesList = []; // Archivos originales
let processedResults = []; // Resultados procesados: { id, name, originalSize, originalRes, finalSize, finalRes, blob, originalDataUrl, finalDataUrl }

// Estado del visor de comparación
let compareScale = 1;
let comparePanX = 0;
let comparePanY = 0;
let compareIsPanning = false;
let compareStartX = 0;
let compareStartY = 0;
let compareIsSliding = false;
let compareSliderPercent = 50;
let activeCompareContainer = null;

// ==========================================================
// Inicialización
// ==========================================================

window.addEventListener("DOMContentLoaded", () => {
  setupDropzone();
  setupParameterGuide();
  initWaifu2xBackend();
  setupCompareViewer();

  document.getElementById("btn-process").addEventListener("click", processBatch);
  document.getElementById("btn-download").addEventListener("click", downloadResults);
  document.getElementById("btn-clear-all").addEventListener("click", clearAllFiles);
});

function onOpenCvReady() {
  openCvLoaded = true;
  document.getElementById("loading-overlay").style.display = "none";
  log("OpenCV.js cargado correctamente.", "success");
}

function onOpenCvError() {
  alert("Error al cargar OpenCV.js.");
}

async function initWaifu2xBackend() {
  if (typeof Waifu2xEngine !== "undefined") {
    const backendName = await Waifu2xEngine.detectBackend();
    const badge = document.getElementById("waifu2x-backend-badge");
    if (badge) {
      badge.innerText = backendName;
      if (backendName.includes("WebGPU")) badge.className = "badge badge-recommended";
    }
  }
}

// ==========================================================
// UI y Logs
// ==========================================================

function log(msg, type = "info") {
  const consoleBox = document.getElementById("console-output");
  if (!consoleBox) return;
  consoleBox.style.display = "block";
  let prefix = "[*]";
  if (type === "success") prefix = "[+]";
  if (type === "error") prefix = "[-]";
  consoleBox.innerText += `${prefix} ${msg}\n`;
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function clearLog() {
  const consoleBox = document.getElementById("console-output");
  if (consoleBox) consoleBox.innerText = "";
}

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// ==========================================================
// Guía de Opciones
// ==========================================================
function setupParameterGuide() {
  const modal = document.getElementById("guide-modal");
  const btnOpenGuide = document.getElementById("btn-open-guide");
  const btnClose = document.getElementById("guide-modal-close");
  const btnAccept = document.getElementById("guide-modal-accept");
  const infoButtons = document.querySelectorAll(".btn-info-icon");

  if (!modal) return;

  function openGuide(targetCardId = null) {
    modal.style.display = "flex";
    document.querySelectorAll(".guide-card").forEach(c => c.classList.remove("guide-card-highlight"));
    if (targetCardId) {
      const targetCard = document.getElementById(targetCardId);
      if (targetCard) {
        targetCard.classList.add("guide-card-highlight");
        setTimeout(() => targetCard.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
      }
    }
  }

  function closeGuide() { modal.style.display = "none"; }

  if (btnOpenGuide) btnOpenGuide.addEventListener("click", () => openGuide());
  if (btnClose) btnClose.addEventListener("click", closeGuide);
  if (btnAccept) btnAccept.addEventListener("click", closeGuide);
  window.addEventListener("click", (e) => { if (e.target === modal) closeGuide(); });
  
  infoButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGuide(btn.getAttribute("data-guide-target"));
    });
  });
}

// ==========================================================
// Carga de Archivos
// ==========================================================

function setupDropzone() {
  const dz = document.getElementById("dz-multiple");
  const input = document.getElementById("input-images");

  dz.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    input.click();
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });

  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));

  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  });

  input.addEventListener("change", () => {
    if (input.files.length > 0) {
      addFiles(input.files);
      input.value = "";
    }
  });
}

function addFiles(newFiles) {
  for (let file of newFiles) {
    if (file.type.startsWith("image/")) {
      filesList.push({
        id: "file_" + Date.now() + "_" + Math.floor(Math.random()*1000),
        file: file,
        name: file.name,
        size: file.size
      });
    }
  }
  updateFilesUI();
}

function clearAllFiles() {
  filesList = [];
  processedResults = [];
  updateFilesUI();
  document.getElementById("btn-download").disabled = true;
  document.getElementById("summary-output").style.display = "none";
}

function updateFilesUI() {
  const btnProcess = document.getElementById("btn-process");
  const btnClear = document.getElementById("btn-clear-all");
  const resultsContainer = document.getElementById("results-list");

  if (filesList.length > 0) {
    btnProcess.disabled = false;
    btnClear.disabled = false;
    
    // Mostrar lista antes de procesar
    resultsContainer.innerHTML = "";
    filesList.forEach((item, idx) => {
      const div = document.createElement("div");
      div.className = "result-item";
      div.id = `item-row-${item.id}`;
      // Usamos createObjectURL temporal para la miniatura inicial
      const tempUrl = URL.createObjectURL(item.file);
      div.innerHTML = `
        <img src="${tempUrl}" class="result-thumb" />
        <div class="result-info">
          <div class="result-name">${item.name}</div>
          <div class="result-meta" id="meta-${item.id}">
            Pendiente de proceso (${formatBytes(item.size)})
          </div>
        </div>
        <div class="result-actions" id="actions-${item.id}">
          <button class="btn btn-danger" onclick="removeOriginalFile(${idx})">Eliminar</button>
        </div>
      `;
      resultsContainer.appendChild(div);
    });

  } else {
    btnProcess.disabled = true;
    btnClear.disabled = true;
    resultsContainer.innerHTML = '<p class="empty-results">No hay imágenes cargadas.</p>';
  }
}

window.removeOriginalFile = function(idx) {
  filesList.splice(idx, 1);
  updateFilesUI();
};

// ==========================================================
// Comprobación rápida de canal Alpha
// ==========================================================
function hasTransparency(ctx, width, height) {
  const imgData = ctx.getImageData(0, 0, width, height).data;
  // Muestreo rápido cada 16 píxeles para ser muy veloces
  for (let i = 3; i < imgData.length; i += 16) {
    if (imgData[i] < 255) return true;
  }
  // Revisión fina en bordes por si acaso
  for (let i = 3; i < imgData.length; i += 4) {
    if (imgData[i] < 255) return true;
  }
  return false;
}

function canvasToBlobAsync(canvas, mimeType, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
}

// ==========================================================
// PIPELINE (Waifu2x + OpenCV Resize)
// ==========================================================

async function processBatch() {
  if (filesList.length === 0) return;
  if (!openCvLoaded) {
    alert("OpenCV.js sigue cargando, espera unos segundos.");
    return;
  }

  document.getElementById("btn-process").disabled = true;
  clearLog();
  log(`Iniciando procesamiento por lotes de ${filesList.length} imagen(es)...`, "info");
  
  const targetRes = parseInt(document.getElementById("param-target-res").value);
  const wScale = document.getElementById("param-waifu2x-scale").value;
  const wNoise = document.getElementById("param-waifu2x-noise").value;
  const wModel = document.getElementById("param-waifu2x-model").value;

  processedResults = [];
  document.getElementById("btn-download").disabled = true;
  document.getElementById("summary-output").style.display = "none";

  let totalOriginalSize = 0;
  let totalFinalSize = 0;

  for (let i = 0; i < filesList.length; i++) {
    const item = filesList[i];
    
    // Actualizar UI
    const metaDiv = document.getElementById(`meta-${item.id}`);
    if(metaDiv) metaDiv.innerHTML = "<strong>Procesando...</strong>";
    const actionsDiv = document.getElementById(`actions-${item.id}`);
    if(actionsDiv) actionsDiv.innerHTML = ""; // Quitar botón de eliminar mientras procesa

    log(`\n[${i+1}/${filesList.length}] Procesando: ${item.name}`, "info");
    totalOriginalSize += item.size;
    await yieldToUI();

    try {
      // 1. Cargar original
      const origCanvas = document.createElement("canvas");
      const origCtx = origCanvas.getContext("2d", { willReadFrequently: true });
      const img = new Image();
      const origDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(item.file);
      });
      await new Promise(resolve => {
        img.onload = resolve;
        img.src = origDataUrl;
      });

      const origW = img.naturalWidth;
      const origH = img.naturalHeight;
      origCanvas.width = origW;
      origCanvas.height = origH;
      origCtx.drawImage(img, 0, 0);

      // Determinar dimensión principal según orientación
      const isVertical = origW <= origH;
      const relevantOriginalDim = isVertical ? origW : origH;
      const dimensionName = isVertical ? "Ancho" : "Alto";

      log(`Resolución original: ${origW}x${origH} (${dimensionName} relevante: ${relevantOriginalDim}px)`, "info");

      let currentCanvas = origCanvas;
      let wasProcessed = false;

      // 2. Aplicar Waifu2x si se solicitó upscale y la imagen no es más grande que el target
      if (wScale !== "none" && wScale !== "1x") {
        if (relevantOriginalDim >= targetRes) {
          log(`La dimensión original (${relevantOriginalDim}px) ya es igual o mayor al objetivo (${targetRes}px). Se omite Waifu2x.`, "info");
        } else {
          log(`Aplicando Waifu2x (Modelo: ${wModel}, Ruido: ${wNoise}, Escala: ${wScale})...`, "info");
          await yieldToUI();
          
          currentCanvas = await Waifu2xEngine.processImage(origCanvas, {
              model: wModel, noise: wNoise, scale: wScale, tileSize: 256, overlap: 16, modelBasePath: '../'
          }, (percent, msg) => {
              log(`[Waifu2x] ${msg}`, "info");
          });
          wasProcessed = true;
        }
      }

      const waifuW = currentCanvas.width;
      const waifuH = currentCanvas.height;
      const relevantWaifuDim = isVertical ? waifuW : waifuH;
      log(`Resolución post-Waifu2x: ${waifuW}x${waifuH} (${dimensionName}: ${relevantWaifuDim}px)`, "info");

      // 3. Evaluar resolución objetivo y hacer Downscale si sobrepasa
      let finalCanvas = currentCanvas;
      if (relevantWaifuDim > targetRes) {
        log(`La dimensión (${relevantWaifuDim}px) supera el objetivo (${targetRes}px). Aplicando downscale (INTER_AREA)...`, "info");
        await yieldToUI();

        // Calcular nuevo tamaño manteniendo Aspect Ratio
        let scaleFactor = targetRes / relevantWaifuDim;
        let finalW = Math.round(waifuW * scaleFactor);
        let finalH = Math.round(waifuH * scaleFactor);

        // Usar OpenCV.js para el redimensionamiento
        let srcMat = cv.imread(currentCanvas);
        let dstMat = new cv.Mat();
        let dsize = new cv.Size(finalW, finalH);
        
        // cv.INTER_AREA es el mejor filtro disponible en OpenCV para reducción de resolución
        cv.resize(srcMat, dstMat, dsize, 0, 0, cv.INTER_AREA);
        
        finalCanvas = document.createElement("canvas");
        finalCanvas.width = finalW;
        finalCanvas.height = finalH;
        cv.imshow(finalCanvas, dstMat);
        
        srcMat.delete();
        dstMat.delete();

        wasProcessed = true;
        log(`Downscale completado a: ${finalW}x${finalH}`, "success");
      } else {
        log(`La dimensión (${relevantWaifuDim}px) es <= al objetivo (${targetRes}px). No se requiere downscale.`, "success");
      }

      // 4. Exportación lossless solo si la imagen fue alterada
      let finalBlob, finalSize, finalDataUrl, finalResString;

      if (wasProcessed) {
        log("Codificando archivo resultante...", "info");
        await yieldToUI();

        const finalCtx = finalCanvas.getContext("2d", { willReadFrequently: true });
        const hasAlpha = hasTransparency(finalCtx, finalCanvas.width, finalCanvas.height);
        
        let mimeType, ext, quality;
        if (hasAlpha) {
          mimeType = "image/png";
          quality = undefined; // PNG es lossless siempre
          log("Se detectó transparencia. Exportando como PNG (Lossless).", "info");
        } else {
          mimeType = "image/jpeg";
          quality = 1.0; // Máxima calidad sin pérdida perceptible
          log("Imagen opaca. Exportando como JPG al 100% (Máxima calidad).", "info");
        }

        finalBlob = await canvasToBlobAsync(finalCanvas, mimeType, quality);
        finalSize = finalBlob.size;
        finalDataUrl = URL.createObjectURL(finalBlob);
        finalResString = `${finalCanvas.width}x${finalCanvas.height}`;
      } else {
        // Usar original intacto
        finalBlob = item.file;
        finalSize = item.size;
        finalDataUrl = origDataUrl;
        finalResString = `${origW}x${origH}`;
        log("La imagen se mantuvo intacta y no se re-codificó.", "success");
      }
      
      totalFinalSize += finalSize;

      const outName = item.name; // NO renombrar las imágenes

      const resData = {
        id: item.id,
        name: outName,
        originalSize: item.size,
        originalRes: `${origW}x${origH}`,
        finalSize: finalSize,
        finalRes: finalResString,
        blob: finalBlob,
        originalDataUrl: origDataUrl,
        finalDataUrl: finalDataUrl
      };
      
      processedResults.push(resData);
      
      // Actualizar fila existente con la info final
      const imgThumb = document.querySelector(`#item-row-${item.id} .result-thumb`);
      if(imgThumb) imgThumb.src = finalDataUrl;
      
      if(metaDiv) {
        metaDiv.innerHTML = `
          Original: <strong>${resData.originalRes}</strong> (${formatBytes(resData.originalSize)})<br/>
          Final: <strong>${resData.finalRes}</strong> (${formatBytes(resData.finalSize)})
        `;
      }
      if(actionsDiv) {
        const resIdx = processedResults.length - 1;
        actionsDiv.innerHTML = `
          <button class="btn btn-secondary" onclick="openCompareModal(${resIdx})">Comparar</button>
          <button class="btn btn-danger" onclick="removeResult(${resIdx}, '${item.id}')">Eliminar</button>
        `;
      }
      
    } catch (e) {
      log(`Error procesando ${item.name}: ${e.message}`, "error");
      const metaDiv = document.getElementById(`meta-${item.id}`);
      if(metaDiv) metaDiv.innerHTML = `<span class="empty-results" style="padding:0;">Error al procesar</span>`;
    }
  }

  log(`\nProcesamiento por lotes finalizado.`, "success");

  // Mostrar Resumen
  const summaryBox = document.getElementById("summary-output");
  summaryBox.innerHTML = `
    <div class="summary-stats">
      <div class="summary-stat-item">Procesadas: <strong style="color:var(--success-color)">${processedResults.length}</strong> / ${filesList.length}</div>
      <div class="summary-stat-item">Objetivo: <strong>${targetRes}px</strong></div>
      <div class="summary-stat-item">Original: <strong>${formatBytes(totalOriginalSize)}</strong></div>
      <div class="summary-stat-item">Final: <strong>${formatBytes(totalFinalSize)}</strong></div>
    </div>
  `;
  summaryBox.style.display = "block";

  if (processedResults.length > 0) {
    document.getElementById("btn-download").disabled = false;
  }
  document.getElementById("btn-process").disabled = false;
}

// ==========================================================
// Resultados UI
// ==========================================================

window.removeResult = function(idx, fileId) {
  processedResults.splice(idx, 1);
  
  // Remover fila del DOM
  const row = document.getElementById(`item-row-${fileId}`);
  if(row) row.remove();
  
  // Eliminar también de filesList original si se desea, o al menos limpiar si está vacío
  const fIdx = filesList.findIndex(f => f.id === fileId);
  if(fIdx > -1) filesList.splice(fIdx, 1);
  
  if (filesList.length === 0) {
     updateFilesUI();
  }

  // Re-asignar índices de los botones onclick
  processedResults.forEach((res, newIdx) => {
    const actionsDiv = document.getElementById(`actions-${res.id}`);
    if(actionsDiv) {
      actionsDiv.innerHTML = `
        <button class="btn btn-secondary" onclick="openCompareModal(${newIdx})">Comparar</button>
        <button class="btn btn-danger" onclick="removeResult(${newIdx}, '${res.id}')">Eliminar</button>
      `;
    }
  });

  if (processedResults.length === 0) {
    document.getElementById("btn-download").disabled = true;
    document.getElementById("summary-output").style.display = "none";
  }
};

// ==========================================================
// Descarga (ZIP o Archivo Simple)
// ==========================================================

async function downloadResults() {
  if (processedResults.length === 0) return;

  if (processedResults.length === 1) {
    // Descarga simple
    const res = processedResults[0];
    const a = document.createElement("a");
    a.href = res.finalDataUrl;
    a.download = res.name;
    a.click();
  } else {
    // Descarga ZIP usando JSZip (cargado via CDN)
    if (typeof JSZip === "undefined") {
      alert("La librería JSZip no está disponible.");
      return;
    }
    
    document.getElementById("btn-download").disabled = true;
    log("Empaquetando imágenes en archivo ZIP...", "info");
    await yieldToUI();

    const zip = new JSZip();
    processedResults.forEach(res => {
      // Usamos store porque las imágenes ya están comprimidas, re-comprimir un PNG/JPG gasta CPU inútilmente
      zip.file(res.name, res.blob, { compression: "STORE" });
    });

    zip.generateAsync({ type: "blob" }).then((content) => {
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = "imagenes_escaladas.zip";
      a.click();
      URL.revokeObjectURL(url);
      log("Descarga ZIP iniciada.", "success");
      document.getElementById("btn-download").disabled = false;
    });
  }
}

// ==========================================================
// Visor de Comparación (En Modal)
// ==========================================================

function setupCompareViewer() {
  const viewer = document.getElementById("compare-viewer");
  const handle = document.getElementById("compare-handle");
  const modal = document.getElementById("compare-modal");
  const btnClose = document.getElementById("compare-modal-close");

  activeCompareContainer = document.getElementById("viewer-pan-zoom");

  if (btnClose) {
    btnClose.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }

  if (handle) {
    handle.addEventListener("mousedown", (e) => {
      compareIsSliding = true;
      e.stopPropagation();
    });
    window.addEventListener("mouseup", () => { compareIsSliding = false; });
    window.addEventListener("mousemove", (e) => {
      if (!compareIsSliding || !viewer) return;
      const rect = viewer.getBoundingClientRect();
      let pos = e.clientX - rect.left;
      pos = Math.max(0, Math.min(pos, rect.width));
      compareSliderPercent = (pos / rect.width) * 100;
      updateCompareView();
    });
  }

  if (viewer) {
    viewer.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = viewer.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const localX = (mx - comparePanX) / compareScale;
      const localY = (my - comparePanY) / compareScale;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      compareScale *= zoomFactor;
      compareScale = Math.min(Math.max(0.1, compareScale), 10);

      comparePanX = mx - localX * compareScale;
      comparePanY = my - localY * compareScale;

      updateCompareView();
    });

    viewer.addEventListener("mousedown", (e) => {
      if (e.target.closest("#compare-handle")) return;
      compareIsPanning = true;
      compareStartX = e.clientX - comparePanX;
      compareStartY = e.clientY - comparePanY;
      viewer.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (!compareIsPanning) return;
      comparePanX = e.clientX - compareStartX;
      comparePanY = e.clientY - compareStartY;
      updateCompareView();
    });

    window.addEventListener("mouseup", () => {
      if (compareIsPanning) {
        compareIsPanning = false;
        viewer.style.cursor = "grab";
      }
    });
  }
}

window.openCompareModal = function(idx) {
  const res = processedResults[idx];
  if (!res) return;

  const modal = document.getElementById("compare-modal");
  const imgBefore = document.getElementById("img-result-before");
  const imgAfter = document.getElementById("img-result-after");
  const title = document.getElementById("compare-title");
  
  const infoBefore = document.getElementById("compare-info-before");
  const infoAfter = document.getElementById("compare-info-after");

  imgBefore.src = res.originalDataUrl;
  imgAfter.src = res.finalDataUrl;
  title.innerText = `Comparando: ${res.name}`;
  
  if (infoBefore) infoBefore.innerHTML = `${res.originalRes} &bull; ${formatBytes(res.originalSize)}`;
  if (infoAfter) infoAfter.innerHTML = `${res.finalRes} &bull; ${formatBytes(res.finalSize)}`;

  // Reset vista
  compareScale = 1;
  comparePanX = 0;
  comparePanY = 0;
  compareSliderPercent = 50;

  modal.style.display = "flex";

  // Retrasar centrado de imagen para asegurar que se pintó y midió el DOM
  setTimeout(() => {
    centerCompareImages(res);
    updateCompareView();
  }, 100);
};

function centerCompareImages(res) {
  const viewer = document.getElementById("compare-viewer");
  if (!viewer) return;
  const vW = viewer.clientWidth;
  const vH = viewer.clientHeight;

  const imgBefore = document.getElementById("img-result-before");
  const imgAfter = document.getElementById("img-result-after");

  // Tomamos la dimensión final para encajarla
  const img = new Image();
  img.onload = () => {
    const iW = img.width;
    const iH = img.height;
    
    // Forzar al imgBefore a estirarse/encogerse al mismo tamaño que imgAfter para que coincidan visualmente
    if (imgBefore && imgAfter) {
      imgBefore.style.width = `${iW}px`;
      imgBefore.style.height = `${iH}px`;
      imgAfter.style.width = `${iW}px`;
      imgAfter.style.height = `${iH}px`;
    }

    // Scale to fit
    const sX = vW / iW;
    const sY = vH / iH;
    compareScale = Math.min(sX, sY) * 0.95; // 95% to leave a tiny margin
    
    comparePanX = (vW - (iW * compareScale)) / 2;
    comparePanY = (vH - (iH * compareScale)) / 2;
    updateCompareView();
  };
  img.src = res.finalDataUrl;
}

function updateCompareView() {
  if (!activeCompareContainer) return;
  activeCompareContainer.style.transform = `translate(${comparePanX}px, ${comparePanY}px) scale(${compareScale})`;
  
  const handle = document.getElementById("compare-handle");
  const imgAfter = document.getElementById("img-result-after");
  const viewer = document.getElementById("compare-viewer");
  
  if (handle && imgAfter && viewer) {
    handle.style.left = `${compareSliderPercent}%`;
    
    const vW = viewer.clientWidth;
    const splitX = vW * (compareSliderPercent / 100);
    const localSplit = (splitX - comparePanX) / compareScale;
    const percentLocal = (localSplit / imgAfter.naturalWidth) * 100;

    const clipP = Math.max(0, Math.min(100, percentLocal));
    imgAfter.style.clipPath = `inset(0 0 0 ${clipP}%)`;
  }
}

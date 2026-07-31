/**
 * ==============================================================================
 * Limpiador de Ilustraciones Web - Lógica Principal (app.js)
 * ==============================================================================
 * Este archivo gestiona la lógica de interfaz de usuario, edición interactiva de
 * máscaras, llamadas al motor Waifu2x (ONNX Runtime Web), alineación computacional
 * mediante OpenCV.js (ORB + Homografía RANSAC) y ajuste de color en cliente.
 *
 * Para detalles de arquitectura y especificaciones técnicas, consultar AGENTS.md.
 * ==============================================================================
 */

// ──────────────────────────────────────────────────────────────────────────────
// ESTADO GLOBAL DE LA APLICACIÓN
// ──────────────────────────────────────────────────────────────────────────────

let openCvLoaded = false;
let imgOriginal = null; // Elemento <img> para la portada original
let imgClean = null; // Elemento <img> para la versión limpia (sin texto)
let imgMask = null; // Elemento <img> para la máscara (o dataURL del canvas)

// Editor de Máscara (Canvas)
let bgCanvas, paintCanvas, ctxPaint;
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = "brush"; // 'brush', 'eraser' o 'pan'
let brushSize = 20;

// Historial para deshacer en el editor (Ctrl+Z / Cmd+Z)
let undoStack = [];
const MAX_UNDO_STATES = 25;

// Estado del Editor de Máscara (Zoom & Paneo)
let editorScale = 1;
let editorPanX = 0;
let editorPanY = 0;
let editorIsPanning = false;
let editorStartX = 0;
let editorStartY = 0;
let editorDisplayW = 0;
let editorDisplayH = 0;
let spacePressed = false;

// Visor de Resultados (Zoom / Pan / Slider)
let compareViewer,
  viewerPanZoom,
  compareHandle,
  imgResultBefore,
  imgResultAfter;
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let startX = 0;
let startY = 0;
let isSliding = false;
let sliderPercent = 50;

// ──────────────────────────────────────────────────────────────────────────────
// GESTIÓN DE ATANCOS DE TECLADO Y CURSOR
// ──────────────────────────────────────────────────────────────────────────────

window.addEventListener("keydown", (e) => {
  // Deshacer trazado (Ctrl+Z / Cmd+Z)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    const modal = document.getElementById("mask-modal");
    if (modal && modal.style.display === "flex") {
      e.preventDefault();
      undo();
      return;
    }
  }

  // Activar modo Paneo temporal mediante Barra Espaciadora
  if (
    e.code === "Space" &&
    document.activeElement.tagName !== "INPUT" &&
    document.activeElement.tagName !== "SELECT" &&
    document.activeElement.tagName !== "TEXTAREA"
  ) {
    if (!spacePressed) {
      spacePressed = true;
      if (document.getElementById("mask-modal").style.display === "flex") {
        updateCursor();
      }
    }
    e.preventDefault();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spacePressed = false;
    if (document.getElementById("mask-modal").style.display === "flex") {
      updateCursor();
    }
  }
});

/**
 * Actualiza la apariencia del cursor en el canvas según la herramienta activa.
 */
function updateCursor() {
  if (!paintCanvas) return;
  if (currentTool === "pan" || spacePressed) {
    paintCanvas.style.cursor = editorIsPanning ? "grabbing" : "grab";
  } else if (currentTool === "eraser") {
    paintCanvas.style.cursor = "cell";
  } else {
    paintCanvas.style.cursor = "crosshair";
  }
}

/**
 * Guarda el estado actual del canvas en la pila de undo.
 */
function saveUndoState() {
  if (!paintCanvas || !ctxPaint) return;
  const state = ctxPaint.getImageData(
    0,
    0,
    paintCanvas.width,
    paintCanvas.height,
  );
  undoStack.push(state);
  if (undoStack.length > MAX_UNDO_STATES) {
    undoStack.shift();
  }
}

/**
 * Revierte el lienzo al último estado guardado.
 */
function undo() {
  if (!paintCanvas || !ctxPaint) return;
  if (undoStack.length > 0) {
    const prevState = undoStack.pop();
    ctxPaint.putImageData(prevState, 0, 0);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// INICIALIZACIÓN DE LA APLICACIÓN
// ──────────────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  setupDropzones();
  setupParameters();
  setupParameterGuide();
  setupMaskEditor();
  setupResultViewer();
  initWaifu2xBackend();

  // Configurar botón principal de procesamiento
  const btnProcess = document.getElementById("btn-process");
  if (btnProcess) {
    btnProcess.addEventListener("click", processImages);
  }
});

/**
 * Detecta y muestra el backend activo de Waifu2x (WebGPU / WASM).
 */
async function initWaifu2xBackend() {
  if (typeof Waifu2xEngine !== "undefined") {
    const backendName = await Waifu2xEngine.detectBackend();
    const badge = document.getElementById("waifu2x-backend-badge");
    if (badge) {
      badge.innerText = backendName;
      if (backendName.includes("WebGPU")) {
        badge.className = "badge badge-recommended";
      } else {
        badge.className = "badge badge-info";
      }
    }
  }
}

/**
 * Callback ejecutado al cargar OpenCV.js con éxito.
 */
function onOpenCvReady() {
  console.log("[+] OpenCV.js cargado correctamente.");
  openCvLoaded = true;
  const loadingOverlay = document.getElementById("loading-overlay");
  if (loadingOverlay) {
    loadingOverlay.style.display = "none";
  }
}

/**
 * Callback de error al cargar OpenCV.js.
 */
function onOpenCvError() {
  alert("Error al cargar OpenCV.js. Por favor, recarga la página.");
}

// ──────────────────────────────────────────────────────────────────────────────
// DROPZONES Y CARGA DE ARCHIVOS
// ──────────────────────────────────────────────────────────────────────────────

function setupDropzones() {
  const dropzoneIds = ["dz-cover", "dz-clean", "dz-mask"];

  dropzoneIds.forEach((id) => {
    const dz = document.getElementById(id);
    if (!dz) return;
    const input = dz.querySelector(".file-input");

    // Clic para abrir el selector de archivos
    dz.addEventListener("click", (e) => {
      if (
        e.target.closest("button") ||
        e.target.closest(".btn-remove-file") ||
        e.target.closest(".btn-edit-mask")
      ) {
        return;
      }
      input.click();
    });

    // Configurar botón de eliminar
    const btnRemove = dz.querySelector(".btn-remove-file");
    if (btnRemove) {
      btnRemove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(id);
      });
    }

    // Eventos Drag & Drop
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });

    dz.addEventListener("dragleave", () => {
      dz.classList.remove("dragover");
    });

    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) {
        input.files = e.dataTransfer.files;
        handleFile(input.files[0], id);
      }
    });

    input.addEventListener("change", () => {
      if (input.files.length > 0) {
        handleFile(input.files[0], id);
      }
    });
  });
}

function handleFile(file, dzId) {
  if (!file.type.startsWith("image/")) {
    alert("Por favor selecciona un archivo de imagen válido.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const dz = document.getElementById(dzId);
      const preview = dz.querySelector(".dz-preview");
      preview.innerHTML = "";
      preview.appendChild(img.cloneNode(true));
      preview.style.display = "block";

      // Mostrar botón de eliminar
      const btnRemove = dz.querySelector(".btn-remove-file");
      if (btnRemove) {
        btnRemove.style.display = "flex";
      }

      // Asignar variable correspondiente
      if (dzId === "dz-cover") {
        imgOriginal = img;
        const btnPaint = document.getElementById("btn-paint-mask");
        if (btnPaint) btnPaint.disabled = false;
        log("Portada original cargada.", "info");
      } else if (dzId === "dz-clean") {
        imgClean = img;
        log("Imagen limpia cargada.", "info");
      } else if (dzId === "dz-mask") {
        imgMask = img;
        log("Máscara externa cargada.", "info");
        const btnEdit = dz.querySelector(".btn-edit-mask");
        if (btnEdit) btnEdit.style.display = "flex";
      }

      checkReadyToProcess();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeFile(dzId) {
  const dz = document.getElementById(dzId);
  if (!dz) return;

  const input = dz.querySelector(".file-input");
  const preview = dz.querySelector(".dz-preview");
  const btnRemove = dz.querySelector(".btn-remove-file");

  if (input) input.value = "";
  if (preview) {
    preview.innerHTML = "";
    preview.style.display = "none";
  }
  if (btnRemove) {
    btnRemove.style.display = "none";
  }

  if (dzId === "dz-cover") {
    imgOriginal = null;
    const btnPaint = document.getElementById("btn-paint-mask");
    if (btnPaint) btnPaint.disabled = true;
    log("Portada original eliminada.", "info");
  } else if (dzId === "dz-clean") {
    imgClean = null;
    log("Imagen limpia eliminada.", "info");
  } else if (dzId === "dz-mask") {
    imgMask = null;
    const btnEdit = dz.querySelector(".btn-edit-mask");
    if (btnEdit) btnEdit.style.display = "none";
    log("Máscara eliminada.", "info");
  }

  checkReadyToProcess();
}

function checkReadyToProcess() {
  const btn = document.getElementById("btn-process");
  if (btn) {
    btn.disabled = !(imgOriginal && imgClean && imgMask);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONSOLA WEB Y UTILIDADES
// ──────────────────────────────────────────────────────────────────────────────

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
  if (consoleBox) {
    consoleBox.innerText = "";
  }
}

/**
 * Libera de forma segura arreglos y matrices de OpenCV.js para evitar fugas WASM.
 */
function safeDeleteCvObjects(...objs) {
  for (const obj of objs) {
    if (obj && typeof obj.delete === "function") {
      try {
        obj.delete();
      } catch (_) {
        // Ignorar si el objeto ya fue liberado previamente
      }
    }
  }
}

/**
 * Pausa la ejecución asíncrona permitiendo al navegador renderizar el UI y los logs.
 */
function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Exporta un canvas como archivo PNG optimizado con compresión de nivel 9 via UPNG.js.
 */
async function downloadCanvasAsOptimizedPng(canvas, fileName) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (typeof UPNG !== "undefined") {
    const pngBuffer = UPNG.encode(
      [imgData.data.buffer],
      canvas.width,
      canvas.height,
      0,
    );
    const blob = new Blob([pngBuffer], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = fileName;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } else {
    const a = document.createElement("a");
    a.download = fileName;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN DE PARÁMETROS Y GUÍA INTERACTIVA
// ──────────────────────────────────────────────────────────────────────────────

function setupParameters() {
  const sliders = [
    { id: "param-dilate", valId: "val-dilate" },
    { id: "param-blur", valId: "val-blur" },
  ];

  sliders.forEach((s) => {
    const slider = document.getElementById(s.id);
    const label = document.getElementById(s.valId);
    if (slider && label) {
      slider.addEventListener("input", () => {
        label.innerText = slider.value;
      });
    }
  });

  // Exclusividad mutua entre Ajuste de Color General y Local
  const colorMatch = document.getElementById("param-color-match");
  const colorLocal = document.getElementById("param-color-local");

  if (colorMatch && colorLocal) {
    colorMatch.addEventListener("change", () => {
      if (colorMatch.checked) {
        colorLocal.checked = false;
      }
    });
    colorLocal.addEventListener("change", () => {
      if (colorLocal.checked) {
        colorMatch.checked = false;
      }
    });
  }
}

function setupParameterGuide() {
  const modal = document.getElementById("guide-modal");
  const btnOpenGuide = document.getElementById("btn-open-guide");
  const btnClose = document.getElementById("guide-modal-close");
  const btnAccept = document.getElementById("guide-modal-accept");
  const infoButtons = document.querySelectorAll(".btn-info-icon");

  if (!modal) return;

  function openGuide(targetCardId = null) {
    modal.style.display = "flex";

    document.querySelectorAll(".guide-card, .guide-subcard").forEach((card) => {
      card.classList.remove("guide-card-highlight");
    });

    if (targetCardId) {
      const targetCard = document.getElementById(targetCardId);
      if (targetCard) {
        targetCard.classList.add("guide-card-highlight");
        const parentCard = targetCard.closest(".guide-card");
        if (parentCard && parentCard !== targetCard) {
          parentCard.classList.add("guide-card-highlight");
        }
        setTimeout(() => {
          targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    }
  }

  function closeGuide() {
    modal.style.display = "none";
  }

  if (btnOpenGuide) {
    btnOpenGuide.addEventListener("click", () => openGuide());
  }

  if (btnClose) btnClose.addEventListener("click", closeGuide);
  if (btnAccept) btnAccept.addEventListener("click", closeGuide);

  window.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeGuide();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") {
      closeGuide();
    }
  });

  infoButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute("data-guide-target");
      openGuide(targetId);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// EDITOR INTERACTIVO DE MÁSCARA (MODAL)
// ──────────────────────────────────────────────────────────────────────────────

function setupMaskEditor() {
  const modal = document.getElementById("mask-modal");
  const btnPaint = document.getElementById("btn-paint-mask");
  const btnClose = document.getElementById("modal-close");
  const btnCancel = document.getElementById("editor-cancel");
  const btnSave = document.getElementById("editor-save");
  const btnClear = document.getElementById("editor-clear");

  bgCanvas = document.getElementById("editor-bg-canvas");
  paintCanvas = document.getElementById("editor-paint-canvas");
  if (!paintCanvas || !bgCanvas) return;
  ctxPaint = paintCanvas.getContext("2d");

  const editorContainer = document.querySelector(".editor-canvas-container");
  let brushCursor = document.getElementById("editor-brush-cursor");
  if (!brushCursor && editorContainer) {
    brushCursor = document.createElement("div");
    brushCursor.id = "editor-brush-cursor";
    editorContainer.appendChild(brushCursor);
  }

  if (btnPaint) {
    btnPaint.addEventListener("click", () => {
      if (!imgOriginal) return;
      openMaskModal();
    });
  }

  const btnEditMask = document.getElementById("btn-edit-mask");
  if (btnEditMask) {
    btnEditMask.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!imgOriginal) return;
      openMaskModal();
    });
  }

  if (btnClose) btnClose.addEventListener("click", closeModal);
  if (btnCancel) btnCancel.addEventListener("click", closeModal);

  if (btnSave) {
    btnSave.addEventListener("click", () => {
      const dataURL = paintCanvas.toDataURL("image/png");

      const img = new Image();
      img.onload = () => {
        const preview = document.getElementById("preview-mask");
        if (preview) {
          preview.innerHTML = "";
          preview.appendChild(img.cloneNode(true));
          preview.style.display = "block";
        }

        imgMask = img;
        log("Máscara generada en el editor.", "success");
        checkReadyToProcess();

        const btnRemove = document.querySelector("#dz-mask .btn-remove-file");
        if (btnRemove) btnRemove.style.display = "flex";
        const btnEdit = document.querySelector("#dz-mask .btn-edit-mask");
        if (btnEdit) btnEdit.style.display = "flex";

        closeModal();
      };
      img.src = dataURL;
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", async () => {
      const confirmed = await showCustomConfirm(
        "¿Seguro que deseas borrar toda la máscara pintada?",
      );
      if (confirmed) {
        saveUndoState();
        ctxPaint.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
      }
    });
  }

  // Herramientas Pincel / Borrador / Mover
  const btnBrush = document.getElementById("editor-tool-brush");
  const btnEraser = document.getElementById("editor-tool-eraser");
  const btnPan = document.getElementById("editor-tool-pan");
  const brushSizeSlider = document.getElementById("editor-brush-size");
  const brushSizeVal = document.getElementById("editor-val-brush-size");
  const brushPreview = document.getElementById("brush-preview");
  const opacitySlider = document.getElementById("editor-opacity");
  const opacityVal = document.getElementById("editor-val-opacity");

  if (btnBrush) {
    btnBrush.addEventListener("click", () => {
      currentTool = "brush";
      setActiveToolButton(btnBrush);
      updateCursor();
    });
  }

  if (btnEraser) {
    btnEraser.addEventListener("click", () => {
      currentTool = "eraser";
      setActiveToolButton(btnEraser);
      updateCursor();
    });
  }

  if (btnPan) {
    btnPan.addEventListener("click", () => {
      currentTool = "pan";
      setActiveToolButton(btnPan);
      updateCursor();
    });
  }

  function setActiveToolButton(activeBtn) {
    [btnBrush, btnEraser, btnPan].forEach((btn) => {
      if (!btn) return;
      if (btn === activeBtn) {
        btn.classList.add("active", "btn-primary");
        btn.classList.remove("btn-secondary");
      } else {
        btn.classList.remove("active", "btn-primary");
        btn.classList.add("btn-secondary");
      }
    });
  }

  if (brushSizeSlider) {
    brushSizeSlider.addEventListener("input", () => {
      brushSize = parseInt(brushSizeSlider.value);
      if (brushSizeVal) brushSizeVal.innerText = brushSize;
      updateBrushPreview();
    });
  }

  function updateBrushPreview() {
    if (!brushPreview) return;
    const visualSize = Math.max(2, (brushSize / 100) * 46);
    brushPreview.style.width = visualSize + "px";
    brushPreview.style.height = visualSize + "px";
  }

  if (opacitySlider) {
    opacitySlider.addEventListener("input", () => {
      const opacity = parseFloat(opacitySlider.value);
      if (opacityVal) opacityVal.innerText = opacity.toFixed(1);
      paintCanvas.style.opacity = opacity;
    });
  }

  paintCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Eventos de ratón para dibujo y paneo
  paintCanvas.addEventListener("mousedown", (e) => {
    if (
      e.button === 2 ||
      e.button === 1 ||
      currentTool === "pan" ||
      spacePressed
    ) {
      editorIsPanning = true;
      editorStartX = e.clientX - editorPanX;
      editorStartY = e.clientY - editorPanY;
      updateCursor();
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      saveUndoState();
      isDrawing = true;
      const pos = getMousePos(e);
      lastX = pos.x;
      lastY = pos.y;
      drawDot(pos.x, pos.y);
    }
  });

  paintCanvas.addEventListener("mousemove", (e) => {
    updateBrushCursorPosition(e);

    if (editorIsPanning) {
      editorPanX = e.clientX - editorStartX;
      editorPanY = e.clientY - editorStartY;
      updateEditorTransform();
      return;
    }

    if (isDrawing) {
      const pos = getMousePos(e);
      ctxPaint.beginPath();
      ctxPaint.moveTo(lastX, lastY);
      ctxPaint.lineTo(pos.x, pos.y);

      ctxPaint.lineCap = "round";
      ctxPaint.lineJoin = "round";

      if (currentTool === "eraser") {
        ctxPaint.globalCompositeOperation = "destination-out";
        ctxPaint.strokeStyle = "rgba(0,0,0,1)";
        ctxPaint.lineWidth = brushSize;
      } else {
        ctxPaint.globalCompositeOperation = "source-over";
        ctxPaint.strokeStyle = "#ffffff";
        ctxPaint.lineWidth = brushSize;
      }
      ctxPaint.stroke();

      lastX = pos.x;
      lastY = pos.y;
    }
  });

  paintCanvas.addEventListener("mouseenter", (e) => {
    updateCursor();
    updateBrushCursorPosition(e);
  });

  paintCanvas.addEventListener("mouseleave", () => {
    if (brushCursor) brushCursor.style.display = "none";
  });

  window.addEventListener("mouseup", () => {
    if (editorIsPanning) {
      editorIsPanning = false;
      updateCursor();
    }
    isDrawing = false;
  });

  if (editorContainer) {
    editorContainer.addEventListener("wheel", (e) => {
      e.preventDefault();

      const rect = editorContainer.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const localX = (mouseX - editorPanX) / editorScale;
      const localY = (mouseY - editorPanY) / editorScale;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      editorScale *= zoomFactor;
      editorScale = Math.min(Math.max(0.15, editorScale), 20);

      editorPanX = mouseX - localX * editorScale;
      editorPanY = mouseY - localY * editorScale;

      updateEditorTransform();
      updateBrushCursorPosition(e);
    });
  }

  function updateBrushCursorPosition(e) {
    if (!brushCursor) return;
    if (currentTool === "pan" || spacePressed || editorIsPanning) {
      brushCursor.style.display = "none";
      return;
    }

    const rect = editorContainer.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (e.target !== paintCanvas) {
      brushCursor.style.display = "none";
      return;
    }

    const scaleRatio = editorDisplayW / paintCanvas.width;
    const diameter = brushSize * scaleRatio * editorScale;

    brushCursor.style.width = diameter + "px";
    brushCursor.style.height = diameter + "px";
    brushCursor.style.left = mx + "px";
    brushCursor.style.top = my + "px";
    brushCursor.style.display = "block";
  }

  // Soporte Táctil
  paintCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length > 1) return;
    if (currentTool === "pan" || spacePressed) {
      editorIsPanning = true;
      editorStartX = e.touches[0].clientX - editorPanX;
      editorStartY = e.touches[0].clientY - editorPanY;
      e.preventDefault();
      return;
    }
    saveUndoState();
    isDrawing = true;
    const pos = getMousePos(e);
    lastX = pos.x;
    lastY = pos.y;
    drawDot(pos.x, pos.y);
  });

  paintCanvas.addEventListener("touchmove", (e) => {
    if (editorIsPanning) {
      editorPanX = e.touches[0].clientX - editorStartX;
      editorPanY = e.touches[0].clientY - editorStartY;
      updateEditorTransform();
      e.preventDefault();
      return;
    }
    if (isDrawing) {
      const pos = getMousePos(e);
      ctxPaint.beginPath();
      ctxPaint.moveTo(lastX, lastY);
      ctxPaint.lineTo(pos.x, pos.y);
      ctxPaint.lineCap = "round";
      ctxPaint.lineJoin = "round";

      if (currentTool === "eraser") {
        ctxPaint.globalCompositeOperation = "destination-out";
        ctxPaint.strokeStyle = "rgba(0,0,0,1)";
        ctxPaint.lineWidth = brushSize;
      } else {
        ctxPaint.globalCompositeOperation = "source-over";
        ctxPaint.strokeStyle = "#ffffff";
        ctxPaint.lineWidth = brushSize;
      }
      ctxPaint.stroke();
      lastX = pos.x;
      lastY = pos.y;
      e.preventDefault();
    }
  });

  paintCanvas.addEventListener("touchend", () => {
    editorIsPanning = false;
    isDrawing = false;
  });
}

function openMaskModal() {
  const modal = document.getElementById("mask-modal");
  if (!modal) return;
  modal.style.display = "flex";

  undoStack = [];

  const imgWidth = imgOriginal.naturalWidth;
  const imgHeight = imgOriginal.naturalHeight;

  bgCanvas.width = imgWidth;
  bgCanvas.height = imgHeight;
  paintCanvas.width = imgWidth;
  paintCanvas.height = imgHeight;

  const containerWidth = 860;
  const containerHeight = 420;
  const scaleX = containerWidth / imgWidth;
  const scaleY = containerHeight / imgHeight;
  const displayScale = Math.min(scaleX, scaleY, 1);

  editorDisplayW = imgWidth * displayScale;
  editorDisplayH = imgHeight * displayScale;

  bgCanvas.style.width = editorDisplayW + "px";
  bgCanvas.style.height = editorDisplayH + "px";
  paintCanvas.style.width = editorDisplayW + "px";
  paintCanvas.style.height = editorDisplayH + "px";

  const wrapper = paintCanvas.parentNode;
  if (wrapper) {
    wrapper.style.width = editorDisplayW + "px";
    wrapper.style.height = editorDisplayH + "px";
  }

  editorScale = 1;
  editorPanX = (containerWidth - editorDisplayW) / 2;
  editorPanY = (containerHeight - editorDisplayH) / 2;

  updateEditorTransform();

  const ctxBg = bgCanvas.getContext("2d");
  ctxBg.drawImage(imgOriginal, 0, 0);

  ctxPaint.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  if (imgMask) {
    try {
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = paintCanvas.width;
      tempCanvas.height = paintCanvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      tempCtx.drawImage(imgMask, 0, 0, paintCanvas.width, paintCanvas.height);

      const imgData = tempCtx.getImageData(
        0,
        0,
        tempCanvas.width,
        tempCanvas.height,
      );
      const data = imgData.data;
      let hasTransparency = false;

      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 200) {
          hasTransparency = true;
          break;
        }
      }

      if (!hasTransparency) {
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (r < 50 && g < 50 && b < 50) {
            data[i + 3] = 0;
          } else {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255;
          }
        }
        tempCtx.putImageData(imgData, 0, 0);
      }

      ctxPaint.drawImage(tempCanvas, 0, 0);
    } catch (e) {
      console.error("Error al cargar la máscara en el lienzo del editor:", e);
      try {
        ctxPaint.drawImage(
          imgMask,
          0,
          0,
          paintCanvas.width,
          paintCanvas.height,
        );
      } catch (_) {}
    }
  }

  const brushSizeElem = document.getElementById("editor-brush-size");
  if (brushSizeElem) brushSize = parseInt(brushSizeElem.value);
  const brushPreview = document.getElementById("brush-preview");
  if (brushPreview) {
    const visualSize = Math.max(2, (brushSize / 100) * 46);
    brushPreview.style.width = visualSize + "px";
    brushPreview.style.height = visualSize + "px";
  }

  const opacitySlider = document.getElementById("editor-opacity");
  const opacityVal = document.getElementById("editor-val-opacity");
  if (opacitySlider) opacitySlider.value = 0.7;
  if (opacityVal) opacityVal.innerText = "0.7";
  paintCanvas.style.opacity = 0.7;

  const btnBrush = document.getElementById("editor-tool-brush");
  currentTool = "brush";

  const btnEraser = document.getElementById("editor-tool-eraser");
  const btnPan = document.getElementById("editor-tool-pan");
  [btnBrush, btnEraser, btnPan].forEach((btn) => {
    if (!btn) return;
    if (btn === btnBrush) {
      btn.classList.add("active", "btn-primary");
      btn.classList.remove("btn-secondary");
    } else {
      btn.classList.remove("active", "btn-primary");
      btn.classList.add("btn-secondary");
    }
  });

  updateCursor();
}

function updateEditorTransform() {
  const wrapper = paintCanvas ? paintCanvas.parentNode : null;
  if (wrapper) {
    wrapper.style.transform = `translate(${editorPanX}px, ${editorPanY}px) scale(${editorScale})`;
  }
}

function closeModal() {
  const modal = document.getElementById("mask-modal");
  if (modal) modal.style.display = "none";
  const brushCursor = document.getElementById("editor-brush-cursor");
  if (brushCursor) brushCursor.style.display = "none";
}

function getMousePos(e) {
  const container = document.querySelector(".editor-canvas-container");
  const containerRect = container.getBoundingClientRect();

  let clientX = e.clientX;
  let clientY = e.clientY;

  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  const mx = clientX - containerRect.left;
  const my = clientY - containerRect.top;

  const displayX = (mx - editorPanX) / editorScale;
  const displayY = (my - editorPanY) / editorScale;

  const scaleX = paintCanvas.width / editorDisplayW;
  const scaleY = paintCanvas.height / editorDisplayH;

  return {
    x: displayX * scaleX,
    y: displayY * scaleY,
  };
}

function drawDot(x, y) {
  ctxPaint.beginPath();
  ctxPaint.arc(x, y, brushSize / 2, 0, Math.PI * 2);
  if (currentTool === "eraser") {
    ctxPaint.globalCompositeOperation = "destination-out";
    ctxPaint.fillStyle = "rgba(0,0,0,1)";
  } else {
    ctxPaint.globalCompositeOperation = "source-over";
    ctxPaint.fillStyle = "#ffffff";
  }
  ctxPaint.fill();
}

// ──────────────────────────────────────────────────────────────────────────────
// PIPELINE PRINCIPAL DE PROCESAMIENTO EN CLIENTE (OPENCV.JS + WAIFU2X)
// ──────────────────────────────────────────────────────────────────────────────

async function processImages() {
  if (!openCvLoaded) {
    alert("Cargando motor OpenCV.js, por favor espera unos segundos.");
    return;
  }

  clearLog();
  log("Iniciando procesamiento de limpieza...", "info");
  await yieldToUI();

  // Lectura de parámetros de la UI
  const colorMatch =
    document.getElementById("param-color-match")?.checked ?? false;
  const colorMatchLocal =
    document.getElementById("param-color-local")?.checked ?? false;
  const enableHomography = document.getElementById("param-homography")
    ? document.getElementById("param-homography").checked
    : true;
  const enableMaskPriority = document.getElementById("param-mask-priority")
    ? document.getElementById("param-mask-priority").checked
    : true;
  const enableFallbackDirect = document.getElementById("param-fallback-direct")
    ? document.getElementById("param-fallback-direct").checked
    : false;
  const method = document.getElementById("param-method")?.value || "stats";
  const dilatePx = parseInt(
    document.getElementById("param-dilate")?.value || "10",
  );
  const blurSigma = parseFloat(
    document.getElementById("param-blur")?.value || "3.0",
  );

  // Parámetros de Waifu2x
  const useWaifu2x = document.getElementById("param-waifu2x")
    ? document.getElementById("param-waifu2x").checked
    : false;
  const waifu2xScale =
    document.getElementById("param-waifu2x-scale")?.value || "2x";
  const waifu2xNoise =
    document.getElementById("param-waifu2x-noise")?.value || "2";
  const waifu2xModel =
    document.getElementById("param-waifu2x-model")?.value || "cunet";

  // Variables de control de memoria OpenCV (se liberan en finalmente)
  let srcCover = null;
  let srcClean = null;
  let srcMask = null;
  let grayCover = null;
  let grayClean = null;
  let maskGray = null;
  let maskContext = null;
  let orb = null;
  let kpCover = null;
  let desCover = null;
  let kpClean = null;
  let desClean = null;
  let matcher = null;
  let matches = null;
  let allMatches = null;
  let maskMatches = null;
  let ptsClean = null;
  let ptsCover = null;
  let H_candidate = null;
  let H = null;
  let alignedClean = null;
  let colorMatchedClean = null;
  let blurredMask = null;

  try {
    let cleanInputForCv = imgClean;

    // Pasada opcional de Waifu2x antes de alineación
    if (useWaifu2x && typeof Waifu2xEngine !== "undefined") {
      log(
        `Ejecutando Waifu2x en la imagen limpia (${waifu2xModel}, Ruido: ${waifu2xNoise}, Escala: ${waifu2xScale})...`,
        "info",
      );
      await yieldToUI();
      try {
        cleanInputForCv = await Waifu2xEngine.processImage(
          imgClean,
          {
            model: waifu2xModel,
            noise: waifu2xNoise,
            scale: waifu2xScale,
            tileSize: 256,
            overlap: 16,
          },
          (percent, statusMsg) => {
            log(`[Waifu2x] ${statusMsg}`, "info");
          },
        );
        log(
          "Waifu2x finalizado correctamente del lado del cliente.",
          "success",
        );
        await yieldToUI();
      } catch (e) {
        const errMsg =
          e && (e.message || e.stack) ? e.message || e.stack : String(e);
        log(`[-] Error al ejecutar Waifu2x: ${errMsg}`, "error");
        log("[!] Continuando proceso con la imagen limpia original...", "info");
        cleanInputForCv = imgClean;
      }
    }

    log("Cargando imágenes y máscara en memoria WebAssembly...", "info");
    await yieldToUI();

    srcCover = cv.imread(imgOriginal);
    srcClean = cv.imread(cleanInputForCv);
    srcMask = cv.imread(imgMask);

    grayCover = new cv.Mat();
    grayClean = new cv.Mat();
    cv.cvtColor(srcCover, grayCover, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(srcClean, grayClean, cv.COLOR_RGBA2GRAY);

    // Lectura y preparación de la Máscara Gris
    const dsize = new cv.Size(srcCover.cols, srcCover.rows);
    maskGray = new cv.Mat();

    if (srcMask.channels() === 4) {
      let channels = new cv.MatVector();
      cv.split(srcMask, channels);
      let alphaChan = channels.get(3);
      let meanVal = cv.mean(alphaChan)[0];
      if (meanVal > 250) {
        cv.cvtColor(srcMask, maskGray, cv.COLOR_RGBA2GRAY);
      } else {
        maskGray = alphaChan.clone();
      }
      for (let i = 0; i < channels.size(); i++) {
        let ch = channels.get(i);
        safeDeleteCvObjects(ch);
      }
      channels.delete();
    } else if (srcMask.channels() === 3) {
      cv.cvtColor(srcMask, maskGray, cv.COLOR_RGB2GRAY);
    } else {
      maskGray = srcMask.clone();
    }

    if (maskGray.cols !== srcCover.cols || maskGray.rows !== srcCover.rows) {
      let resizedMask = new cv.Mat();
      cv.resize(maskGray, resizedMask, dsize, 0, 0, cv.INTER_LINEAR);
      maskGray.delete();
      maskGray = resizedMask;
    }

    // Zona de Contexto dilata (alrededor de zonas de texto)
    maskContext = new cv.Mat();
    let kernelRadius = Math.max(15, Math.round(srcCover.cols / 40));
    let kernelSize = kernelRadius * 2 + 1;
    let kernelCtx = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
    cv.dilate(maskGray, maskContext, kernelCtx);
    kernelCtx.delete();

    log("Detectando puntos clave de alineación (ORB)...", "info");
    await yieldToUI();

    orb = new cv.ORB(10000);
    kpCover = new cv.KeyPointVector();
    desCover = new cv.Mat();
    kpClean = new cv.KeyPointVector();
    desClean = new cv.Mat();

    orb.detectAndCompute(grayCover, new cv.Mat(), kpCover, desCover);
    orb.detectAndCompute(grayClean, new cv.Mat(), kpClean, desClean);

    log(
      `Puntos clave - Original: ${kpCover.size()} | Limpia: ${kpClean.size()}`,
      "info",
    );
    await yieldToUI();

    matcher = new cv.BFMatcher(cv.NORM_HAMMING);
    matches = new cv.DMatchVectorVector();
    allMatches = new cv.DMatchVector();
    maskMatches = new cv.DMatchVector();

    if (
      kpCover.size() >= 4 &&
      kpClean.size() >= 4 &&
      !desCover.empty() &&
      !desClean.empty()
    ) {
      log("Buscando coincidencias de puntos de control...", "info");
      await yieldToUI();

      matcher.knnMatch(desClean, desCover, matches, 2);

      for (let i = 0; i < matches.size(); i++) {
        let matchPair = matches.get(i);
        if (matchPair.size() < 2) continue;
        let m = matchPair.get(0);
        let n = matchPair.get(1);
        if (m.distance < 0.8 * n.distance) {
          allMatches.push_back(m);

          // Filtrar coincidencia según cercanía a la Zona de Contexto de la máscara
          let ptCover = kpCover.get(m.trainIdx).pt;
          let cx = Math.floor(ptCover.x);
          let cy = Math.floor(ptCover.y);
          if (
            cx >= 0 &&
            cx < maskContext.cols &&
            cy >= 0 &&
            cy < maskContext.rows
          ) {
            if (maskContext.ucharPtr(cy, cx)[0] > 0) {
              maskMatches.push_back(m);
            }
          }
        }
      }

      let targetMatches = allMatches;
      let isMaskFocused = false;

      if (enableMaskPriority && maskMatches.size() >= 4) {
        targetMatches = maskMatches;
        isMaskFocused = true;
        log(
          `Coincidencias priorizadas cerca de la máscara: ${maskMatches.size()} (de ${allMatches.size()} totales)`,
          "info",
        );
      } else {
        log(`Coincidencias válidas encontradas: ${allMatches.size()}`, "info");
      }
      await yieldToUI();

      if (targetMatches.size() >= 4 && enableHomography) {
        log(
          `Calculando homografía ${isMaskFocused ? "focalizada en máscara " : ""}por RANSAC...`,
          "info",
        );
        await yieldToUI();

        ptsClean = new cv.Mat(targetMatches.size(), 1, cv.CV_32FC2);
        ptsCover = new cv.Mat(targetMatches.size(), 1, cv.CV_32FC2);

        for (let i = 0; i < targetMatches.size(); i++) {
          let m = targetMatches.get(i);
          let ptClean = kpClean.get(m.queryIdx).pt;
          let ptCover = kpCover.get(m.trainIdx).pt;

          ptsClean.data32F[i * 2] = ptClean.x;
          ptsClean.data32F[i * 2 + 1] = ptClean.y;

          ptsCover.data32F[i * 2] = ptCover.x;
          ptsCover.data32F[i * 2 + 1] = ptCover.y;
        }

        let inlierMask = new cv.Mat();
        H_candidate = cv.findHomography(
          ptsClean,
          ptsCover,
          cv.RANSAC,
          5.0,
          inlierMask,
        );
        let inliersCount = cv.countNonZero(inlierMask);
        inlierMask.delete();

        log(`Inliers tras RANSAC: ${inliersCount}`, "info");
        await yieldToUI();

        let isValidH = false;
        if (
          !H_candidate.empty() &&
          H_candidate.rows === 3 &&
          H_candidate.cols === 3 &&
          inliersCount >= 4
        ) {
          let h22 = H_candidate.data64F[8];
          if (Math.abs(h22) > 1e-7) {
            let h00 = H_candidate.data64F[0] / h22;
            let h01 = H_candidate.data64F[1] / h22;
            let h10 = H_candidate.data64F[3] / h22;
            let h11 = H_candidate.data64F[4] / h22;
            let h20 = H_candidate.data64F[6] / h22;
            let h21 = H_candidate.data64F[7] / h22;

            let det2x2 = h00 * h11 - h01 * h10;
            if (
              det2x2 > 0.1 &&
              det2x2 < 10.0 &&
              Math.abs(h20) < 0.05 &&
              Math.abs(h21) < 0.05
            ) {
              isValidH = true;
            }
          }
        }

        if (isValidH) {
          H = H_candidate;
          H_candidate = null;
          log(
            `Alineación por Homografía aplicada con éxito (${inliersCount} inliers).`,
            "success",
          );
        } else if (enableFallbackDirect) {
          safeDeleteCvObjects(H_candidate);
          H_candidate = null;
          log(
            `[!] Homografía inestable. Usando alineación directa 1:1 por opción activada.`,
            "info",
          );
        } else {
          H = H_candidate;
          H_candidate = null;
          log(
            `[*] Homografía aplicada (${inliersCount} inliers, fallback 1:1 desactivado).`,
            "info",
          );
        }
      } else if (!enableHomography) {
        if (enableFallbackDirect) {
          log(
            "Homografía desactivada. Usando alineación directa (1:1).",
            "info",
          );
        } else {
          throw new Error(
            "Homografía desactivada y Fallback a Alineación Directa (1:1) no permitido.",
          );
        }
      } else {
        if (enableFallbackDirect) {
          log(
            "[!] Pocas coincidencias. Usando alineación directa (1:1).",
            "info",
          );
        } else {
          throw new Error(
            `Pocas coincidencias de alineación (${targetMatches.size()}). Habilita 'Permitir Fallback a Alineación Directa (1:1)' si deseas forzar la alineación.`,
          );
        }
      }
    } else {
      if (enableFallbackDirect) {
        log(
          "[!] Puntos clave insuficientes. Usando alineación directa (1:1).",
          "info",
        );
      } else {
        throw new Error(
          "Puntos clave insuficientes en las imágenes para alinear.",
        );
      }
    }
    await yieldToUI();

    // Fallback a matriz de escalado directo 1:1 si no hay homografía
    if (!H && enableFallbackDirect) {
      H = new cv.Mat(3, 3, cv.CV_64F);
      let sx = srcCover.cols / srcClean.cols;
      let sy = srcCover.rows / srcClean.rows;
      H.data64F[0] = sx;
      H.data64F[1] = 0;
      H.data64F[2] = 0;
      H.data64F[3] = 0;
      H.data64F[4] = sy;
      H.data64F[5] = 0;
      H.data64F[6] = 0;
      H.data64F[7] = 0;
      H.data64F[8] = 1;
    }

    if (!H) {
      throw new Error(
        "No se pudo calcular la matriz de alineación por homografía.",
      );
    }

    log("Alineando perspectiva de la imagen limpia...", "info");
    await yieldToUI();

    alignedClean = new cv.Mat();
    cv.warpPerspective(
      srcClean,
      alignedClean,
      H,
      dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 0),
    );

    // Ajuste de Color (Color Match)
    colorMatchedClean = alignedClean.clone();
    if (colorMatch || colorMatchLocal) {
      log(
        `Aplicando ajuste de color (Método: ${method}${colorMatchLocal ? " - Local" : ""})...`,
        "info",
      );
      await yieldToUI();

      let contextMask = null;
      if (dilatePx > 0) {
        let kernel = cv.Mat.ones(dilatePx * 2 + 1, dilatePx * 2 + 1, cv.CV_8U);
        let dilatedMask = new cv.Mat();
        cv.dilate(maskGray, dilatedMask, kernel);

        let invMask = new cv.Mat();
        cv.bitwise_not(maskGray, invMask);

        contextMask = new cv.Mat();
        cv.bitwise_and(dilatedMask, invMask, contextMask);

        safeDeleteCvObjects(kernel, dilatedMask, invMask);

        let nz = cv.countNonZero(contextMask);
        if (nz < 100) {
          safeDeleteCvObjects(contextMask);
          contextMask = null;
          log(
            "Sin contexto suficiente cerca del texto. Usando estadísticas globales.",
            "info",
          );
        } else {
          log(
            `Usando anillo de contexto de ${nz} píxeles para calcular color.`,
            "info",
          );
        }
        await yieldToUI();
      }

      let corrected = null;
      if (method === "reinhard") {
        corrected = matchColorReinhard(alignedClean, srcCover, contextMask);
      } else if (method === "lut") {
        corrected = matchColorLut(alignedClean, srcCover, contextMask);
      } else {
        corrected = matchColorStats(alignedClean, srcCover, contextMask);
      }

      if (colorMatchLocal) {
        corrected.copyTo(colorMatchedClean, maskGray);
        safeDeleteCvObjects(corrected);
      } else {
        safeDeleteCvObjects(colorMatchedClean);
        colorMatchedClean = corrected;
      }

      if (contextMask) safeDeleteCvObjects(contextMask);
    }

    // Suavizado gaussiano de la máscara para transición imperceptible
    log("Difuminando bordes de la máscara (GaussianBlur)...", "info");
    await yieldToUI();

    blurredMask = new cv.Mat();
    if (blurSigma > 0) {
      let ksize = new cv.Size(0, 0);
      cv.GaussianBlur(maskGray, blurredMask, ksize, blurSigma, blurSigma);
    } else {
      blurredMask = maskGray.clone();
    }

    // Mezcla final de píxeles en JavaScript mediante Uint8ClampedArray
    log("Mezclando imágenes finales...", "info");
    await yieldToUI();

    let coverData = srcCover.data;
    let cleanData = colorMatchedClean.data;
    let maskData = blurredMask.data;

    let resultData = new Uint8ClampedArray(coverData.length);
    for (let i = 0; i < coverData.length; i += 4) {
      let m = maskData[i / 4] / 255.0;

      resultData[i] = coverData[i] * (1 - m) + cleanData[i] * m; // Canal R
      resultData[i + 1] = coverData[i + 1] * (1 - m) + cleanData[i + 1] * m; // Canal G
      resultData[i + 2] = coverData[i + 2] * (1 - m) + cleanData[i + 2] * m; // Canal B
      resultData[i + 3] = 255; // Alpha opaco
    }

    let finalCanvas = document.createElement("canvas");
    finalCanvas.width = srcCover.cols;
    finalCanvas.height = srcCover.rows;
    let finalCtx = finalCanvas.getContext("2d");

    let imgData = new ImageData(resultData, srcCover.cols, srcCover.rows);
    finalCtx.putImageData(imgData, 0, 0);

    const dataURL = finalCanvas.toDataURL("image/jpeg", 0.95);
    const imgAfter = document.getElementById("img-result-after");
    const imgBefore = document.getElementById("img-result-before");
    if (imgAfter) imgAfter.src = dataURL;
    if (imgBefore) imgBefore.src = imgOriginal.src;

    const btnDownload = document.getElementById("btn-download");
    if (btnDownload) {
      btnDownload.onclick = (e) => {
        e.preventDefault();
        downloadCanvasAsOptimizedPng(
          finalCanvas,
          "portada_limpia_restaurada.png",
        );
      };
    }

    const secResult = document.getElementById("section-result");
    if (secResult) secResult.style.display = "block";
    log("¡Procesamiento finalizado con éxito!", "success");

    setTimeout(() => {
      initResultViewerSize();
    }, 100);
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    log(`Error: ${errMsg}`, "error");
    alert(`Error al procesar: ${errMsg}`);
    console.error(err);
  } finally {
    // Liberación estricta de memoria WebAssembly de OpenCV.js
    safeDeleteCvObjects(
      srcCover,
      srcClean,
      srcMask,
      grayCover,
      grayClean,
      maskGray,
      maskContext,
      orb,
      kpCover,
      desCover,
      kpClean,
      desClean,
      matcher,
      matches,
      allMatches,
      maskMatches,
      ptsClean,
      ptsCover,
      H_candidate,
      H,
      alignedClean,
      colorMatchedClean,
      blurredMask,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ALGORITMOS DE AJUSTE DE COLOR (RGB, LAB REINHARD, LUT)
// ──────────────────────────────────────────────────────────────────────────────

function matchColorStats(src, ref, mask) {
  let meanSrc = new cv.Mat();
  let stddevSrc = new cv.Mat();
  let meanRef = new cv.Mat();
  let stddevRef = new cv.Mat();
  let activeMask = mask || new cv.Mat();
  let srcChannels = new cv.MatVector();
  let result = new cv.Mat();

  try {
    cv.meanStdDev(src, meanSrc, stddevSrc, activeMask);
    cv.meanStdDev(ref, meanRef, stddevRef, activeMask);

    cv.split(src, srcChannels);

    for (let c = 0; c < 3; c++) {
      let s_mean = meanSrc.data64F[c];
      let s_std = stddevSrc.data64F[c] + 1e-6;
      let r_mean = meanRef.data64F[c];
      let r_std = stddevRef.data64F[c] + 1e-6;

      let ch = srcChannels.get(c);
      let scale = r_std / s_std;
      let shift = -s_mean * scale + r_mean;

      let correctedCh = new cv.Mat();
      ch.convertTo(correctedCh, -1, scale, shift);
      srcChannels.set(c, correctedCh);

      safeDeleteCvObjects(ch, correctedCh);
    }

    cv.merge(srcChannels, result);
    return result;
  } finally {
    safeDeleteCvObjects(meanSrc, stddevSrc, meanRef, stddevRef);
    if (!mask && activeMask) safeDeleteCvObjects(activeMask);
    for (let i = 0; i < srcChannels.size(); i++) {
      let ch = srcChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    srcChannels.delete();
  }
}

function matchColorReinhard(src, ref, mask) {
  let srcRGB = new cv.Mat();
  let refRGB = new cv.Mat();
  let srcLab = new cv.Mat();
  let refLab = new cv.Mat();
  let meanSrc = new cv.Mat();
  let stddevSrc = new cv.Mat();
  let meanRef = new cv.Mat();
  let stddevRef = new cv.Mat();
  let activeMask = mask || new cv.Mat();
  let labChannels = new cv.MatVector();
  let correctedLab = new cv.Mat();
  let correctedRGB = new cv.Mat();
  let srcChannels = new cv.MatVector();
  let rgbChannels = new cv.MatVector();
  let result = new cv.Mat();

  try {
    cv.cvtColor(src, srcRGB, cv.COLOR_RGBA2RGB);
    cv.cvtColor(ref, refRGB, cv.COLOR_RGBA2RGB);

    cv.cvtColor(srcRGB, srcLab, cv.COLOR_RGB2Lab);
    cv.cvtColor(refRGB, refLab, cv.COLOR_RGB2Lab);

    cv.meanStdDev(srcLab, meanSrc, stddevSrc, activeMask);
    cv.meanStdDev(refLab, meanRef, stddevRef, activeMask);

    cv.split(srcLab, labChannels);

    for (let c = 0; c < 3; c++) {
      let s_mean = meanSrc.data64F[c];
      let s_std = stddevSrc.data64F[c] + 1e-6;
      let r_mean = meanRef.data64F[c];
      let r_std = stddevRef.data64F[c] + 1e-6;

      let ch = labChannels.get(c);
      let scale = r_std / s_std;
      let shift = -s_mean * scale + r_mean;

      let correctedCh = new cv.Mat();
      ch.convertTo(correctedCh, -1, scale, shift);
      labChannels.set(c, correctedCh);

      safeDeleteCvObjects(ch, correctedCh);
    }

    cv.merge(labChannels, correctedLab);
    cv.cvtColor(correctedLab, correctedRGB, cv.COLOR_Lab2RGB);

    cv.split(src, srcChannels);
    let alpha = srcChannels.get(3);

    cv.split(correctedRGB, rgbChannels);
    rgbChannels.push_back(alpha);

    cv.merge(rgbChannels, result);
    safeDeleteCvObjects(alpha);
    return result;
  } finally {
    safeDeleteCvObjects(
      srcRGB,
      refRGB,
      srcLab,
      refLab,
      meanSrc,
      stddevSrc,
      meanRef,
      stddevRef,
      correctedLab,
      correctedRGB,
    );
    if (!mask && activeMask) safeDeleteCvObjects(activeMask);
    for (let i = 0; i < labChannels.size(); i++) {
      let ch = labChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    labChannels.delete();
    for (let i = 0; i < rgbChannels.size(); i++) {
      let ch = rgbChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    rgbChannels.delete();
    for (let i = 0; i < srcChannels.size(); i++) {
      let ch = srcChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    srcChannels.delete();
  }
}

function matchColorLut(src, ref, mask) {
  let srcChannels = new cv.MatVector();
  let refChannels = new cv.MatVector();
  let activeMask = mask || new cv.Mat();
  let result = new cv.Mat();

  try {
    cv.split(src, srcChannels);
    cv.split(ref, refChannels);

    for (let c = 0; c < 3; c++) {
      let sCh = srcChannels.get(c);
      let rCh = refChannels.get(c);

      let sHist = new cv.Mat();
      let rHist = new cv.Mat();

      let sVec = new cv.MatVector();
      sVec.push_back(sCh);
      let rVec = new cv.MatVector();
      rVec.push_back(rCh);

      cv.calcHist(sVec, [0], activeMask, sHist, [256], [0, 256]);
      cv.calcHist(rVec, [0], activeMask, rHist, [256], [0, 256]);

      let sCdf = new Float64Array(256);
      let rCdf = new Float64Array(256);
      let sSum = 0,
        rSum = 0;
      for (let i = 0; i < 256; i++) {
        sSum += sHist.data32F[i];
        sCdf[i] = sSum;

        rSum += rHist.data32F[i];
        rCdf[i] = rSum;
      }

      let sMax = sCdf[255] + 1e-6;
      let rMax = rCdf[255] + 1e-6;
      for (let i = 0; i < 256; i++) {
        sCdf[i] /= sMax;
        rCdf[i] /= rMax;
      }

      let lut = new cv.Mat(1, 256, cv.CV_8U);
      let j = 0;
      for (let i = 0; i < 256; i++) {
        while (j < 255 && rCdf[j] < sCdf[i]) {
          j++;
        }
        lut.data[i] = j;
      }

      let correctedCh = new cv.Mat();
      cv.LUT(sCh, lut, correctedCh);
      srcChannels.set(c, correctedCh);

      safeDeleteCvObjects(sHist, rHist, sVec, rVec, lut, sCh, rCh, correctedCh);
    }

    cv.merge(srcChannels, result);
    return result;
  } finally {
    if (!mask && activeMask) safeDeleteCvObjects(activeMask);
    for (let i = 0; i < srcChannels.size(); i++) {
      let ch = srcChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    srcChannels.delete();
    for (let i = 0; i < refChannels.size(); i++) {
      let ch = refChannels.get(i);
      safeDeleteCvObjects(ch);
    }
    refChannels.delete();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// VISOR DE COMPARACIÓN INTERACTIVO (SLIDER + ZOOM / PAN)
// ──────────────────────────────────────────────────────────────────────────────

function setupResultViewer() {
  compareViewer = document.getElementById("compare-viewer");
  viewerPanZoom = document.getElementById("viewer-pan-zoom");
  compareHandle = document.getElementById("compare-handle");
  imgResultBefore = document.getElementById("img-result-before");
  imgResultAfter = document.getElementById("img-result-after");

  if (!compareViewer || !viewerPanZoom || !compareHandle) return;

  const btnReset = document.getElementById("btn-reset-view");
  if (btnReset) {
    btnReset.addEventListener("click", () => {
      initResultViewerSize();
    });
  }

  // Zoom con rueda del ratón
  compareViewer.addEventListener("wheel", (e) => {
    e.preventDefault();

    const rect = compareViewer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const localX = (mouseX - panX) / scale;
    const localY = (mouseY - panY) / scale;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    scale *= zoomFactor;
    scale = Math.min(Math.max(0.1, scale), 20);

    panX = mouseX - localX * scale;
    panY = mouseY - localY * scale;

    updateTransform();
  });

  // Paneo (Arrastre de fondo)
  compareViewer.addEventListener("mousedown", (e) => {
    if (e.target === compareHandle || compareHandle.contains(e.target)) {
      return;
    }

    isPanning = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    compareViewer.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (isPanning) {
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      updateTransform();
    }

    if (isSliding) {
      const rect = compareViewer.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      let percent = (mouseX / rect.width) * 100;
      percent = Math.min(Math.max(0, percent), 100);

      sliderPercent = percent;
      updateSliderPosition();
    }
  });

  window.addEventListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      compareViewer.style.cursor = "grab";
    }
    isSliding = false;
  });

  compareHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    isSliding = true;
  });
}

function initResultViewerSize() {
  if (!imgOriginal || !compareViewer || !viewerPanZoom) return;

  const imgW = imgOriginal.naturalWidth;
  const imgH = imgOriginal.naturalHeight;

  viewerPanZoom.style.width = imgW + "px";
  viewerPanZoom.style.height = imgH + "px";

  const viewerW = compareViewer.clientWidth;
  const viewerH = compareViewer.clientHeight;

  const scaleX = viewerW / imgW;
  const scaleY = viewerH / imgH;
  scale = Math.min(scaleX, scaleY);

  panX = (viewerW - imgW * scale) / 2;
  panY = (viewerH - imgH * scale) / 2;

  sliderPercent = 50;

  updateTransform();
  updateSliderPosition();
}

function updateTransform() {
  if (!viewerPanZoom) return;
  viewerPanZoom.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  updateSliderPosition();
}

function updateSliderPosition() {
  if (!imgOriginal || !compareHandle || !compareViewer || !imgResultAfter)
    return;

  compareHandle.style.left = sliderPercent + "%";

  const viewerW = compareViewer.clientWidth;
  const screenX = (sliderPercent / 100) * viewerW;
  const localX = (screenX - panX) / scale;

  const imgW = imgOriginal.naturalWidth;
  let localPercent = (localX / imgW) * 100;

  imgResultAfter.style.clipPath = `inset(0 0 0 ${localPercent}%)`;
}

// ──────────────────────────────────────────────────────────────────────────────
// MODAL DE CONFIRMACIÓN PERSONALIZADO (PROMISES)
// ──────────────────────────────────────────────────────────────────────────────

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const text = document.getElementById("confirm-modal-text");
    const btnCancel = document.getElementById("confirm-cancel");
    const btnAccept = document.getElementById("confirm-accept");

    if (!modal || !text || !btnCancel || !btnAccept) {
      resolve(confirm(message));
      return;
    }

    text.innerText = message;
    modal.style.display = "flex";
    modal.style.zIndex = "200";

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const handleAccept = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      modal.style.display = "none";
      btnCancel.removeEventListener("click", handleCancel);
      btnAccept.removeEventListener("click", handleAccept);
    };

    btnCancel.addEventListener("click", handleCancel);
    btnAccept.addEventListener("click", handleAccept);
  });
}

// Variables de estado global
let openCvLoaded = false;
let imgOriginal = null; // Elemento <img> para original
let imgClean = null; // Elemento <img> para limpia
let imgMask = null; // Elemento <img> para máscara (puede ser dataURL de canvas)

// Editor de Máscara (Canvas)
let bgCanvas, paintCanvas, ctxPaint;
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = "brush"; // 'brush', 'eraser' o 'pan'
let brushSize = 20;

// Historial para deshacer (Ctrl+Z)
let undoStack = [];
const MAX_UNDO_STATES = 25;

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

function undo() {
  if (!paintCanvas || !ctxPaint) return;
  if (undoStack.length > 0) {
    const prevState = undoStack.pop();
    ctxPaint.putImageData(prevState, 0, 0);
  }
}

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

// Listeners globales para el espacio en el paneo de máscara y deshacer (Ctrl+Z)
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    const modal = document.getElementById("mask-modal");
    if (modal && modal.style.display === "flex") {
      e.preventDefault();
      undo();
      return;
    }
  }

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

// Inicialización de la página
window.addEventListener("DOMContentLoaded", () => {
  setupDropzones();
  setupParameters();
  setupMaskEditor();
  setupResultViewer();

  // Configurar botones de acción
  document
    .getElementById("btn-process")
    .addEventListener("click", processImages);
});

// Carga asíncrona de OpenCV
function onOpenCvReady() {
  console.log("[+] OpenCV.js cargado correctamente.");
  openCvLoaded = true;
  document.getElementById("loading-overlay").style.display = "none";
}

function onOpenCvError() {
  alert("Error al cargar OpenCV.js. Por favor, recarga la página.");
}

// ──────────────────────────────────────────────────────────────────────────────
// DROPZONES Y ENTRADA DE ARCHIVOS
// ──────────────────────────────────────────────────────────────────────────────

function setupDropzones() {
  const dropzoneIds = ["dz-cover", "dz-clean", "dz-mask"];

  dropzoneIds.forEach((id) => {
    const dz = document.getElementById(id);
    const input = dz.querySelector(".file-input");

    // Clic para abrir selector de archivos
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
        e.stopPropagation(); // Evitar abrir el explorador de archivos
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
      preview.appendChild(img.cloneNode());
      preview.style.display = "block";

      // Mostrar botón de eliminar
      const btnRemove = dz.querySelector(".btn-remove-file");
      if (btnRemove) {
        btnRemove.style.display = "flex";
      }

      // Guardar en la variable correspondiente
      if (dzId === "dz-cover") {
        imgOriginal = img;
        document.getElementById("btn-paint-mask").disabled = false;
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
  const input = dz.querySelector(".file-input");
  const preview = dz.querySelector(".dz-preview");
  const btnRemove = dz.querySelector(".btn-remove-file");

  input.value = "";
  preview.innerHTML = "";
  preview.style.display = "none";
  if (btnRemove) {
    btnRemove.style.display = "none";
  }

  if (dzId === "dz-cover") {
    imgOriginal = null;
    document.getElementById("btn-paint-mask").disabled = true;
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
  if (imgOriginal && imgClean && imgMask) {
    btn.disabled = false;
  } else {
    btn.disabled = true;
  }
}

// Log en consola web
function log(msg, type = "info") {
  const consoleBox = document.getElementById("console-output");
  consoleBox.style.display = "block";
  let prefix = "[*]";
  if (type === "success") prefix = "[+]";
  if (type === "error") prefix = "[-]";
  consoleBox.innerText += `${prefix} ${msg}\n`;
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function clearLog() {
  const consoleBox = document.getElementById("console-output");
  consoleBox.innerText = "";
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTROL DE PARÁMETROS
// ──────────────────────────────────────────────────────────────────────────────

function setupParameters() {
  // Sincronizar sliders con sus etiquetas de valor
  const sliders = [
    { id: "param-dilate", valId: "val-dilate" },
    { id: "param-blur", valId: "val-blur" },
  ];

  sliders.forEach((s) => {
    const slider = document.getElementById(s.id);
    const label = document.getElementById(s.valId);
    slider.addEventListener("input", () => {
      label.innerText = slider.value;
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// EDITOR DE MÁSCARA (MODAL)
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
  ctxPaint = paintCanvas.getContext("2d");

  // Crear/obtener cursor personalizado
  const editorContainer = document.querySelector(".editor-canvas-container");
  let brushCursor = document.getElementById("editor-brush-cursor");
  if (!brushCursor) {
    brushCursor = document.createElement("div");
    brushCursor.id = "editor-brush-cursor";
    editorContainer.appendChild(brushCursor);
  }

  btnPaint.addEventListener("click", () => {
    if (!imgOriginal) return;
    openMaskModal();
  });

  const btnEditMask = document.getElementById("btn-edit-mask");
  if (btnEditMask) {
    btnEditMask.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!imgOriginal) return;
      openMaskModal();
    });
  }

  btnClose.addEventListener("click", closeModal);
  btnCancel.addEventListener("click", closeModal);

  btnSave.addEventListener("click", () => {
    // Exportar el canvas de pintura a una imagen
    const dataURL = paintCanvas.toDataURL("image/png");

    const img = new Image();
    img.onload = () => {
      const preview = document.getElementById("preview-mask");
      preview.innerHTML = "";
      preview.appendChild(img.cloneNode());
      preview.style.display = "block";

      imgMask = img;
      log("Máscara generada en el editor.", "success");
      checkReadyToProcess();

      // Mostrar botones de eliminar y editar
      const btnRemove = document.querySelector("#dz-mask .btn-remove-file");
      if (btnRemove) btnRemove.style.display = "flex";
      const btnEdit = document.querySelector("#dz-mask .btn-edit-mask");
      if (btnEdit) btnEdit.style.display = "flex";

      closeModal();
    };
    img.src = dataURL;
  });

  btnClear.addEventListener("click", async () => {
    const confirmed = await showCustomConfirm(
      "¿Seguro que deseas borrar toda la máscara pintada?",
    );
    if (confirmed) {
      saveUndoState();
      ctxPaint.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    }
  });

  // Herramientas Pincel / Borrador / Mover
  const btnBrush = document.getElementById("editor-tool-brush");
  const btnEraser = document.getElementById("editor-tool-eraser");
  const btnPan = document.getElementById("editor-tool-pan");
  const brushSizeSlider = document.getElementById("editor-brush-size");
  const brushSizeVal = document.getElementById("editor-val-brush-size");
  const brushPreview = document.getElementById("brush-preview");

  const opacitySlider = document.getElementById("editor-opacity");
  const opacityVal = document.getElementById("editor-val-opacity");

  btnBrush.addEventListener("click", () => {
    currentTool = "brush";
    setActiveToolButton(btnBrush);
    updateCursor();
  });

  btnEraser.addEventListener("click", () => {
    currentTool = "eraser";
    setActiveToolButton(btnEraser);
    updateCursor();
  });

  btnPan.addEventListener("click", () => {
    currentTool = "pan";
    setActiveToolButton(btnPan);
    updateCursor();
  });

  function setActiveToolButton(activeBtn) {
    [btnBrush, btnEraser, btnPan].forEach((btn) => {
      if (btn === activeBtn) {
        btn.classList.add("active", "btn-primary");
        btn.classList.remove("btn-secondary");
      } else {
        btn.classList.remove("active", "btn-primary");
        btn.classList.add("btn-secondary");
      }
    });
  }

  brushSizeSlider.addEventListener("input", () => {
    brushSize = parseInt(brushSizeSlider.value);
    brushSizeVal.innerText = brushSize;
    updateBrushPreview();
  });

  function updateBrushPreview() {
    // Escalar la vista previa del pincel para que quepa en el contenedor de 50px sin desplazar el menú
    const visualSize = Math.max(2, (brushSize / 100) * 46);
    brushPreview.style.width = visualSize + "px";
    brushPreview.style.height = visualSize + "px";
  }

  opacitySlider.addEventListener("input", () => {
    const opacity = parseFloat(opacitySlider.value);
    opacityVal.innerText = opacity.toFixed(1);
    paintCanvas.style.opacity = opacity;
  });

  // Desactivar el menú contextual del clic derecho
  paintCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Configurar dibujo y arrastre (pan) sobre el canvas
  paintCanvas.addEventListener("mousedown", (e) => {
    // Paneo: clic derecho, clic rueda central, o herramienta mover activa, o tecla espacio presionada
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

    // Clic izquierdo: dibujo
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
    // Actualizar posición del cursor del pincel
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
    brushCursor.style.display = "none";
  });

  window.addEventListener("mouseup", () => {
    if (editorIsPanning) {
      editorIsPanning = false;
      updateCursor();
    }
    isDrawing = false;
  });

  // Zoom con rueda en el contenedor de máscara
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

  function updateBrushCursorPosition(e) {
    if (currentTool === "pan" || spacePressed || editorIsPanning) {
      brushCursor.style.display = "none";
      return;
    }

    const rect = editorContainer.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Solo mostrar si el puntero está exactamente sobre el canvas de pintura
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

  // Soporte táctil
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
  modal.style.display = "flex";

  // Reiniciar pila de deshacer al abrir
  undoStack = [];

  const imgWidth = imgOriginal.naturalWidth;
  const imgHeight = imgOriginal.naturalHeight;

  // Establecer la resolución interna de los canvases idéntica a la imagen
  bgCanvas.width = imgWidth;
  bgCanvas.height = imgHeight;
  paintCanvas.width = imgWidth;
  paintCanvas.height = imgHeight;

  // Ajustar el tamaño inicial del canvas dentro del área visible de 860x420
  const containerWidth = 860;
  const containerHeight = 420;
  const scaleX = containerWidth / imgWidth;
  const scaleY = containerHeight / imgHeight;
  const displayScale = Math.min(scaleX, scaleY, 1);

  editorDisplayW = imgWidth * displayScale;
  editorDisplayH = imgHeight * displayScale;

  // Configurar dimensiones de estilo base (antes del zoom)
  bgCanvas.style.width = editorDisplayW + "px";
  bgCanvas.style.height = editorDisplayH + "px";
  paintCanvas.style.width = editorDisplayW + "px";
  paintCanvas.style.height = editorDisplayH + "px";

  const wrapper = paintCanvas.parentNode;
  wrapper.style.width = editorDisplayW + "px";
  wrapper.style.height = editorDisplayH + "px";

  // Centrar inicialmente el canvas wrapper usando translate
  editorScale = 1;
  editorPanX = (containerWidth - editorDisplayW) / 2;
  editorPanY = (containerHeight - editorDisplayH) / 2;

  updateEditorTransform();

  // Dibujar la imagen original en el fondo
  const ctxBg = bgCanvas.getContext("2d");
  ctxBg.drawImage(imgOriginal, 0, 0);

  // Si ya existe una máscara cargada, pintarla inicialmente en el editor
  ctxPaint.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  if (imgMask) {
    try {
      // Conversión de fondo negro a transparente para permitir la edición
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
            data[i + 3] = 0; // Negro -> Transparente
          } else {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255; // Blanco sólido
          }
        }
        tempCtx.putImageData(imgData, 0, 0);
      }

      ctxPaint.drawImage(tempCanvas, 0, 0);
    } catch (e) {
      console.error("Error drawing mask to canvas:", e);
      try {
        ctxPaint.drawImage(
          imgMask,
          0,
          0,
          paintCanvas.width,
          paintCanvas.height,
        );
      } catch (err) {}
    }
  }

  // Inicializar visualización del pincel
  brushSize = parseInt(document.getElementById("editor-brush-size").value);
  const brushPreview = document.getElementById("brush-preview");
  const visualSize = Math.max(2, (brushSize / 100) * 46);
  brushPreview.style.width = visualSize + "px";
  brushPreview.style.height = visualSize + "px";

  // Inicializar opacidad de la máscara
  const opacitySlider = document.getElementById("editor-opacity");
  const opacityVal = document.getElementById("editor-val-opacity");
  opacitySlider.value = 0.7;
  opacityVal.innerText = "0.7";
  paintCanvas.style.opacity = 0.7;

  // Restaurar a la herramienta pincel por defecto
  const btnBrush = document.getElementById("editor-tool-brush");
  currentTool = "brush";

  const btnEraser = document.getElementById("editor-tool-eraser");
  const btnPan = document.getElementById("editor-tool-pan");
  [btnBrush, btnEraser, btnPan].forEach((btn) => {
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
  const wrapper = paintCanvas.parentNode;
  wrapper.style.transform = `translate(${editorPanX}px, ${editorPanY}px) scale(${editorScale})`;
}

function closeModal() {
  document.getElementById("mask-modal").style.display = "none";
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

  // Escalar hacia atrás restando la traslación y dividiendo entre la escala
  const displayX = (mx - editorPanX) / editorScale;
  const displayY = (my - editorPanY) / editorScale;

  // Mapear de píxeles visuales base a píxeles nativos del canvas
  const scaleX = paintCanvas.width / editorDisplayW;
  const scaleY = paintCanvas.height / editorDisplayH;

  return {
    x: displayX * scaleX,
    y: displayY * scaleY,
  };
}

function startDrawing(e) {
  isDrawing = true;
  const pos = getMousePos(e);
  lastX = pos.x;
  lastY = pos.y;
  drawDot(pos.x, pos.y);
}

function startDrawingTouch(e) {
  e.preventDefault();
  startDrawing(e);
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getMousePos(e);

  ctxPaint.beginPath();
  ctxPaint.moveTo(lastX, lastY);
  ctxPaint.lineTo(pos.x, pos.y);

  if (currentTool === "eraser") {
    ctxPaint.globalCompositeOperation = "destination-out";
    ctxPaint.strokeStyle = "rgba(0,0,0,1)";
    ctxPaint.lineWidth = brushSize;
  } else {
    ctxPaint.globalCompositeOperation = "source-over";
    ctxPaint.strokeStyle = "#ffffff";
    ctxPaint.lineWidth = brushSize;
  }

  ctxPaint.lineCap = "round";
  ctxPaint.lineJoin = "round";
  ctxPaint.stroke();

  lastX = pos.x;
  lastY = pos.y;
}

function drawTouch(e) {
  e.preventDefault();
  draw(e);
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

function stopDrawing() {
  isDrawing = false;
}

// ──────────────────────────────────────────────────────────────────────────────
// PROCESAMIENTO CON OPENCV.JS
// ──────────────────────────────────────────────────────────────────────────────

function processImages() {
  if (!openCvLoaded) {
    alert("Abriendo OpenCV.js, espera que cargue.");
    return;
  }

  clearLog();
  log("Iniciando procesamiento de limpieza...", "info");

  // Obtener parámetros
  const colorMatch = document.getElementById("param-color-match").checked;
  const colorMatchLocal = document.getElementById("param-color-local").checked;
  const method = document.getElementById("param-method").value;
  const dilatePx = parseInt(document.getElementById("param-dilate").value);
  const blurSigma = parseFloat(document.getElementById("param-blur").value);

  // Crear Matrices de OpenCV
  let srcCover = null;
  let srcClean = null;
  let srcMask = null;
  let grayCover = new cv.Mat();
  let grayClean = new cv.Mat();

  try {
    log("Cargando imágenes en memoria...", "info");
    srcCover = cv.imread(imgOriginal);
    srcClean = cv.imread(imgClean);
    srcMask = cv.imread(imgMask);

    cv.cvtColor(srcCover, grayCover, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(srcClean, grayClean, cv.COLOR_RGBA2GRAY);

    log("Detectando puntos de interés (ORB)...", "info");
    let orb = new cv.ORB();
    let kpCover = new cv.KeyPointVector();
    let desCover = new cv.Mat();
    let kpClean = new cv.KeyPointVector();
    let desClean = new cv.Mat();

    orb.detectAndCompute(grayCover, new cv.Mat(), kpCover, desCover);
    orb.detectAndCompute(grayClean, new cv.Mat(), kpClean, desClean);

    log(
      `Puntos clave - Original: ${kpCover.size()} | Limpia: ${kpClean.size()}`,
      "info",
    );

    if (kpCover.size() < 4 || kpClean.size() < 4) {
      throw new Error(
        "Pocos puntos de interés detectados. Comprueba la calidad de las imágenes.",
      );
    }

    log("Buscando coincidencias de puntos...", "info");
    let matcher = new cv.BFMatcher(cv.NORM_HAMMING);
    let matches = new cv.DMatchVectorVector();
    matcher.knnMatch(desClean, desCover, matches, 2);

    let goodMatches = new cv.DMatchVector();
    for (let i = 0; i < matches.size(); i++) {
      let matchPair = matches.get(i);
      if (matchPair.size() < 2) continue;
      let m = matchPair.get(0);
      let n = matchPair.get(1);
      if (m.distance < 0.75 * n.distance) {
        goodMatches.push_back(m);
      }
    }

    log(`Coincidencias válidas encontradas: ${goodMatches.size()}`, "info");

    if (goodMatches.size() < 4) {
      throw new Error(
        "No se encontraron suficientes coincidencias para alinear las imágenes.",
      );
    }

    log("Calculando matriz de alineación homográfica (RANSAC)...", "info");
    let ptsClean = new cv.Mat(goodMatches.size(), 1, cv.CV_32FC2);
    let ptsCover = new cv.Mat(goodMatches.size(), 1, cv.CV_32FC2);

    for (let i = 0; i < goodMatches.size(); i++) {
      let m = goodMatches.get(i);
      let ptClean = kpClean.get(m.queryIdx).pt;
      let ptCover = kpCover.get(m.trainIdx).pt;

      ptsClean.data32F[i * 2] = ptClean.x;
      ptsClean.data32F[i * 2 + 1] = ptClean.y;

      ptsCover.data32F[i * 2] = ptCover.x;
      ptsCover.data32F[i * 2 + 1] = ptCover.y;
    }

    let H = cv.findHomography(ptsClean, ptsCover, cv.RANSAC, 5.0);

    log("Alineando perspectiva de la imagen limpia...", "info");
    let alignedClean = new cv.Mat();
    let dsize = new cv.Size(srcCover.cols, srcCover.rows);
    cv.warpPerspective(
      srcClean,
      alignedClean,
      H,
      dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 0),
    );

    // Procesar la Máscara
    log("Procesando máscara de entrada...", "info");
    let maskGray = new cv.Mat();
    if (srcMask.channels() === 4) {
      // Si tiene canal alpha (RGBA), extraemos el alpha para la máscara
      let channels = new cv.MatVector();
      cv.split(srcMask, channels);
      maskGray = channels.get(3).clone();

      // Si la máscara está vacía (todo blanco/opaco), usamos el color como fallback
      let meanVal = cv.mean(maskGray)[0];
      if (meanVal > 250) {
        cv.cvtColor(srcMask, maskGray, cv.COLOR_RGBA2GRAY);
      }

      for (let i = 0; i < channels.size(); i++) channels.get(i).delete();
      channels.delete();
    } else if (srcMask.channels() === 3) {
      cv.cvtColor(srcMask, maskGray, cv.COLOR_RGB2GRAY);
    } else {
      maskGray = srcMask.clone();
    }

    // Redimensionar máscara al tamaño original si difieren
    if (maskGray.cols !== srcCover.cols || maskGray.rows !== srcCover.rows) {
      let resizedMask = new cv.Mat();
      cv.resize(maskGray, resizedMask, dsize, 0, 0, cv.INTER_LINEAR);
      maskGray.delete();
      maskGray = resizedMask;
    }

    // Ajuste de Color (Color Match)
    let colorMatchedClean = alignedClean.clone();
    if (colorMatch) {
      log(`Aplicando ajuste de color (Método: ${method})...`, "info");

      // Generar anillo de contexto si hay dilación
      let contextMask = null;
      if (dilatePx > 0) {
        let kernel = cv.Mat.ones(dilatePx * 2 + 1, dilatePx * 2 + 1, cv.CV_8U);
        let dilatedMask = new cv.Mat();
        cv.dilate(maskGray, dilatedMask, kernel);

        let invMask = new cv.Mat();
        cv.bitwise_not(maskGray, invMask);

        contextMask = new cv.Mat();
        cv.bitwise_and(dilatedMask, invMask, contextMask);

        kernel.delete();
        dilatedMask.delete();
        invMask.delete();

        let nz = cv.countNonZero(contextMask);
        if (nz < 100) {
          contextMask.delete();
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
      }

      // Realizar el ajuste
      let corrected = null;
      if (method === "reinhard") {
        corrected = matchColorReinhard(alignedClean, srcCover, contextMask);
      } else if (method === "lut") {
        corrected = matchColorLut(alignedClean, srcCover, contextMask);
      } else {
        corrected = matchColorStats(alignedClean, srcCover, contextMask);
      }

      if (colorMatchLocal) {
        // Modo local: el ajuste se aplica SOLO dentro de la máscara original
        // El resto del fondo de la limpia conserva sus colores originales
        corrected.copyTo(colorMatchedClean, maskGray);
        corrected.delete();
      } else {
        // Modo global: el ajuste se aplica a toda la imagen limpia alineada
        colorMatchedClean.delete();
        colorMatchedClean = corrected;
      }

      if (contextMask) contextMask.delete();
    }

    // Difuminar la máscara para fusión suave de bordes
    log("Difuminando bordes de fusión (GaussianBlur)...", "info");
    let blurredMask = new cv.Mat();
    if (blurSigma > 0) {
      let ksize = new cv.Size(0, 0);
      cv.GaussianBlur(maskGray, blurredMask, ksize, blurSigma, blurSigma);
    } else {
      blurredMask = maskGray.clone();
    }

    // Mezclar las imágenes pixel a pixel usando JS de alta velocidad
    log("Mezclando imágenes finales...", "info");
    let coverData = srcCover.data;
    let cleanData = colorMatchedClean.data;
    let maskData = blurredMask.data;

    let resultData = new Uint8ClampedArray(coverData.length);
    for (let i = 0; i < coverData.length; i += 4) {
      let m = maskData[i / 4] / 255.0; // canal simple del blur

      resultData[i] = coverData[i] * (1 - m) + cleanData[i] * m; // R
      resultData[i + 1] = coverData[i + 1] * (1 - m) + cleanData[i + 1] * m; // G
      resultData[i + 2] = coverData[i + 2] * (1 - m) + cleanData[i + 2] * m; // B
      resultData[i + 3] = 255; // Alpha opaco
    }

    // Renderizar el resultado en un canvas temporal para descargarlo y previsualizarlo
    let finalCanvas = document.createElement("canvas");
    finalCanvas.width = srcCover.cols;
    finalCanvas.height = srcCover.rows;
    let finalCtx = finalCanvas.getContext("2d");

    let imgData = new ImageData(resultData, srcCover.cols, srcCover.rows);
    finalCtx.putImageData(imgData, 0, 0);

    // Cargar en el visor
    const dataURL = finalCanvas.toDataURL("image/jpeg", 0.95);
    document.getElementById("img-result-after").src = dataURL;
    document.getElementById("img-result-before").src = imgOriginal.src;
    document.getElementById("btn-download").href = dataURL;

    // Mostrar visor
    document.getElementById("section-result").style.display = "block";
    log("¡Procesamiento finalizado con éxito!", "success");

    // Inicializar tamaño y zoom del visor
    setTimeout(() => {
      initResultViewerSize();
    }, 100);

    // Limpieza de objetos OpenCV.js del procesamiento principal
    orb.delete();
    kpCover.delete();
    desCover.delete();
    kpClean.delete();
    desClean.delete();
    matches.delete();
    goodMatches.delete();
    ptsClean.delete();
    ptsCover.delete();
    H.delete();
    alignedClean.delete();
    maskGray.delete();
    colorMatchedClean.delete();
    blurredMask.delete();
  } catch (err) {
    log(`Error: ${err.message}`, "error");
    alert(`Error al procesar: ${err.message}`);
    console.error(err);
  } finally {
    // Liberar Mats básicas siempre
    if (srcCover) srcCover.delete();
    if (srcClean) srcClean.delete();
    if (srcMask) srcMask.delete();
    grayCover.delete();
    grayClean.delete();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ALGORITMOS DE AJUSTE DE COLOR EN OPENCV.JS
// ──────────────────────────────────────────────────────────────────────────────

function matchColorStats(src, ref, mask) {
  let meanSrc = new cv.Mat();
  let stddevSrc = new cv.Mat();
  let meanRef = new cv.Mat();
  let stddevRef = new cv.Mat();

  let activeMask = mask || new cv.Mat();

  cv.meanStdDev(src, meanSrc, stddevSrc, activeMask);
  cv.meanStdDev(ref, meanRef, stddevRef, activeMask);

  let srcChannels = new cv.MatVector();
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

    ch.delete();
    correctedCh.delete();
  }

  let result = new cv.Mat();
  cv.merge(srcChannels, result);

  // Limpieza
  meanSrc.delete();
  stddevSrc.delete();
  meanRef.delete();
  stddevRef.delete();
  if (!mask) activeMask.delete();
  for (let i = 0; i < srcChannels.size(); i++) srcChannels.get(i).delete();
  srcChannels.delete();

  return result;
}

function matchColorReinhard(src, ref, mask) {
  let srcRGB = new cv.Mat();
  let refRGB = new cv.Mat();
  cv.cvtColor(src, srcRGB, cv.COLOR_RGBA2RGB);
  cv.cvtColor(ref, refRGB, cv.COLOR_RGBA2RGB);

  let srcLab = new cv.Mat();
  let refLab = new cv.Mat();
  cv.cvtColor(srcRGB, srcLab, cv.COLOR_RGB2Lab);
  cv.cvtColor(refRGB, refLab, cv.COLOR_RGB2Lab);

  let meanSrc = new cv.Mat();
  let stddevSrc = new cv.Mat();
  let meanRef = new cv.Mat();
  let stddevRef = new cv.Mat();
  let activeMask = mask || new cv.Mat();

  cv.meanStdDev(srcLab, meanSrc, stddevSrc, activeMask);
  cv.meanStdDev(refLab, meanRef, stddevRef, activeMask);

  let labChannels = new cv.MatVector();
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

    ch.delete();
    correctedCh.delete();
  }

  let correctedLab = new cv.Mat();
  cv.merge(labChannels, correctedLab);

  let correctedRGB = new cv.Mat();
  cv.cvtColor(correctedLab, correctedRGB, cv.COLOR_Lab2RGB);

  // Unir con alpha original
  let srcChannels = new cv.MatVector();
  cv.split(src, srcChannels);
  let alpha = srcChannels.get(3);

  let rgbChannels = new cv.MatVector();
  cv.split(correctedRGB, rgbChannels);
  rgbChannels.push_back(alpha);

  let result = new cv.Mat();
  cv.merge(rgbChannels, result);

  // Limpieza
  srcRGB.delete();
  refRGB.delete();
  srcLab.delete();
  refLab.delete();
  meanSrc.delete();
  stddevSrc.delete();
  meanRef.delete();
  stddevRef.delete();
  if (!mask) activeMask.delete();
  correctedLab.delete();
  correctedRGB.delete();
  alpha.delete();
  for (let i = 0; i < labChannels.size(); i++) labChannels.get(i).delete();
  labChannels.delete();
  for (let i = 0; i < rgbChannels.size(); i++) rgbChannels.get(i).delete();
  rgbChannels.delete();
  for (let i = 0; i < srcChannels.size(); i++) srcChannels.get(i).delete();
  srcChannels.delete();

  return result;
}

function matchColorLut(src, ref, mask) {
  let srcChannels = new cv.MatVector();
  cv.split(src, srcChannels);

  let refChannels = new cv.MatVector();
  cv.split(ref, refChannels);

  let activeMask = mask || new cv.Mat();

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

    // CDF
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

    // Mapeo LUT
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

    // Limpieza de este canal
    sHist.delete();
    rHist.delete();
    sVec.delete();
    rVec.delete();
    lut.delete();
    sCh.delete();
    rCh.delete();
    correctedCh.delete();
  }

  let result = new cv.Mat();
  cv.merge(srcChannels, result);

  // Limpieza
  if (!mask) activeMask.delete();
  for (let i = 0; i < srcChannels.size(); i++) srcChannels.get(i).delete();
  srcChannels.delete();
  for (let i = 0; i < refChannels.size(); i++) refChannels.get(i).delete();
  refChannels.delete();

  return result;
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

  document.getElementById("btn-reset-view").addEventListener("click", () => {
    initResultViewerSize();
  });

  // --- Zoom con Rueda ---
  compareViewer.addEventListener("wheel", (e) => {
    e.preventDefault(); // Evitar scroll de la página

    const rect = compareViewer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Coordenadas locales antes del zoom
    const localX = (mouseX - panX) / scale;
    const localY = (mouseY - panY) / scale;

    // Multiplicador de zoom
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    scale *= zoomFactor;

    // Límites de zoom
    scale = Math.min(Math.max(0.1, scale), 20);

    // Ajustar Pan para que el zoom sea centrado en el ratón
    panX = mouseX - localX * scale;
    panY = mouseY - localY * scale;

    updateTransform();
  });

  // --- Paneo (Arrastre de Fondo) ---
  compareViewer.addEventListener("mousedown", (e) => {
    if (e.target === compareHandle || compareHandle.contains(e.target)) {
      // Si pulsamos el slider, es para deslizar, no para arrastrar
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
      // Deslizador de comparación en espacio de pantalla estático (independiente del zoom)
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

  // Drag del handle de comparación
  compareHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    isSliding = true;
  });
}

function initResultViewerSize() {
  if (!imgOriginal) return;

  const imgW = imgOriginal.naturalWidth;
  const imgH = imgOriginal.naturalHeight;

  // Configurar tamaño del contenedor al de la imagen nativa
  viewerPanZoom.style.width = imgW + "px";
  viewerPanZoom.style.height = imgH + "px";

  const viewerW = compareViewer.clientWidth;
  const viewerH = compareViewer.clientHeight;

  // Escala inicial para ajustar la imagen al visor
  const scaleX = viewerW / imgW;
  const scaleY = viewerH / imgH;
  scale = Math.min(scaleX, scaleY);

  // Centrar la imagen en el visor
  panX = (viewerW - imgW * scale) / 2;
  panY = (viewerH - imgH * scale) / 2;

  // Restablecer slider al 50%
  sliderPercent = 50;

  updateTransform();
  updateSliderPosition();
}

function updateTransform() {
  viewerPanZoom.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  updateSliderPosition(); // Re-calcular el recorte de la capa superior tras mover o hacer zoom
}

function updateSliderPosition() {
  if (!imgOriginal) return;

  // Colocar el handle de comparación en porcentaje relativo de pantalla (estático)
  compareHandle.style.left = sliderPercent + "%";

  const viewerW = compareViewer.clientWidth;
  const screenX = (sliderPercent / 100) * viewerW;

  // Mapear la coordenada X de la pantalla a la coordenada local sobre la imagen (zoom y pan)
  const localX = (screenX - panX) / scale;

  // Calcular porcentaje de recorte relativo al ancho nativo de la imagen
  const imgW = imgOriginal.naturalWidth;
  let localPercent = (localX / imgW) * 100;

  // Aplicar el clip-path en la capa superior (after)
  imgResultAfter.style.clipPath = `inset(0 0 0 ${localPercent}%)`;
}

// MODAL DE CONFIRMACIÓN PERSONALIZADO
function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const text = document.getElementById("confirm-modal-text");
    const btnCancel = document.getElementById("confirm-cancel");
    const btnAccept = document.getElementById("confirm-accept");

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

"""
cover_editor.py
===============
Herramienta unificada para edición de portadas de novelas ligeras.

SUBCOMANDOS:
  align   Alinea la imagen limpia sobre la cover y guarda el resultado.
  clean   Alinea internamente y aplica la máscara para limpiar el texto.

──────────────────────────────────────────────────────────────────────────────
REQUISITOS:
  pip install opencv-contrib-python pillow scipy numpy
──────────────────────────────────────────────────────────────────────────────
"""

import sys
import os
import argparse
import subprocess
import tempfile
import numpy as np

try:
    import cv2
except ImportError:
    print("[-] OpenCV no está instalado.")
    print("   Instálalo con:  pip install opencv-contrib-python")
    sys.exit(1)

try:
    from PIL import Image
    from scipy.ndimage import gaussian_filter, binary_dilation
except ImportError:
    print("[-] Faltan dependencias.")
    print("   Instálalas con:  pip install pillow scipy numpy")
    sys.exit(1)


def get_valid_path(base_name):
    """Verifica si el archivo existe tal cual, o le agrega .jpg / .png"""
    if os.path.isfile(base_name):
        return base_name
    for ext in [".jpg", ".png"]:
        if os.path.isfile(base_name + ext):
            return base_name + ext
    print(f"[-] No se encontró la imagen: {base_name} (se probó con .jpg y .png)")
    sys.exit(1)


def find_waifu2x_executable():
    """Busca el ejecutable waifu2x-ncnn-vulkan en directorios que comiencen con 'waifu2x'."""
    if os.path.isfile("waifu2x-ncnn-vulkan.exe"):
        return "waifu2x-ncnn-vulkan.exe"

    try:
        for entry in os.listdir("."):
            if os.path.isdir(entry) and entry.lower().startswith("waifu2x"):
                ruta_exe = os.path.join(entry, "waifu2x-ncnn-vulkan.exe")
                if os.path.isfile(ruta_exe):
                    return ruta_exe
    except Exception:
        pass

    return None


def ejecutar_waifu2x(executable_path, input_image_path):
    """Ejecuta waifu2x-ncnn-vulkan sobre la imagen de entrada y devuelve la ruta de la imagen procesada."""
    temp_dir = tempfile.gettempdir()
    output_path = os.path.join(temp_dir, "waifu2x_temp_out.png")
    
    exe_dir = os.path.dirname(os.path.abspath(executable_path))
    
    cmd = [
        os.path.abspath(executable_path),
        "-i", os.path.abspath(input_image_path),
        "-o", output_path,
        "-n", "2",
        "-s", "2",
        "-m", "models-cunet"
    ]
    
    print(f"[*] Ejecutando waifu2x en: {input_image_path}...")
    try:
        subprocess.run(cmd, cwd=exe_dir, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("[+] waifu2x finalizado correctamente.")
        return output_path
    except Exception as e:
        print(f"[-] Error al ejecutar waifu2x: {e}")
        sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# ALINEACIÓN — SIFT + FLANN + RANSAC
# ══════════════════════════════════════════════════════════════════════════════

def alinear_automatico(cover_bgr, limpia_bgr):
    """Calcula la homografía automáticamente usando SIFT."""
    print("[*] Detectando puntos de referencia automáticamente (SIFT)...")

    gray_cover  = cv2.cvtColor(cover_bgr,  cv2.COLOR_BGR2GRAY)
    gray_limpia = cv2.cvtColor(limpia_bgr, cv2.COLOR_BGR2GRAY)

    try:
        detector = cv2.SIFT_create()
    except AttributeError:
        print("[-] SIFT no disponible. Instala: pip install opencv-contrib-python")
        sys.exit(1)

    kp1, des1 = detector.detectAndCompute(gray_cover,  None)
    kp2, des2 = detector.detectAndCompute(gray_limpia, None)

    print(f"   Cover:  {len(kp1)} puntos clave")
    print(f"   Limpia: {len(kp2)} puntos clave")

    if len(kp1) < 4 or len(kp2) < 4:
        print("[-] Muy pocos puntos detectados. Asegúrate de que las imágenes tengan calidad suficiente.")
        sys.exit(1)

    index_params  = dict(algorithm=1, trees=5)
    search_params = dict(checks=50)
    flann   = cv2.FlannBasedMatcher(index_params, search_params)
    matches = flann.knnMatch(des2, des1, k=2)

    buenos = [m for m, n in matches if m.distance < 0.75 * n.distance]
    print(f"   Matches buenos: {len(buenos)}")

    if len(buenos) < 4:
        print("[-] No hay suficientes matches. Se requieren imágenes más parecidas o de mayor resolución.")
        sys.exit(1)

    pts_limpia = np.float32([kp2[m.queryIdx].pt for m in buenos]).reshape(-1, 1, 2)
    pts_cover  = np.float32([kp1[m.trainIdx].pt for m in buenos]).reshape(-1, 1, 2)

    H, mask = cv2.findHomography(pts_limpia, pts_cover, cv2.RANSAC, 5.0)
    inliers = int(mask.sum())
    print(f"   Inliers tras RANSAC: {inliers}")

    if H is None or inliers < 4:
        print("[-] No se pudo calcular la homografía de alineación.")
        sys.exit(1)

    return H


def aplicar_homografia(cover_cv, limpia_cv, H):
    """Aplica la homografía a limpia_cv para que encaje con cover_cv."""
    h, w = cover_cv.shape[:2]
    canales = limpia_cv.shape[2] if limpia_cv.ndim == 3 else 1

    if canales == 4:
        bgr   = limpia_cv[:, :, :3]
        alpha = limpia_cv[:, :, 3]
        bgr_alineado   = cv2.warpPerspective(bgr,   H, (w, h), flags=cv2.INTER_LANCZOS4)
        alpha_alineado = cv2.warpPerspective(alpha, H, (w, h), flags=cv2.INTER_LANCZOS4)
        return cv2.merge([*cv2.split(bgr_alineado), alpha_alineado])
    else:
        return cv2.warpPerspective(limpia_cv, H, (w, h), flags=cv2.INTER_LANCZOS4)


# ══════════════════════════════════════════════════════════════════════════════
# COLOR MATCHING
# ══════════════════════════════════════════════════════════════════════════════

def match_color_stats(src, ref, mask=None):
    result = src.astype(float).copy()
    for c in range(3):
        if mask is not None and mask.any():
            ref_px = ref[:, :, c][mask].astype(float)
            src_px = src[:, :, c][mask].astype(float)
        else:
            ref_px = ref[:, :, c].astype(float).ravel()
            src_px = src[:, :, c].astype(float).ravel()

        s_mean, s_std = src_px.mean(), src_px.std() + 1e-6
        r_mean, r_std = ref_px.mean(), ref_px.std() + 1e-6

        ch = result[:, :, c]
        result[:, :, c] = np.clip((ch - s_mean) * (r_std / s_std) + r_mean, 0, 255)

    return result.astype(np.uint8)


def match_color_reinhard(src, ref, mask=None):
    from PIL import ImageCms

    def rgb_to_lab(img_np):
        pil  = Image.fromarray(img_np.astype(np.uint8))
        srgb = ImageCms.createProfile("sRGB")
        lab  = ImageCms.createProfile("LAB")
        tf   = ImageCms.buildTransformFromOpenProfiles(srgb, lab, "RGB", "LAB")
        return np.array(ImageCms.applyTransform(pil, tf)).astype(float)

    def lab_to_rgb(lab_np):
        pil  = Image.fromarray(lab_np.astype(np.uint8))
        srgb = ImageCms.createProfile("sRGB")
        lab  = ImageCms.createProfile("LAB")
        tf   = ImageCms.buildTransformFromOpenProfiles(lab, srgb, "LAB", "RGB")
        return np.array(ImageCms.applyTransform(pil, tf))

    try:
        src_lab = rgb_to_lab(src)
        ref_lab = rgb_to_lab(ref)
        result_lab = src_lab.copy()

        OFFSETS = [0.0, 128.0, 128.0]
        RANGES  = [(0, 255), (-128, 127), (-128, 127)]

        for c in range(3):
            off  = OFFSETS[c]
            lo, hi = RANGES[c]
            src_c = src_lab[:, :, c] - off
            ref_c = ref_lab[:, :, c] - off
            res_c = result_lab[:, :, c] - off

            s = src_c[mask].ravel() if (mask is not None and mask.any()) else src_c.ravel()
            r = ref_c[mask].ravel() if (mask is not None and mask.any()) else ref_c.ravel()

            s_mean, s_std = s.mean(), s.std() + 1e-6
            r_mean, r_std = r.mean(), r.std() + 1e-6

            res_c = (res_c - s_mean) * (r_std / s_std) + r_mean
            result_lab[:, :, c] = np.clip(res_c + off, lo + off, hi + off)

        return lab_to_rgb(result_lab)
    except Exception as e:
        print(f"  [!] Reinhard falló ({e}), usando stats RGB.")
        return match_color_stats(src, ref, mask)


def match_color_lut(src, ref, mask=None):
    result = src.copy().astype(np.uint8)
    for c in range(3):
        s_vals = src[:, :, c][mask].ravel() if (mask is not None and mask.any()) else src[:, :, c].ravel()
        r_vals = ref[:, :, c][mask].ravel() if (mask is not None and mask.any()) else ref[:, :, c].ravel()

        s_hist, _ = np.histogram(s_vals, bins=256, range=(0, 255))
        r_hist, _ = np.histogram(r_vals, bins=256, range=(0, 255))
        s_cdf = np.cumsum(s_hist).astype(float); s_cdf /= s_cdf[-1] + 1e-6
        r_cdf = np.cumsum(r_hist).astype(float); r_cdf /= r_cdf[-1] + 1e-6

        lut = np.zeros(256, dtype=np.uint8)
        j = 0
        for i in range(256):
            while j < 255 and r_cdf[j] < s_cdf[i]:
                j += 1
            lut[i] = j

        result[:, :, c] = lut[src[:, :, c]]
    return result


# ══════════════════════════════════════════════════════════════════════════════
# COMPOSITING CON MÁSCARA
# ══════════════════════════════════════════════════════════════════════════════

def match_color_local(limpia_rgb, orig_rgb, mask_bool):
    """
    Ajusta el color de limpia_rgb para que coincida con orig_rgb
    usando solo los píxeles del borde exterior de la máscara como referencia,
    y aplica la corrección SOLO dentro de la máscara, con un fade suave en los bordes.

    Estrategia:
      1. Dilata la máscara para obtener el anillo de contexto exterior.
      2. Calcula el delta de color medio entre orig y limpia en ese anillo.
      3. Aplica ese delta solo dentro de la máscara, fusionándolo suavemente
         con la máscara suavizada para que los bordes no corten bruscamente.
    """
    print("  [+] Ajustando color local (solo dentro de la máscara)...")

    # Anillo de contexto: píxeles justo fuera de la máscara
    struct = np.ones((41, 41), dtype=bool)  # 20px de dilación
    mask_dilated = binary_dilation(mask_bool, structure=struct)
    context_ring = mask_dilated & ~mask_bool

    if context_ring.sum() < 50:
        print("  [!] Anillo de contexto muy pequeño; se usa máscara completa como referencia.")
        context_ring = ~mask_bool

    # Delta medio por canal en el anillo de contexto
    deltas = []
    for c in range(3):
        orig_vals   = orig_rgb[:, :, c][context_ring].astype(float)
        limpia_vals = limpia_rgb[:, :, c][context_ring].astype(float)
        # Escala + offset para que en el contexto coincidan
        s_mean, s_std = limpia_vals.mean(), limpia_vals.std() + 1e-6
        r_mean, r_std = orig_vals.mean(),   orig_vals.std()   + 1e-6
        deltas.append((s_mean, s_std, r_mean, r_std))

    print(f"  Contexto: {context_ring.sum()} píxeles de referencia.")
    for i, (sm, ss, rm, rs) in enumerate(deltas):
        canal = ["R", "G", "B"][i]
        print(f"    Canal {canal}: media {sm:.1f}→{rm:.1f}  std {ss:.1f}→{rs:.1f}")

    # Aplica la corrección stats al canal, pero solo dentro de la máscara
    # Fuera de la máscara deja los píxeles originales de limpia intactos
    corrected = limpia_rgb.astype(float).copy()
    for c in range(3):
        sm, ss, rm, rs = deltas[c]
        ch = corrected[:, :, c]
        ch_corr = np.clip((ch - sm) * (rs / ss) + rm, 0, 255)
        # Solo reemplaza dentro de la máscara
        corrected[:, :, c] = np.where(mask_bool, ch_corr, ch)

    return corrected.astype(np.uint8)


def compositing_desde_arrays(orig_rgb, limpia_rgb, mascara_gray,
                              blur_sigma=4, color_match=False,
                              color_match_local=False,
                              method="stats", dilate_px=20):
    a = orig_rgb.astype(float)
    b = limpia_rgb.copy()
    m = mascara_gray.astype(float) / 255.0
    mask_bool = m > 0.5

    if color_match_local:
        # Corrección local: ajusta solo dentro de la máscara usando el borde como referencia
        b = match_color_local(b.astype(np.uint8), orig_rgb.astype(np.uint8), mask_bool).astype(float)

    elif color_match:
        print(f"  [+] Ajustando color (método: {method}, dilate: {dilate_px}px)...")

        context_mask = None
        if dilate_px > 0 and mask_bool.any():
            struct = np.ones((dilate_px * 2 + 1, dilate_px * 2 + 1), dtype=bool)
            mask_dilated = binary_dilation(mask_bool, structure=struct)
            context_mask = mask_dilated & ~mask_bool

        use_mask = context_mask if (context_mask is not None and context_mask.sum() > 100) else None

        if use_mask is not None:
            print(f"  Usando {use_mask.sum()} píxeles de contexto como referencia.")
        else:
            print("  Sin contexto suficiente; usando estadísticas globales.")

        orig_uint8   = orig_rgb.astype(np.uint8)
        limpia_uint8 = b.astype(np.uint8)

        if method == "reinhard":
            b = match_color_reinhard(limpia_uint8, orig_uint8, use_mask).astype(float)
        elif method == "lut":
            b = match_color_lut(limpia_uint8, orig_uint8, use_mask).astype(float)
        else:
            b = match_color_stats(limpia_uint8, orig_uint8, use_mask).astype(float)

    m_smooth = gaussian_filter(m, sigma=blur_sigma)
    m_smooth = np.clip(m_smooth, 0, 1)[:, :, np.newaxis]

    result = (a * (1 - m_smooth) + b * m_smooth).astype(np.uint8)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# SUBCOMANDOS
# ══════════════════════════════════════════════════════════════════════════════

def cmd_align(args):
    """Subcomando: alinear imagen limpia con la cover y guardarla."""
    cover_path = get_valid_path(args.cover)
    limpia_path = get_valid_path(args.limpia)

    temp_clean_path = None
    if args.waifu2x:
        waifu_exe = args.waifu2x_path or find_waifu2x_executable()
        if not waifu_exe:
            print("[-] Error: No se encontró el ejecutable waifu2x-ncnn-vulkan.exe.")
            sys.exit(1)
        temp_clean_path = ejecutar_waifu2x(waifu_exe, limpia_path)
        limpia_path = temp_clean_path

    try:
        print("\n[*] Cargando imágenes...")
        cover  = cv2.imread(cover_path,  cv2.IMREAD_UNCHANGED)
        limpia = cv2.imread(limpia_path, cv2.IMREAD_UNCHANGED)

        print(f"   Cover:  {cover.shape[1]}×{cover.shape[0]}px")
        print(f"   Limpia: {limpia.shape[1]}×{limpia.shape[0]}px")

        cover_bgr  = cover[:, :, :3]  if cover.shape[2]  == 4 else cover
        limpia_bgr = limpia[:, :, :3] if limpia.shape[2] == 4 else limpia

        H = alinear_automatico(cover_bgr, limpia_bgr)
        alineada = aplicar_homografia(cover, limpia, H)

        output = "alineada.jpg"
        cv2.imwrite(output, alineada)
        print(f"\n[+] Guardado en: {output}")
        print("[+] ¡Listo! Imagen alineada correctamente.")
    finally:
        if temp_clean_path and os.path.isfile(temp_clean_path):
            try:
                os.remove(temp_clean_path)
            except Exception:
                pass


def cmd_clean(args):
    """Subcomando: alinear internamente y aplicar máscara para limpiar texto."""
    cover_path = get_valid_path(args.cover)
    limpia_path = get_valid_path(args.limpia)
    
    if not os.path.isfile("mascara.png"):
        print("[-] Error: No se encontró el archivo 'mascara.png' en el directorio.")
        sys.exit(1)

    temp_clean_path = None
    if args.waifu2x:
        waifu_exe = args.waifu2x_path or find_waifu2x_executable()
        if not waifu_exe:
            print("[-] Error: No se encontró el ejecutable waifu2x-ncnn-vulkan.exe.")
            sys.exit(1)
        temp_clean_path = ejecutar_waifu2x(waifu_exe, limpia_path)
        limpia_path = temp_clean_path

    try:
        print("\n[*] Cargando imágenes...")
        cover  = cv2.imread(cover_path,  cv2.IMREAD_UNCHANGED)
        limpia = cv2.imread(limpia_path, cv2.IMREAD_UNCHANGED)

        print(f"   Cover:  {cover.shape[1]}×{cover.shape[0]}px")
        print(f"   Limpia: {limpia.shape[1]}×{limpia.shape[0]}px")

        cover_bgr  = cover[:, :, :3]  if cover.shape[2]  == 4 else cover
        limpia_bgr = limpia[:, :, :3] if limpia.shape[2] == 4 else limpia

        H = alinear_automatico(cover_bgr, limpia_bgr)
        print("\n[*] Aplicando transformación de perspectiva...")
        alineada_cv = aplicar_homografia(cover, limpia, H)
        alineada_bgr = alineada_cv[:, :, :3] if alineada_cv.ndim == 3 and alineada_cv.shape[2] == 4 else alineada_cv

        mascara_pil = Image.open("mascara.png").convert("L")
        cover_pil   = Image.fromarray(cv2.cvtColor(cover_bgr, cv2.COLOR_BGR2RGB))

        if mascara_pil.size != cover_pil.size:
            mascara_pil = mascara_pil.resize(cover_pil.size, Image.LANCZOS)

        alineada_rgb = cv2.cvtColor(alineada_bgr, cv2.COLOR_BGR2RGB)
        alineada_pil = Image.fromarray(alineada_rgb)
        if alineada_pil.size != cover_pil.size:
            alineada_pil = alineada_pil.resize(cover_pil.size, Image.LANCZOS)

        orig_np    = np.array(cover_pil)
        limpia_np  = np.array(alineada_pil)
        mascara_np = np.array(mascara_pil)

        print("\n[+] Aplicando compositing con máscara...")
        result = compositing_desde_arrays(
            orig_np, limpia_np, mascara_np,
            blur_sigma=args.blur,
            color_match=args.color_match,
            color_match_local=args.color_match_local,
            method=args.method,
            dilate_px=args.dilate,
        )

        output = "limpia.jpg"
        Image.fromarray(result).save(output, quality=95)
        print(f"\n[+] Guardado en: {output}")
        print("[+] ¡Listo! Portada limpiada con éxito.")
    finally:
        if temp_clean_path and os.path.isfile(temp_clean_path):
            try:
                os.remove(temp_clean_path)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════════════════
# MAIN — parseo de argumentos
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        prog="cover_editor",
        description="Editor de portadas para novelas ligeras.",
    )
    subparsers = parser.add_subparsers(dest="cmd", required=True)

    # ── ALIGN ────────────────────────────────────────────────────────────────
    p_align = subparsers.add_parser(
        "align",
        help="Alinea la imagen limpia sobre la cover y guarda el resultado (alineada.jpg).",
    )
    p_align.add_argument("cover",  help="Imagen de la cover (con o sin .jpg/.png)")
    p_align.add_argument("limpia", help="Imagen limpia (con o sin .jpg/.png)")
    p_align.add_argument("--waifu2x", action="store_true",
                         help="Ejecuta waifu2x-ncnn-vulkan en la imagen limpia antes del procesamiento.")
    p_align.add_argument("--waifu2x-path", type=str, default=None,
                         help="Ruta manual al ejecutable de waifu2x-ncnn-vulkan.exe.")

    # ── CLEAN ────────────────────────────────────────────────────────────────
    p_clean = subparsers.add_parser(
        "clean",
        help="Alinea y limpia la portada automáticamente usando mascara.png (limpia.jpg).",
    )
    p_clean.add_argument("cover",   help="Imagen de la cover (con o sin .jpg/.png)")
    p_clean.add_argument("limpia",  help="Imagen limpia (con o sin .jpg/.png)")
    p_clean.add_argument("--blur", type=float, default=4,
                         help="Suavidad del borde de fusión en px (default: 4)")
    p_clean.add_argument("--color-match", action="store_true",
                         help="Ajusta el color de la limpia para que coincida con la cover")
    p_clean.add_argument("--color-match-local", action="store_true",
                         help="Igual que --color-match pero aplica la corrección solo dentro "
                              "de la máscara, usando el borde exterior como referencia. "
                              "Ideal cuando la imagen limpia generada por IA tiene colores distintos.")
    p_clean.add_argument("--method", choices=["stats", "reinhard", "lut"], default="stats",
                         help="Método de ajuste de color: stats | reinhard | lut (default: stats)")
    p_clean.add_argument("--dilate", type=int, default=20,
                         help="Píxeles de dilación para la muestra de contexto de color (default: 20)")
    p_clean.add_argument("--waifu2x", action="store_true",
                         help="Ejecuta waifu2x-ncnn-vulkan en la imagen limpia antes del procesamiento.")
    p_clean.add_argument("--waifu2x-path", type=str, default=None,
                         help="Ruta manual al ejecutable de waifu2x-ncnn-vulkan.exe.")

    args = parser.parse_args()

    if args.cmd == "align":
        cmd_align(args)
    elif args.cmd == "clean":
        cmd_clean(args)


if __name__ == "__main__":
    main()
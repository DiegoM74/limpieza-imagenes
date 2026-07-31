import urllib.request
import zipfile
import io
import os
import shutil

URL = "https://github.com/nagadomi/nunif/releases/download/0.0.0/waifu2x_onnx_models_20250502.zip"
TARGET_DIR = os.path.join("public", "models", "waifu2x")

print("==========================================================")
print(" DESCARGADOR OPTIMIZADO DE MODELOS WAIFU2X ONNX (nunif)   ")
print("==========================================================")

# 1. Eliminar carpeta swin_unet no utilizada si existe para liberar ~600MB
swin_dir = os.path.join(TARGET_DIR, "onnx_models", "swin_unet")
if os.path.exists(swin_dir):
    print(f"[*] Eliminando modelos swin_unet no utilizados ({swin_dir})...")
    shutil.rmtree(swin_dir, ignore_errors=True)
    print("[+] Carpeta swin_unet eliminada. ~600 MB liberados.")

print(f"\nDescargando y filtrando modelos esenciales (cunet y upconv_7)...")

req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
try:
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    size_mb = len(data) / (1024 * 1024)
    print(f"[+] Descarga completada: {size_mb:.2f} MB")
    
    z = zipfile.ZipFile(io.BytesIO(data))
    
    # Filtrar solo archivos necesarios (cunet, upconv_7, utils) omitiendo swin_unet
    members_to_extract = []
    for member in z.namelist():
        if "swin_unet" in member:
            continue
        if any(target in member for target in ["cunet", "upconv_7", "utils"]):
            members_to_extract.append(member)
            
    print(f"Extrayendo únicamente {len(members_to_extract)} modelos ONNX requeridos...")
    os.makedirs(TARGET_DIR, exist_ok=True)
    z.extractall(TARGET_DIR, members=members_to_extract)
    
    print("\n[+] ¡Instalación optimizada de Waifu2x completada!")
    print(f"Ubicación: {os.path.abspath(TARGET_DIR)}")
    print("Archivos instalados para el navegador:")
    total_extracted_size = 0
    for root, dirs, files in os.walk(TARGET_DIR):
        for f in files:
            fp = os.path.join(root, f)
            sz = os.path.getsize(fp)
            total_extracted_size += sz
            rel = os.path.relpath(fp, TARGET_DIR)
            print(f" - {rel} ({sz/(1024*1024):.2f} MB)")
            
    print(f"\nTamaño total retenido en disco: {total_extracted_size/(1024*1024):.2f} MB")
            
except Exception as e:
    print(f"[-] Error durante el proceso: {e}")

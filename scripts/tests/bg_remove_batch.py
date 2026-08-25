import sys, os, base64, io
from PIL import Image
from backend.garment_gen import _remove_white_background

def process_img(src, out_dir):
    with open(src, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    b64_clean = _remove_white_background(b64)
    imgdata = base64.b64decode(b64_clean)
    img = Image.open(io.BytesIO(imgdata))
    w, h = img.size
    
    head = img.crop((0, 0, w, int(h * 0.30)))
    torso = img.crop((0, int(h * 0.30), w, int(h * 0.64)))
    legs = img.crop((0, int(h * 0.64), w, h))
    
    head.save(os.path.join(out_dir, "head.webp"), "WEBP", quality=90)
    torso.save(os.path.join(out_dir, "torso.webp"), "WEBP", quality=90)
    legs.save(os.path.join(out_dir, "legs.webp"), "WEBP", quality=90)
    print(f"Processed {src} to {out_dir}")

process_img("/Users/liaozhenting/Desktop/interactive-art/LINE_ALBUM_六六六_260824_2.jpg", "/Users/liaozhenting/Desktop/interactive-art/public/assets/gen/22222222222222222222222222222222")
process_img("/Users/liaozhenting/Desktop/interactive-art/LINE_ALBUM_六六六_260824_1.jpg", "/Users/liaozhenting/Desktop/interactive-art/public/assets/gen/33333333333333333333333333333333")

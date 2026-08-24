import sys, os
from PIL import Image

src = "/Users/liaozhenting/Desktop/interactive-art/LINE_ALBUM_六六六_260824_2.jpg"
out_dir = "/Users/liaozhenting/Desktop/interactive-art/public/assets/gen/test_mock"
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src)
w, h = img.size

# The cuts: head 0-0.3, torso 0.3-0.64, legs 0.64-1.0
head = img.crop((0, 0, w, int(h * 0.30)))
torso = img.crop((0, int(h * 0.30), w, int(h * 0.64)))
legs = img.crop((0, int(h * 0.64), w, h))

head.save(os.path.join(out_dir, "head.webp"), "WEBP", quality=90)
torso.save(os.path.join(out_dir, "torso.webp"), "WEBP", quality=90)
legs.save(os.path.join(out_dir, "legs.webp"), "WEBP", quality=90)
img.save(os.path.join(out_dir, "full.webp"), "WEBP", quality=90)

print("Sliced successfully.")

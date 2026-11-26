"""
Create test images for AI Image Attribution testing.
"""
import struct
from pathlib import Path
from PIL import Image, PngImagePlugin
import piexif

output_dir = Path("test_images")
output_dir.mkdir(exist_ok=True)

# 1. Normal Photo: clean phone photo with standard camera EXIF
clean_photo_path = output_dir / "clean_phone_photo.jpg"
im_clean = Image.new("RGB", (300, 300), color=(128, 140, 150))
zeroth_ifd = {
    piexif.ImageIFD.Make: b"Apple",
    piexif.ImageIFD.Model: b"iPhone 13",
    piexif.ImageIFD.Software: b"16.5.1",
}
exif_dict = {"0th": zeroth_ifd, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
exif_bytes = piexif.dump(exif_dict)
im_clean.save(clean_photo_path, "JPEG", exif=exif_bytes, quality=95)
print(f"Created: {clean_photo_path}")

# 2. Fake test image: PNG text chunk named parameters
png_test_path = output_dir / "fake_stable_diffusion.png"
im_png = Image.new("RGB", (256, 256), color=(200, 100, 50))
png_info = PngImagePlugin.PngInfo()
png_info.add_text("parameters", "Steps: 20, Sampler: Euler, model: stable diffusion")
im_png.save(png_test_path, "PNG", pnginfo=png_info)
print(f"Created: {png_test_path}")

# 3. Test JPEG with XMP containing DigitalSourceType trainedAlgorithmicMedia
xmp_test_path = output_dir / "ai_generated_xmp.jpg"
im_xmp = Image.new("RGB", (256, 256), color=(60, 180, 240))
xmp_payload = b"""<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>
   <xmp:CreatorTool>Adobe Firefly</xmp:CreatorTool>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""

app1_data = b"http://ns.adobe.com/xap/1.0/\x00" + xmp_payload
im_xmp.save(xmp_test_path, "JPEG", quality=95)
with open(xmp_test_path, "rb") as f:
    orig_jpg = f.read()

# Insert APP1 right after SOI (0xFFD8)
soi = orig_jpg[:2]
rest = orig_jpg[2:]
marker = b"\xFF\xE1"
length = len(app1_data) + 2
app1_packet = marker + struct.pack(">H", length) + app1_data
with open(xmp_test_path, "wb") as f:
    f.write(soi + app1_packet + rest)
print(f"Created: {xmp_test_path}")

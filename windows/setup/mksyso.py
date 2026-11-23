"""Writes rsrc_windows_amd64.syso: a COFF object with the app icon, version info and manifest,
which the Go linker puts into the .exe."""
import struct, sys, io
from PIL import Image

src, out, version = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(src).convert('RGBA')
import os
smp = src.replace('.png', '-small.png')
ims = Image.open(smp).convert('RGBA') if os.path.exists(smp) else im
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
icons = []
def dib(img):
    w, h = img.size
    px = img.load()
    hdr = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b_, a = px[x, y]; xor += bytes((b_, g, r, a))
    rowb = ((w + 31) // 32) * 4
    andm = bytes(rowb * h)
    return hdr + bytes(xor) + andm
for s in sizes:
    small = (ims if s <= 32 else im).resize((s, s), Image.LANCZOS)
    if s >= 256:
        b = io.BytesIO(); small.save(b, 'PNG'); icons.append((s, b.getvalue()))
    else:
        icons.append((s, dib(small)))

manifest = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">'
 '<assemblyIdentity version="%s.0" processorArchitecture="amd64" name="InfinityTimetable" type="win32"/>'
 '<description>Infinity Timetable</description>'
 '<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>'
 '<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>'
 '<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware><dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness></windowsSettings></application>'
 '<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/><supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/></application></compatibility>'
 '</assembly>') % version
manifest = manifest.encode('utf-8')

# --- VS_VERSIONINFO ---
def wstr(s): return (s + '\0').encode('utf-16-le')
def pad4(b): return b + b'\0' * ((4 - len(b) % 4) % 4)
def block(key, value=b'', vtype=1, children=b'', vlen=None):
    hdr_key = wstr(key)
    body = struct.pack('<HHH', 0, 0, 0) + hdr_key
    body = pad4(body)
    if value:
        body += value; body = pad4(body)
    body += children
    length = len(body)
    if vlen is None: vlen = (len(value) // 2) if vtype == 1 else len(value)
    return pad4(struct.pack('<HHH', length, vlen, vtype) + body[6:])
v = [int(x) for x in version.split('.')] + [0]
ms, ls = (v[0] << 16) | v[1], (v[2] << 16) | v[3]
ffi = struct.pack('<13I', 0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x40004, 1, 0, 0, 0)
strs = [('CompanyName', 'Infinity Timetable'), ('FileDescription', 'Infinity Timetable'), ('FileVersion', version), ('InternalName', 'InfinityTimetable'),
        ('LegalCopyright', 'Infinity Timetable'), ('OriginalFilename', 'InfinityTimetable.exe'), ('ProductName', 'Infinity Timetable'), ('ProductVersion', version)]
st = b''.join(block(k, wstr(val), 1) for k, val in strs)
stable = block('040904B0', b'', 1, st, 0)
sfi = block('StringFileInfo', b'', 1, stable, 0)
var = block('Translation', struct.pack('<HH', 0x0409, 0x04B0), 0, b'', 4)
vfi = block('VarFileInfo', b'', 1, var, 0)
versioninfo = block('VS_VERSION_INFO', ffi, 0, sfi + vfi, len(ffi))

# --- resources: (type, id, data) ---
res = []
for i, (s, data) in enumerate(icons, 1):
    res.append((3, i, data))
grp = struct.pack('<HHH', 0, 1, len(icons)) + b''.join(struct.pack('<BBBBHHIH', s if s < 256 else 0, s if s < 256 else 0, 0, 0, 1, 32, len(d), i) for i, (s, d) in enumerate(icons, 1))
res.append((14, 1, grp))
res.append((16, 1, versioninfo))
res.append((24, 1, manifest))

types = {}
for t, i, d in res: types.setdefault(t, []).append((i, d))
tkeys = sorted(types)
# layout: root dir, type dirs, name dirs, data entries, data
def dirsize(n): return 16 + 8 * n
root_sz = dirsize(len(tkeys))
type_sz = sum(dirsize(len(types[t])) for t in tkeys)
name_sz = sum(dirsize(1) for t in tkeys for _ in types[t])
n_entries = len(res)
off_type = root_sz
off_name = off_type + type_sz
off_data_entries = off_name + name_sz
off_data = off_data_entries + 16 * n_entries
buf = bytearray()
relocs = []
def dirhdr(n): return struct.pack('<IIHHHH', 0, 0, 0, 0, 0, n)
# root
buf += dirhdr(len(tkeys))
cur_type = off_type
for t in tkeys:
    buf += struct.pack('<II', t, 0x80000000 | cur_type); cur_type += dirsize(len(types[t]))
# type dirs
cur_name = off_name
for t in tkeys:
    buf += dirhdr(len(types[t]))
    for i, d in sorted(types[t]):
        buf += struct.pack('<II', i, 0x80000000 | cur_name); cur_name += dirsize(1)
# name dirs -> language
cur_de = off_data_entries
order = []
for t in tkeys:
    for i, d in sorted(types[t]):
        buf += dirhdr(1) + struct.pack('<II', 0x0409, cur_de); cur_de += 16; order.append(d)
# data entries
data_blob = bytearray(); data_offs = []
for d in order:
    data_offs.append(off_data + len(data_blob)); data_blob += d; data_blob += b'\0' * ((8 - len(data_blob) % 8) % 8)
for k, d in enumerate(order):
    pos = off_data_entries + 16 * k
    relocs.append(pos)
    buf += struct.pack('<IIII', data_offs[k], len(d), 0, 0)
buf += data_blob
assert len(buf) == off_data + len(data_blob)

# --- COFF ---
nsec = 1
hdr_sz = 20 + 40
raw_ptr = hdr_sz
reloc_ptr = raw_ptr + len(buf)
sym_ptr = reloc_ptr + 10 * len(relocs)
coff = struct.pack('<HHIIIHH', 0x8664, nsec, 0, sym_ptr, 1, 0, 0)
sec = struct.pack('<8sIIIIIIHHI', b'.rsrc\0\0\0', 0, 0, len(buf), raw_ptr, reloc_ptr, 0, len(relocs), 0, 0xC0000040)
rel = b''.join(struct.pack('<IIH', r, 0, 3) for r in relocs)  # IMAGE_REL_AMD64_ADDR32NB against symbol 0
sym = struct.pack('<8sIhHBB', b'.rsrc\0\0\0', 0, 1, 0, 3, 0)
strtab = struct.pack('<I', 4)
open(out, 'wb').write(coff + sec + bytes(buf) + rel + sym + strtab)
print('wrote', out, len(coff + sec + buf + rel + sym + strtab), 'bytes,', len(res), 'resources')

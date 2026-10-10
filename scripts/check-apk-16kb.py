#!/usr/bin/env python3
"""Fails if a 64-bit native library in the APK is not ready for 16 KB memory pages.

Google Play requires 16 KB page support for apps targeting Android 15+.
Each arm64-v8a / x86_64 .so must have LOAD segments aligned to >= 16 KB, and
when stored uncompressed it must start on a 16 KB boundary inside the APK.
"""
import struct
import sys
import zipfile

apk = sys.argv[1]
problems = []
checked = 0
with zipfile.ZipFile(apk) as z, open(apk, 'rb') as raw:
    bad_entry = z.testzip()
    if bad_entry:
        sys.exit(f'APK is corrupt at {bad_entry}')
    for info in z.infolist():
        name = info.filename
        if not (name.startswith(('lib/arm64-v8a/', 'lib/x86_64/')) and name.endswith('.so')):
            continue
        checked += 1
        data = z.read(name)
        if data[:4] != b'\x7fELF' or data[4] != 2:
            problems.append(f'{name}: not a 64-bit ELF')
            continue
        phoff = struct.unpack_from('<Q', data, 32)[0]
        phentsize, phnum = struct.unpack_from('<HH', data, 54)
        aligns = []
        for i in range(phnum):
            base = phoff + i * phentsize
            if struct.unpack_from('<I', data, base)[0] == 1:  # PT_LOAD
                aligns.append(struct.unpack_from('<Q', data, base + 48)[0])
        if aligns and min(aligns) < 16384:
            problems.append(f'{name}: LOAD alignment {min(aligns)} (< 16384)')
        if info.compress_type == zipfile.ZIP_STORED:
            raw.seek(info.header_offset)
            header = raw.read(30)
            name_len, extra_len = struct.unpack_from('<HH', header, 26)
            offset = info.header_offset + 30 + name_len + extra_len
            if offset % 16384:
                problems.append(f'{name}: stored at offset {offset}, not 16 KB aligned')

print(f'Checked {checked} 64-bit native libraries.')
if problems:
    print('Not ready for 16 KB pages:')
    print('\n'.join('  ' + p for p in problems))
    sys.exit(1)
print('All 64-bit native libraries support 16 KB pages.')

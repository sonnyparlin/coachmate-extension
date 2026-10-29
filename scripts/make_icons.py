"""Generate the extension icons (a stopwatch) as PNGs using only the standard library."""
import math, struct, zlib, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG = (31, 41, 55); RING = (236, 240, 244); HAND = (255, 90, 90); KNOB = (236, 240, 244)

def blend(dst, src, a):
    return tuple(int(d * (1 - a) + s * a) for d, s in zip(dst, src))

def shade(px, py):
    """Return RGBA at a sample point in unit coords (0..1)."""
    x, y = px - 0.5, py - 0.52
    r = math.hypot(x, y)
    col, alpha = (0, 0, 0), 0.0
    if r <= 0.47:
        col, alpha = BG, 1.0
        if 0.30 <= r <= 0.36: col = RING
        # hand pointing to ~1 o'clock
        ang = math.radians(-60)
        hx, hy = math.cos(ang), math.sin(ang)
        t = x * hx + y * hy; d = abs(-x * hy + y * hx)
        if 0 <= t <= 0.26 and d <= 0.035: col = HAND
        if r <= 0.05: col = KNOB
    # stem / crown on top
    if abs(x) <= 0.06 and -0.57 <= y <= -0.44: col, alpha = RING, 1.0
    if abs(x) <= 0.11 and -0.60 <= y <= -0.54: col, alpha = RING, 1.0
    return col, alpha

def render(size, ss=4):
    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sj in range(ss):
                for si in range(ss):
                    col, a = shade((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size)
                    acc[0] += col[0] * a; acc[1] += col[1] * a; acc[2] += col[2] * a; acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                row += bytes((int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]), int(a * 255)))
            else:
                row += b'\0\0\0\0'
        rows.append(b'\0' + bytes(row))
    return b''.join(rows)

def png(size, data):
    def chunk(tag, body):
        c = tag + body
        return struct.pack('>I', len(body)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(data, 9)) + chunk(b'IEND', b''))

os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    with open(os.path.join(OUT, f'icon{s}.png'), 'wb') as f:
        f.write(png(s, render(s)))
    print('wrote', f'icon{s}.png')

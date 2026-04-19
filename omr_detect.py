#!/usr/bin/env python3
"""
nGenius ACT OMR Detector v3 — Hybrid approach.

Strategy:
1. Use HoughCircles to find all actual circle positions in the scan
2. Use the template grid (bubble-grid-v2.json) to compute an affine transform
   from template coordinates to scan pixel coordinates
3. For each template bubble position, find the nearest detected circle
   (within a tolerance) and use THAT circle's actual center for fill sampling
4. If no circle is found nearby, sample at the transformed template position

This gives us the accuracy of auto-detection with the structural knowledge
of the template — best of both worlds.

Usage:
  python3 omr_detect.py <image_or_pdf_path> [--grid public/bubble-grid-v2.json] [--dpi 150] [--debug path.png]
"""

import sys
import json
import argparse
import subprocess
import tempfile
import os
import math
import numpy as np
import cv2

DEFAULT_DPI   = 150
FILL_THRESHOLD = 0.08   # min dark fraction to count as filled
DARK_THRESH   = 128     # pixel value below this = dark
SAMPLE_R      = 5       # sampling radius in pixels
SNAP_DIST     = 8       # max px distance to snap to a detected circle

# ── Image loading ─────────────────────────────────────────────────────────────

def load_grayscale(path, dpi=DEFAULT_DPI):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.pdf':
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False); tmp.close()
        try:
            subprocess.run(
                ['pdftoppm', '-png', '-r', str(dpi), '-f','1','-l','1', path,
                 tmp.name.replace('.png','')],
                check=True, capture_output=True)
            candidates = [tmp.name.replace('.png','') + s for s in ['-1.png','-01.png','-001.png']]
            png = next((c for c in candidates if os.path.exists(c)), None)
            if not png: raise FileNotFoundError
        except Exception:
            subprocess.run(
                ['magick', '-density', str(dpi), f'{path}[0]', '-quality','95', tmp.name],
                check=True, capture_output=True)
            png = tmp.name
        img = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        for f in [png, tmp.name]:
            try: os.unlink(f)
            except: pass
    else:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f'Cannot load image: {path}')
    return img


# ── Registration mark detection ───────────────────────────────────────────────

def find_reg_marks(img, grid):
    """
    Find actual positions of reg marks in the scan.
    Uses the grid's expected positions + a local search window.
    Returns dict {name: (found_cx, found_cy)} for each mark in grid.reg_marks.
    """
    h, w = img.shape
    rm = grid['reg_marks']
    pdfW, pdfH = grid['page_size']
    mark_size = rm['size']
    scale = w / pdfW

    found = {}
    for name in ['TL', 'TR', 'BL', 'BR']:
        if name not in rm:
            continue
        x0, y0 = rm[name]
        # Expected center in image coords
        cx_exp = (x0 + mark_size / 2) * scale
        cy_exp = (pdfH - y0 - mark_size / 2) * scale
        mark_px = int(mark_size * scale)
        half = mark_px // 2

        # Search window around expected position
        win = int(100 * scale / 2.083)  # ~100px at 150dpi
        best = (0.0, cx_exp, cy_exp)
        for sy in range(max(half, int(cy_exp - win)), min(h - half, int(cy_exp + win)), 2):
            for sx in range(max(half, int(cx_exp - win)), min(w - half, int(cx_exp + win)), 2):
                patch = img[sy-half:sy+half, sx-half:sx+half]
                if patch.size == 0: continue
                dark = float(np.sum(patch < 80)) / patch.size
                if dark > best[0]:
                    best = (dark, sx, sy)
        found[name] = (best[1], best[2])

    return found


# ── Affine transform ──────────────────────────────────────────────────────────

def compute_affine(reg_found, grid):
    """
    Compute least-squares affine transform: PDF coords → image pixel coords.
    reg_found: { 'TL': (ix, iy), 'TR': ..., 'BL': ..., 'BR': ... }
    Returns (xc, yc) coefficient vectors for:
      img_x = xc[0]*src_x + xc[1]*src_y + xc[2]
      img_y = yc[0]*src_x + yc[1]*src_y + yc[2]
    where src = (pdf_x, pdfH - pdf_y) [y-flipped PDF coords]
    """
    rm = grid['reg_marks']
    pdfH = grid['page_size'][1]
    ms = rm['size']
    keys = [k for k in ['TL', 'TR', 'BL', 'BR'] if k in reg_found]

    src = np.array([[rm[k][0]+ms/2, pdfH-rm[k][1]-ms/2, 1] for k in keys], dtype=float)
    dstX = np.array([reg_found[k][0] for k in keys], dtype=float)
    dstY = np.array([reg_found[k][1] for k in keys], dtype=float)

    xc, _, _, _ = np.linalg.lstsq(src, dstX, rcond=None)
    yc, _, _, _ = np.linalg.lstsq(src, dstY, rcond=None)
    return xc, yc


def pdf_to_img(pdf_x, pdf_y, xc, yc, pdfH):
    sx, sy = pdf_x, pdfH - pdf_y
    return xc[0]*sx + xc[1]*sy + xc[2], yc[0]*sx + yc[1]*sy + yc[2]


# ── Bubble detection ──────────────────────────────────────────────────────────

def detect_circles(img):
    """
    Find all circle candidates via HoughCircles.
    Returns list of (cx, cy, r).
    """
    h, w = img.shape
    scale = w / 612.0
    blurred = cv2.GaussianBlur(img, (3, 3), 0)

    r_min = max(5, int(3.5 * scale))
    r_max = min(25, int(6.0 * scale))
    min_dist = max(8, int(4 * scale))

    circles = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1,
        minDist=min_dist, param1=50, param2=25,
        minRadius=r_min, maxRadius=r_max
    )
    if circles is None:
        return []
    return [(int(c[0]), int(c[1]), int(c[2])) for c in np.round(circles[0]).astype(int)]


# ── Fill measurement ──────────────────────────────────────────────────────────

def measure_fill(img, cx, cy, r=SAMPLE_R):
    """Dark pixel fraction inside circle."""
    h, w = img.shape
    x0, x1 = max(0, cx-r), min(w, cx+r+1)
    y0, y1 = max(0, cy-r), min(h, cy+r+1)
    patch = img[y0:y1, x0:x1]
    if patch.size == 0: return 0.0
    ys_g, xs_g = np.ogrid[y0:y1, x0:x1]
    mask = (xs_g - cx)**2 + (ys_g - cy)**2 <= r**2
    pixels = patch[mask]
    return float(np.sum(pixels < DARK_THRESH)) / max(1, len(pixels))


# ── Main OMR detection ────────────────────────────────────────────────────────

def detect_answers(img, grid, snap_dist=SNAP_DIST):
    """
    For each template bubble, snap to nearest detected circle (if within snap_dist),
    then measure fill. Returns { section: [ans, ...] }.
    """
    # Find reg marks and compute transform
    reg_found = find_reg_marks(img, grid)
    xc, yc = compute_affine(reg_found, grid)
    pdfH = grid['page_size'][1]

    # Detect all circles in the scan
    circles = detect_circles(img)
    # Build spatial index: list of (cx, cy, r) for fast nearest-neighbor
    circle_arr = np.array([(c[0], c[1]) for c in circles], dtype=float) if circles else None

    def snap_to_circle(ix, iy):
        """Return (cx, cy) of nearest detected circle within snap_dist, or (ix, iy)."""
        if circle_arr is None or len(circle_arr) == 0:
            return int(ix), int(iy)
        dists = np.sqrt((circle_arr[:,0] - ix)**2 + (circle_arr[:,1] - iy)**2)
        idx = np.argmin(dists)
        if dists[idx] <= snap_dist:
            return int(circles[idx][0]), int(circles[idx][1])
        return int(ix), int(iy)

    answers = {}
    for sec, qmap in grid['sections'].items():
        sec_answers = []
        for qnum in sorted(qmap.keys(), key=int):
            bubbles = qmap[qnum]
            choices = ['A','B','C','D'] if int(qnum) % 2 == 1 else ['F','G','H','J']

            fills = []
            for pdf_x, pdf_y in bubbles:
                # Transform template position to image coords
                ix, iy = pdf_to_img(pdf_x, pdf_y, xc, yc, pdfH)
                # Snap to nearest detected circle
                cx, cy = snap_to_circle(ix, iy)
                # Sample at BOTH template and snapped positions, take max
                # This handles cases where transform is slightly off at page edges
                f_snap = measure_fill(img, cx, cy)
                f_tmpl = measure_fill(img, int(ix), int(iy))
                fills.append(max(f_snap, f_tmpl))

            best = max(fills)
            if best < FILL_THRESHOLD:
                sec_answers.append('?')
            else:
                sec_answers.append(choices[fills.index(best)])

        answers[sec] = sec_answers

    return answers, reg_found, circles


# ── Debug visualization ───────────────────────────────────────────────────────

def draw_debug(img, answers, grid, reg_found, circles, out_path):
    vis = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    pdfH = grid['page_size'][1]
    xc, yc = compute_affine(reg_found, grid)
    snap_dist = SNAP_DIST

    circle_arr = np.array([(c[0], c[1]) for c in circles], dtype=float) if circles else None

    # Draw all detected circles in light gray
    for cx, cy, r in circles:
        cv2.circle(vis, (cx, cy), r, (180, 180, 180), 1)

    # Draw reg marks in red
    for name, (fx, fy) in reg_found.items():
        cv2.circle(vis, (int(fx), int(fy)), 15, (0, 0, 255), 2)
        cv2.putText(vis, name, (int(fx)+10, int(fy)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,255), 1)

    colors = {'english':(0,200,255),'math':(0,255,100),'reading':(255,150,0),'science':(200,0,255)}

    for sec, qmap in grid['sections'].items():
        col = colors.get(sec, (255,255,255))
        sec_answers = answers.get(sec, [])
        for qnum, bubbles in qmap.items():
            choices = ['A','B','C','D'] if int(qnum) % 2 == 1 else ['F','G','H','J']
            detected = sec_answers[int(qnum)-1] if int(qnum)-1 < len(sec_answers) else '?'
            for i, (px, py) in enumerate(bubbles):
                ix, iy = pdf_to_img(px, py, xc, yc, pdfH)
                if circle_arr is not None and len(circle_arr) > 0:
                    dists = np.sqrt((circle_arr[:,0]-ix)**2 + (circle_arr[:,1]-iy)**2)
                    idx = np.argmin(dists)
                    if dists[idx] <= snap_dist:
                        ix, iy = circles[idx][0], circles[idx][1]
                if choices[i] == detected:
                    cv2.circle(vis, (int(ix), int(iy)), SAMPLE_R+2, col, 2)
                    cv2.circle(vis, (int(ix), int(iy)), 2, col, -1)

    cv2.imwrite(out_path, vis)


# ── Main entry point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--grid', default='public/bubble-grid-v2.json')
    parser.add_argument('--dpi', type=int, default=DEFAULT_DPI)
    parser.add_argument('--debug', help='Save debug PNG here')
    args = parser.parse_args()

    try:
        grid = json.load(open(args.grid))
        img  = load_grayscale(args.image, args.dpi)

        answers, reg_found, circles = detect_answers(img, grid)

        if args.debug:
            draw_debug(img, answers, grid, reg_found, circles, args.debug)

        out = {
            'english': answers.get('english', []),
            'math':    answers.get('math',    []),
            'reading': answers.get('reading', []),
            'science': answers.get('science', []),
            '_meta': {
                'circles_detected': len(circles),
                'reg_marks_found':  list(reg_found.keys()),
            }
        }
        print(json.dumps(out))

    except Exception as e:
        import traceback; traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()

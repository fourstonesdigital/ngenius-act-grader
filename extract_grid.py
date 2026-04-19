#!/usr/bin/env python3
"""
Extract bubble grid coordinates from the v2 ACT answer sheet PDF.
Outputs bubble-grid-v2.json with exact PDF point coordinates for all bubbles
and the 4 registration marks + triangle.

Usage: python3 extract_grid.py <path_to_pdf>
"""

import sys
import json
import math
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTPage, LTRect, LTLine, LTCurve, LTAnno, LTChar, LTTextBox, LTFigure
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfinterp import PDFResourceManager, PDFPageInterpreter
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LAParams, LTLayoutContainer

PDF_PATH = sys.argv[1] if len(sys.argv) > 1 else "public/answer-sheet.pdf"

print(f"Analyzing: {PDF_PATH}", file=sys.stderr)

# Collect all vector objects
rects = []   # (x0,y0,x1,y1) for filled rects / squares
curves = []  # list of curve bbox tuples

rsrcmgr = PDFResourceManager()
laparams = LAParams(line_margin=0.5, word_margin=0.1, char_margin=2.0)
device = PDFPageAggregator(rsrcmgr, laparams=laparams)
interpreter = PDFPageInterpreter(rsrcmgr, device)

page_width = None
page_height = None

with open(PDF_PATH, 'rb') as f:
    pages = list(PDFPage.get_pages(f))
    page = pages[0]
    interpreter.process_page(page)
    layout = device.get_result()
    page_width = layout.width
    page_height = layout.height

    print(f"Page size: {page_width:.1f} x {page_height:.1f} pts", file=sys.stderr)

    def visit(obj, depth=0):
        if isinstance(obj, LTRect):
            x0, y0, x1, y1 = obj.x0, obj.y0, obj.x1, obj.y1
            w = abs(x1-x0)
            h = abs(y1-y0)
            rects.append((min(x0,x1), min(y0,y1), max(x0,x1), max(y0,y1), w, h))
        elif isinstance(obj, LTCurve):
            x0, y0, x1, y1 = obj.x0, obj.y0, obj.x1, obj.y1
            w = abs(x1-x0)
            h = abs(y1-y0)
            curves.append((min(x0,x1), min(y0,y1), max(x0,x1), max(y0,y1), w, h))
        if hasattr(obj, '__iter__'):
            for child in obj:
                visit(child, depth+1)

    visit(layout)

print(f"Found {len(rects)} rects, {len(curves)} curves", file=sys.stderr)

# ── Find registration marks (filled black squares ~16pt, near corners) ──────
# Reg marks should be solid/filled squares ~14-20pts, near page corners
# Tolerance for "square": width/height ratio within 0.7-1.3
def is_square(w, h, min_size=8, max_size=30):
    if w < min_size or h < min_size: return False
    if w > max_size or h > max_size: return False
    ratio = w / h if h > 0 else 0
    return 0.6 < ratio < 1.6

corner_margin = 80  # pt from corner to search in

def near_corner(x0, y0, x1, y1, which, margin=corner_margin):
    cx, cy = (x0+x1)/2, (y0+y1)/2
    if which == 'TL': return cx < margin and cy > page_height - margin
    if which == 'TR': return cx > page_width - margin and cy > page_height - margin
    if which == 'BL': return cx < margin and cy < margin
    if which == 'BR': return cx > page_width - margin and cy < margin
    return False

reg_candidates = {k: [] for k in ['TL', 'TR', 'BL', 'BR']}
for (x0,y0,x1,y1,w,h) in rects:
    if is_square(w, h):
        for corner in ['TL','TR','BL','BR']:
            if near_corner(x0,y0,x1,y1, corner):
                reg_candidates[corner].append((x0,y0,x1,y1,w,h))

print(f"\nReg mark candidates:", file=sys.stderr)
reg_marks = {}
for corner, cands in reg_candidates.items():
    if cands:
        # Pick the most square one
        best = sorted(cands, key=lambda r: abs(r[4]/r[5]-1.0))[0]
        x0,y0,x1,y1,w,h = best
        reg_marks[corner] = {'x0': round(x0,1), 'y0': round(y0,1), 'x1': round(x1,1), 'y1': round(y1,1),
                             'cx': round((x0+x1)/2,1), 'cy': round((y0+y1)/2,1),
                             'w': round(w,1), 'h': round(h,1)}
        print(f"  {corner}: ({x0:.1f},{y0:.1f}) - ({x1:.1f},{y1:.1f})  {w:.1f}x{h:.1f}", file=sys.stderr)
    else:
        print(f"  {corner}: NOT FOUND", file=sys.stderr)

# ── Find triangle (orientation marker) near TR ──────────────────────────────
# Triangle = non-square shape near TR, below the TR square
triangle = None
if 'TR' in reg_marks:
    tr = reg_marks['TR']
    # Look for shapes near TR, slightly below it
    tri_candidates = []
    for (x0,y0,x1,y1,w,h) in rects + curves:
        cx, cy = (x0+x1)/2, (y0+y1)/2
        # Near right edge, below TR square
        if cx > page_width - corner_margin and cy < tr['cy'] - 5 and cy > tr['cy'] - 60:
            if w > 5 and h > 5:
                tri_candidates.append((x0,y0,x1,y1,w,h))
    if tri_candidates:
        t = tri_candidates[0]
        x0,y0,x1,y1,w,h = t
        triangle = {'x0': round(x0,1), 'y0': round(y0,1), 'x1': round(x1,1), 'y1': round(y1,1),
                   'cx': round((x0+x1)/2,1), 'cy': round((y0+y1)/2,1)}
        print(f"\nTriangle: ({x0:.1f},{y0:.1f}) - ({x1:.1f},{y1:.1f})", file=sys.stderr)

# ── Find bubble circles ──────────────────────────────────────────────────────
# Bubbles are small circles (ovals): width ≈ height ≈ 7-12 pt
# Found as LTCurve or LTRect objects
bubble_size_min = 5
bubble_size_max = 14

bubble_candidates = []
for (x0,y0,x1,y1,w,h) in curves + rects:
    if bubble_size_min <= w <= bubble_size_max and bubble_size_min <= h <= bubble_size_max:
        ratio = w/h if h > 0 else 0
        if 0.5 < ratio < 2.0:
            cx, cy = (x0+x1)/2, (y0+y1)/2
            bubble_candidates.append({'cx': round(cx,1), 'cy': round(cy,1), 'w': round(w,1), 'h': round(h,1)})

print(f"\nFound {len(bubble_candidates)} bubble candidates", file=sys.stderr)

# Sort and deduplicate (within 2pt = same bubble)
def dedup_bubbles(bubbles, tol=2.0):
    seen = []
    for b in sorted(bubbles, key=lambda x: (round(x['cy']/tol), round(x['cx']/tol))):
        if not any(abs(b['cx']-s['cx']) < tol and abs(b['cy']-s['cy']) < tol for s in seen):
            seen.append(b)
    return seen

bubbles = dedup_bubbles(bubble_candidates)
print(f"After dedup: {len(bubbles)} unique bubble positions", file=sys.stderr)

# Print sample bubbles for debugging
for b in bubbles[:20]:
    print(f"  bubble at ({b['cx']},{b['cy']}) {b['w']}x{b['h']}", file=sys.stderr)

# ── Output JSON ─────────────────────────────────────────────────────────────
output = {
    'page_size': [round(page_width,1), round(page_height,1)],
    'reg_marks': reg_marks,
    'triangle': triangle,
    'bubble_count': len(bubbles),
    'bubbles_raw': bubbles
}

with open('bubble-positions-raw.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nWrote bubble-positions-raw.json ({len(bubbles)} bubbles)", file=sys.stderr)
print(json.dumps({'page_size': output['page_size'], 'reg_marks': reg_marks, 'triangle': triangle, 'bubble_count': len(bubbles)}))

#!/usr/bin/env python3
"""
Build bubble-grid-v2.json from the raw bubble positions.
Maps each bubble to section/question/choice based on x/y position.

ACT answer sheet layout (PDF coordinates, y=0 at bottom):
- English (50 Q): top section, 5 columns of 10
- Math    (45 Q): second section, 5 columns (10,10,10,10,5)  
- Reading (36 Q): third section, 5 columns (8,8,8,6,6)  -- NOTE: actual visual layout
- Science (40 Q): bottom section, 5 columns of 8

From the bubble extraction data, the page y-range is 79-562.
Reg marks at y=48.9 (BL/BR) and y=743.1 (TL/TR).

We need to:
1. Identify the 5 column x-groups  
2. Identify section y-bands
3. Within each section, sort rows top-to-bottom, assign question numbers
"""

import json
from collections import defaultdict

with open('bubble-positions-raw.json') as f:
    raw = json.load(f)

bubbles = raw['bubbles_raw']
reg_marks = raw['reg_marks']
triangle = raw['triangle']
page_size = raw['page_size']

# ── Step 1: Find column x-groups ────────────────────────────────────────────
# Each question has 4 bubbles with spacing ~11.6pt
# Column groups are separated by ~80pt gaps
# From data: x positions cluster around ~80, 188, 300, 407, 510

xs = sorted(set(round(b['cx']) for b in bubbles))
print(f"Unique x positions (rounded): {len(xs)}")

# Find x-groups by clustering
col_groups = []
group = [xs[0]]
for x in xs[1:]:
    if x - group[-1] > 40:  # gap > 40pt = new column group
        col_groups.append(group)
        group = [x]
    else:
        group.append(x)
col_groups.append(group)

print(f"\nColumn groups ({len(col_groups)}):")
for i, g in enumerate(col_groups):
    print(f"  Col {i+1}: x={[round(x,1) for x in g[:4]]} .. ({len(g)} values)")

# Within each column group, the 4 bubbles per question = choice 0,1,2,3
# Sort by x to get A,B,C,D or F,G,H,J order

# ── Step 2: Find section y-bands ────────────────────────────────────────────
# From the raw data the y range is 79-562.
# Sections have title bars between them (gaps in bubble rows).
# Let's find y gaps to identify section boundaries.

ys_all = sorted(set(round(b['cy']) for b in bubbles), reverse=True)

# Find gaps > 20pt between consecutive y rows
gaps = []
for i in range(len(ys_all)-1):
    gap = ys_all[i] - ys_all[i+1]
    if gap > 20:
        gaps.append((ys_all[i], ys_all[i+1], gap))
        print(f"Gap: y={ys_all[i]:.0f} to y={ys_all[i+1]:.0f} = {gap:.0f}pt")

# Based on the gaps, define section y-bands (y_max, y_min):
# English: highest y values (top of page = high y in PDF coords)
# Science: lowest y values (bottom = low y)
# Manually define based on gap data
# The gaps found will tell us the band boundaries

section_bands = []
boundaries = [b[1] for b in gaps]  # lower y of each gap = upper boundary of next section
boundaries = sorted(boundaries, reverse=True)
y_top = max(ys_all) + 20
y_bottom = min(ys_all) - 20

print(f"\nY boundaries: top={y_top:.0f}, bottom={y_bottom:.0f}")
print(f"Section boundaries (y values between sections): {[round(b,0) for b in boundaries]}")

# Define 4 section bands top-to-bottom (highest y to lowest y in PDF)
# Hardcoded boundaries based on exact bubble-count analysis:
# English: y=460-562 (200 bubbles = 50q x 4)
# Math:    y=318-420 (180 bubbles = 45q x 4)
# Reading: y=197-278 (144 bubbles = 36q x 4)
# Science: y=79-159  (160 bubbles = 40q x 4)
section_y_bands = {
    'english': (459, y_top),
    'math':    (317, 421),
    'reading': (196, 279),
    'science': (y_bottom, 160),
}
if True:  # always use hardcoded
    pass  # hardcoded above

print(f"\nSection bands:")
for sec, (ymin, ymax) in section_y_bands.items():
    count = sum(1 for b in bubbles if ymin <= b['cy'] <= ymax)
    print(f"  {sec}: y={ymin:.0f} to {ymax:.0f} => {count} bubbles")

# ── Step 3: For each section, build question→bubble mapping ─────────────────

# ACT alternating: odd questions = A,B,C,D; even = F,G,H,J
# For this sheet - we need to check: Math is FGHJ for all, English/Reading/Science is ABCD
# Actually standard ACT: English/Reading/Science use ABCD; Math uses FGHJA alternating

SECTION_QCOUNTS = {
    'english': 50,
    'math': 45,
    'reading': 36,
    'science': 40,
}

def get_choices(section, qnum):
    if section == 'math':
        return ['F','G','H','J'] if qnum % 2 == 0 else ['A','B','C','D']
    return ['A','B','C','D']

sections_out = {}

for sec, (ymin, ymax) in section_y_bands.items():
    qcount = SECTION_QCOUNTS[sec]
    
    # Get bubbles in this section's y band
    sec_bubbles = [b for b in bubbles if ymin <= b['cy'] <= ymax]
    print(f"\n{sec.upper()}: {len(sec_bubbles)} bubbles for {qcount} questions")
    
    if not sec_bubbles:
        sections_out[sec] = {}
        continue
    
    # Group bubbles by x-column group
    def get_col_idx(bx):
        for i, g in enumerate(col_groups):
            if any(abs(bx - gx) < 8 for gx in g):
                return i
        return -1
    
    def get_choice_idx(bx, col_g):
        # Within a column group, sort x positions to get choice order 0,1,2,3
        dists = [(abs(bx - gx), gi) for gi, gx in enumerate(sorted(col_g))]
        return min(dists, key=lambda d: d[0])[1]
    
    # Group by (col_group, y_row) — snap y within 3pt to handle sub-pixel PDF variance
    # Use round-to-nearest-3 to merge y=374/375, y=277/278 etc. while keeping distinct rows
    def snap_y(y):
        # Round to nearest multiple of 3
        return round(y / 3) * 3
    
    q_candidates = defaultdict(list)
    for b in sec_bubbles:
        col_idx = get_col_idx(b['cx'])
        if col_idx < 0: 
            continue
        y_key = snap_y(b['cy'])
        q_candidates[(col_idx, y_key)].append(b)
    
    # Each (col_idx, y_row) group = one question (4 choices)
    # Sort by: col_idx ascending, y_row descending (top to bottom = high y to low y)
    sorted_qs = sorted(q_candidates.keys(), key=lambda k: (k[0], -k[1]))
    
    print(f"  Found {len(sorted_qs)} question slots")
    
    # Assign question numbers sequentially
    # Within each column, rows go top to bottom
    # Columns go left to right
    section_qmap = {}
    
    for qnum_0, (col_idx, y_row) in enumerate(sorted_qs):
        qnum = qnum_0 + 1
        if qnum > qcount:
            break
        
        group_bubbles = sorted(q_candidates[(col_idx, y_row)], key=lambda b: b['cx'])
        
        if len(group_bubbles) < 4:
            # Try to find bubbles at slightly different y (within 6pt)
            nearby = [b for b in sec_bubbles 
                     if get_col_idx(b['cx']) == col_idx 
                     and abs(b['cy'] - y_row) <= 6]
            group_bubbles = sorted(nearby, key=lambda b: b['cx'])
        
        # Take up to 4 bubbles
        group_bubbles = group_bubbles[:4]
        
        if len(group_bubbles) != 4:
            print(f"  WARNING: Q{qnum} has {len(group_bubbles)} bubbles (expected 4)")
        
        # Each bubble center = [cx, cy]
        centers = [[round(b['cx'], 1), round(b['cy'], 1)] for b in group_bubbles]
        section_qmap[str(qnum)] = centers
    
    sections_out[sec] = section_qmap
    print(f"  Mapped {len(section_qmap)} questions")

# ── Output final grid JSON ───────────────────────────────────────────────────
output = {
    'version': 2,
    'page_size': page_size,
    'reg_marks': {
        'TL': [reg_marks['TL']['x0'], reg_marks['TL']['y0']],
        'TR': [reg_marks['TR']['x0'], reg_marks['TR']['y0']],
        'BL': [reg_marks['BL']['x0'], reg_marks['BL']['y0']],
        'BR': [reg_marks['BR']['x0'], reg_marks['BR']['y0']],
        'size': round(reg_marks['TL']['w'], 1),
    },
    'triangle': [triangle['x0'], triangle['y0']] if triangle else None,
    'bubble_diameter': 10,
    'sections': sections_out
}

with open('public/bubble-grid-v2.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f"\n✓ Wrote public/bubble-grid-v2.json")
print(f"  Sections: { {k: len(v) for k,v in sections_out.items()} }")

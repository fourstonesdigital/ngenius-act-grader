/**
 * nGenius ACT OMR Detector — v2.0
 *
 * Pure pixel-based optical mark recognition.
 * Supports both v1 (3 registration marks) and v2 (4 registration marks) grids.
 *
 * v1 grid: TL, TR, BL corners → exact 3-point affine solve
 * v2 grid: TL, TR, BL, BR corners → least-squares 4-point affine solve
 *
 * For v2 sheets a triangle orientation mark is also checked.
 *
 * How it works:
 *   1. Convert input image/PDF to greyscale PNG
 *   2. Locate registration marks in the image
 *   3. Compute affine transform PDF coords → image pixel coords
 *   4. Sample pixel darkness at each bubble's known grid position
 *   5. Return the darkest bubble per question as the answer
 *
 * Math section uses alternating letter sets: ABCD (odd questions) / FGHJ (even questions).
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
const SAMPLE_R    = 5;    // radius in pixels to sample around bubble center (larger = more forgiving)
const DARK_THRESH = 128;  // pixel value 0-255; below = dark/filled (128 = mid-gray threshold)
const FILL_RATIO  = 0.08; // fraction of sampled pixels that must be dark to count as filled
const SCAN_DPI    = 150;  // DPI for PDF→PNG conversion (150 is optimal for this sheet)

/**
 * Convert input file (PDF or image) to greyscale PNG buffer at SCAN_DPI.
 */
async function toGreyscalePNG(inputPath) {
  const ext = inputPath.toLowerCase().split('.').pop();
  let pngPath = inputPath;

  if (ext === 'pdf') {
    const tmpDir = mkdtempSync(join(tmpdir(), 'omr-'));
    try {
      const outPrefix = join(tmpDir, 'page');
      execSync(`pdftoppm -png -r ${SCAN_DPI} -f 1 -l 1 "${inputPath}" "${outPrefix}"`, { timeout: 15000 });
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.png'));
      if (!files.length) throw new Error('pdftoppm produced no output');
      pngPath = join(tmpDir, files[0]);
    } catch (e) {
      // Fallback to ImageMagick
      pngPath = join(tmpDir, 'page.png');
      execSync(`magick -density ${SCAN_DPI} "${inputPath}[0]" -quality 95 "${pngPath}"`, { timeout: 15000 });
    }
  }

  const { data, info } = await sharp(pngPath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, dpi: SCAN_DPI };
}

/**
 * Sample average pixel darkness in a circle of radius SAMPLE_R around (px, py).
 * Returns fraction of pixels below DARK_THRESH (0 = bright, 1 = all dark).
 */
function sampleDarkness(data, width, height, px, py) {
  let dark = 0, total = 0;
  const r2 = SAMPLE_R * SAMPLE_R;
  for (let dy = -SAMPLE_R; dy <= SAMPLE_R; dy++) {
    for (let dx = -SAMPLE_R; dx <= SAMPLE_R; dx++) {
      if (dx*dx + dy*dy > r2) continue;
      const x = Math.round(px + dx);
      const y = Math.round(py + dy);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      total++;
      if (data[y * width + x] < DARK_THRESH) dark++;
    }
  }
  return total > 0 ? dark / total : 0;
}

/**
 * Find a registration mark near the expected position.
 *
 * x0, y0 is the bottom-left corner of the mark in PDF coords.
 * The center to search for is at x0 + size/2, y0 + size/2.
 *
 * Returns { x, y, confidence } — center in image pixel coords.
 */
function findRegMark(data, width, height, x0, y0, markSizePt, pdfW, pdfH) {
  const scaleX = width / pdfW;
  const scaleY = height / pdfH;

  // Center of mark in PDF coords
  const centerPdfX = x0 + markSizePt / 2;
  const centerPdfY = y0 + markSizePt / 2;

  // Convert to image coords (flip y: PDF y-up → image y-down)
  const px = Math.round(centerPdfX * scaleX);
  const py = Math.round((pdfH - centerPdfY) * scaleY);
  const markPx = Math.round(markSizePt * scaleX);
  const halfMark = Math.round(markPx / 2);

  // Search window: ±80px around expected center (wider to handle scan offsets)
  const WIN = 80;
  let bestDark = 0, bestX = px, bestY = py;

  // Clamp bounds so the sampled patch stays inside the image
  const yStart = Math.max(halfMark, py - WIN);
  const yEnd   = Math.min(height - halfMark - 1, py + WIN);
  const xStart = Math.max(halfMark, px - WIN);
  const xEnd   = Math.min(width  - halfMark - 1, px + WIN);

  for (let sy = yStart; sy <= yEnd; sy += 2) {
    for (let sx = xStart; sx <= xEnd; sx += 2) {
      // Sample a patch the size of the reg mark (centered on sx, sy)
      let dark = 0, total = 0;
      for (let dy = -halfMark; dy < halfMark; dy++) {
        for (let dx = -halfMark; dx < halfMark; dx++) {
          const iy = sy + dy, ix = sx + dx;
          if (iy < 0 || iy >= height || ix < 0 || ix >= width) continue;
          const v = data[iy * width + ix];
          if (v < 80) dark++;
          total++;
        }
      }
      if (total === 0) continue;
      const ratio = dark / total;
      if (ratio > bestDark) {
        bestDark = ratio;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  return { x: bestX, y: bestY, confidence: bestDark };
}

// ── Affine transform helpers ───────────────────────────────────────────────

/**
 * Solve 3x3 linear system Ax = b using Cramer's rule.
 * A is a flat array [a00,a01,a02, a10,a11,a12, a20,a21,a22].
 */
function solve3x3(A, b) {
  const det = (
    A[0]*(A[4]*A[8] - A[5]*A[7]) -
    A[1]*(A[3]*A[8] - A[5]*A[6]) +
    A[2]*(A[3]*A[7] - A[4]*A[6])
  );
  if (Math.abs(det) < 1e-10) return null;
  const inv = [
     (A[4]*A[8]-A[5]*A[7]), -(A[1]*A[8]-A[2]*A[7]),  (A[1]*A[5]-A[2]*A[4]),
    -(A[3]*A[8]-A[5]*A[6]),  (A[0]*A[8]-A[2]*A[6]), -(A[0]*A[5]-A[2]*A[3]),
     (A[3]*A[7]-A[4]*A[6]), -(A[0]*A[7]-A[1]*A[6]),  (A[0]*A[4]-A[1]*A[3])
  ];
  return [
    (inv[0]*b[0] + inv[1]*b[1] + inv[2]*b[2]) / det,
    (inv[3]*b[0] + inv[4]*b[1] + inv[5]*b[2]) / det,
    (inv[6]*b[0] + inv[7]*b[1] + inv[8]*b[2]) / det
  ];
}

/**
 * Compute affine transform via exact 3-point solution (v1 grids).
 * Returns { a,b,c,d,e,f } such that:
 *   img_x = a*src_x + b*src_y + c
 *   img_y = d*src_x + e*src_y + f
 * where src coords have PDF y already flipped (y = pdfH - pdfY).
 */
function computeTransform3(regFound, regExpected, pdfH) {
  const src = regExpected.map(p => ({ x: p[0], y: pdfH - p[1] }));
  const dst = regFound;

  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;

  const M = [s0.x, s0.y, 1, s1.x, s1.y, 1, s2.x, s2.y, 1];

  const xCoeffs = solve3x3(M, [d0.x, d1.x, d2.x]);
  const yCoeffs = solve3x3(M, [d0.y, d1.y, d2.y]);

  if (!xCoeffs || !yCoeffs) {
    console.warn('Degenerate registration marks — using identity-ish fallback');
    const scaleX = (dst[1].x - dst[0].x) / (src[1].x - src[0].x || 1);
    const scaleY = (dst[2].y - dst[0].y) / (src[2].y - src[0].y || 1);
    return { a: scaleX, b: 0, c: dst[0].x - scaleX*src[0].x, d: 0, e: scaleY, f: dst[0].y - scaleY*src[0].y };
  }

  return { a: xCoeffs[0], b: xCoeffs[1], c: xCoeffs[2], d: yCoeffs[0], e: yCoeffs[1], f: yCoeffs[2] };
}

/**
 * Compute affine transform via least-squares 4-point solution (v2 grids).
 *
 * Builds overdetermined system:
 *   [src_x, src_y, 1] * [a,b,c]^T ≈ [dst_x]  for each of 4 points
 *
 * Solves via normal equations: (A^T A) x = A^T b
 */
function computeTransform4(regFound, regExpected, pdfH) {
  // Build A (4×3) with flipped y
  const rows = regExpected.map((p, i) => ({
    sx: p[0], sy: pdfH - p[1], dx: regFound[i].x, dy: regFound[i].y
  }));

  // A^T A (3×3) and A^T b (3×1) — compute for x and y separately
  // ATA[i][j] = sum(rows[r].col[i] * rows[r].col[j])
  // col 0 = sx, col 1 = sy, col 2 = 1

  function buildATA_ATb(valueKey) {
    let ATA = [0,0,0, 0,0,0, 0,0,0];
    let ATb = [0, 0, 0];
    for (const r of rows) {
      const cols = [r.sx, r.sy, 1];
      const val  = r[valueKey];
      for (let i = 0; i < 3; i++) {
        ATb[i] += cols[i] * val;
        for (let j = 0; j < 3; j++) {
          ATA[i*3+j] += cols[i] * cols[j];
        }
      }
    }
    return { ATA, ATb };
  }

  const { ATA: ATAx, ATb: ATbx } = buildATA_ATb('dx');
  const { ATA: ATAy, ATb: ATby } = buildATA_ATb('dy');

  const xCoeffs = solve3x3(ATAx, ATbx);
  const yCoeffs = solve3x3(ATAy, ATby);

  if (!xCoeffs || !yCoeffs) {
    console.warn('Degenerate 4-point system — falling back to 3-point with TL/TR/BL');
    return computeTransform3(
      [regFound[0], regFound[1], regFound[2]],
      [regExpected[0], regExpected[1], regExpected[2]],
      pdfH
    );
  }

  return { a: xCoeffs[0], b: xCoeffs[1], c: xCoeffs[2], d: yCoeffs[0], e: yCoeffs[1], f: yCoeffs[2] };
}

/**
 * Apply affine transform to convert PDF coordinates to image pixel coordinates.
 * Handles y-flip internally (PDF y-up → image y-down).
 */
function pdfToImg(pdfX, pdfY, transform, pdfH) {
  const sx = pdfX;
  const sy = pdfH - pdfY;  // flip y
  const { a, b, c, d, e, f } = transform;
  return {
    x: a * sx + b * sy + c,
    y: d * sx + e * sy + f
  };
}

/**
 * Check triangle orientation mark (v2 only).
 * The triangle mark should appear near grid.triangle [tx, ty] in PDF coords.
 * We verify darkness at that location; if not found, warn but continue.
 */
function checkTriangle(data, width, height, trianglePos, transform, pdfH) {
  const [tx, ty] = trianglePos;
  const { x: ix, y: iy } = pdfToImg(tx, ty, transform, pdfH);
  const darkness = sampleDarkness(data, width, height, ix, iy);
  if (darkness < FILL_RATIO) {
    console.warn(`Triangle orientation mark not detected at (${Math.round(ix)}, ${Math.round(iy)}) — sheet may be upside-down or rotated, but continuing`);
    return false;
  }
  console.log(`Triangle orientation mark confirmed (darkness=${darkness.toFixed(2)})`);
  return true;
}

/**
 * Main OMR function.
 * @param {string} imagePath - Path to image or PDF
 * @param {object} grid - Contents of bubble-grid.json (v1 or v2)
 * @returns {object} answers: { english: ['C','G',...], math: [...], reading: [...], science: [...] }
 */
export async function detectAnswers(imagePath, grid) {
  const { data, width, height } = await toGreyscalePNG(imagePath);
  const [pdfW, pdfH] = grid.page_size;
  const { TL, TR, BL, size: markSize } = grid.reg_marks;
  const gridVersion = grid.version || 1;

  let regFound, regExpected, transform;

  if (gridVersion >= 2) {
    // ── v2: 4-point least-squares affine ──────────────────────────────────
    const { BR } = grid.reg_marks;

    regFound = [
      findRegMark(data, width, height, TL[0], TL[1], markSize, pdfW, pdfH),
      findRegMark(data, width, height, TR[0], TR[1], markSize, pdfW, pdfH),
      findRegMark(data, width, height, BL[0], BL[1], markSize, pdfW, pdfH),
      findRegMark(data, width, height, BR[0], BR[1], markSize, pdfW, pdfH),
    ];

    // Expected: center of each mark in PDF coords
    regExpected = [
      [TL[0] + markSize/2, TL[1] + markSize/2],
      [TR[0] + markSize/2, TR[1] + markSize/2],
      [BL[0] + markSize/2, BL[1] + markSize/2],
      [BR[0] + markSize/2, BR[1] + markSize/2],
    ];

    const avgConf = regFound.reduce((s, r) => s + r.confidence, 0) / 4;
    console.log(
      `v2 Reg marks found:` +
      ` TL(${Math.round(regFound[0].x)},${Math.round(regFound[0].y)})` +
      ` TR(${Math.round(regFound[1].x)},${Math.round(regFound[1].y)})` +
      ` BL(${Math.round(regFound[2].x)},${Math.round(regFound[2].y)})` +
      ` BR(${Math.round(regFound[3].x)},${Math.round(regFound[3].y)})` +
      ` confidence=${avgConf.toFixed(2)}`
    );

    transform = computeTransform4(
      regFound.map(r => ({ x: r.x, y: r.y })),
      regExpected,
      pdfH
    );

    // Check triangle orientation mark if provided
    if (grid.triangle) {
      checkTriangle(data, width, height, grid.triangle, transform, pdfH);
    }

  } else {
    // ── v1: 3-point exact affine ──────────────────────────────────────────
    regFound = [
      findRegMark(data, width, height, TL[0], TL[1], markSize, pdfW, pdfH),
      findRegMark(data, width, height, TR[0], TR[1], markSize, pdfW, pdfH),
      findRegMark(data, width, height, BL[0], BL[1], markSize, pdfW, pdfH),
    ];

    regExpected = [
      [TL[0] + markSize/2, TL[1] + markSize/2],
      [TR[0] + markSize/2, TR[1] + markSize/2],
      [BL[0] + markSize/2, BL[1] + markSize/2],
    ];

    const avgConf = regFound.reduce((s, r) => s + r.confidence, 0) / 3;
    console.log(
      `v1 Reg marks found:` +
      ` TL(${Math.round(regFound[0].x)},${Math.round(regFound[0].y)})` +
      ` TR(${Math.round(regFound[1].x)},${Math.round(regFound[1].y)})` +
      ` BL(${Math.round(regFound[2].x)},${Math.round(regFound[2].y)})` +
      ` confidence=${avgConf.toFixed(2)}`
    );

    transform = computeTransform3(
      regFound.map(r => ({ x: r.x, y: r.y })),
      regExpected,
      pdfH
    );
  }

  // ── Sample bubbles ────────────────────────────────────────────────────────
  const answers = {};

  for (const [section, qmap] of Object.entries(grid.sections)) {
    const sectionAnswers = [];
    const sortedQnums = Object.keys(qmap).map(Number).sort((a,b) => a-b);

    for (const qnum of sortedQnums) {
      const bubbleCenters = qmap[qnum]; // [[cx,cy], ...]

      // ALL ACT sections alternate ABCD (odd questions) / FGHJ (even questions)
      const choices = qnum % 2 === 1 ? ['A','B','C','D'] : ['F','G','H','J'];

      let maxDark = 0, bestChoice = '?';

      for (let i = 0; i < bubbleCenters.length; i++) {
        const [pdfX, pdfY] = bubbleCenters[i];
        const { x: imgX, y: imgY } = pdfToImg(pdfX, pdfY, transform, pdfH);
        const darkness = sampleDarkness(data, width, height, imgX, imgY);

        if (darkness > maxDark) {
          maxDark = darkness;
          bestChoice = choices[i] ?? '?';
        }
      }

      // Only accept if the darkest bubble is actually dark enough
      if (maxDark < FILL_RATIO) bestChoice = '?';

      sectionAnswers.push(bestChoice);
    }

    answers[section] = sectionAnswers;
  }

  return answers;
}

// ── CLI test mode ──────────────────────────────────────────────────────────
if (process.argv[2]) {
  const imagePath = process.argv[2];
  const gridPath  = process.argv[3] || join(__dirname, 'public/bubble-grid-v2.json');
  const grid      = JSON.parse(readFileSync(gridPath, 'utf8'));

  console.log(`Processing: ${imagePath}`);
  console.log(`Grid: ${gridPath} (version ${grid.version || 1})`);

  detectAnswers(imagePath, grid)
    .then(answers => {
      console.log('\nExtracted answers:');
      for (const [sec, ans] of Object.entries(answers)) {
        const unknowns = ans.filter(a => a === '?').length;
        console.log(`  ${sec}: [${ans.join(',')}] (${unknowns} unknown)`);
      }
    })
    .catch(err => console.error('Error:', err.message));
}

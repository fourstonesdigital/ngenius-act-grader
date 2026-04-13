import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

// List available tests
app.get('/api/tests', (req, res) => {
  const testsDir = join(__dirname, 'tests');
  const tests = readdirSync(testsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const data = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
      return { testId: data.testId, testName: data.testName };
    });
  res.json(tests);
});

// Get full test data
app.get('/api/tests/:testId', (req, res) => {
  try {
    const testsDir = join(__dirname, 'tests');
    const files = readdirSync(testsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const data = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
      if (data.testId === req.params.testId) return res.json(data);
    }
    res.status(404).json({ error: 'Test not found' });
  } catch (e) {
    res.status(404).json({ error: 'Test not found' });
  }
});

// Convert image buffer to high-contrast PNG using ImageMagick
function enhanceImage(inputPath, outputPath) {
  execSync(`magick "${inputPath}" -contrast-stretch 5%x5% -sharpen 0x1 "${outputPath}"`);
}

// Convert PDF page 1 to PNG
function pdfToImage(pdfPath, outputPath) {
  // Try pdftoppm first (poppler), fallback to ImageMagick/ghostscript
  try {
    const tmpPrefix = outputPath.replace('.png', '');
    execSync(`pdftoppm -png -r 200 -f 1 -l 1 "${pdfPath}" "${tmpPrefix}"`);
    // pdftoppm names output page-1.png or page-01.png
    const dir = dirname(outputPath);
    const prefix = outputPath.replace('.png','').split('/').pop();
    const files = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.png'));
    if (files.length > 0) {
      execSync(`cp "${join(dir, files[0])}" "${outputPath}"`);
      return;
    }
  } catch(e) { /* fallback */ }
  // Fallback: ImageMagick with ghostscript
  execSync(`magick -density 200 "${pdfPath}[0]" -quality 95 "${outputPath}"`);
}

// Crop and extract a section from the sheet image
// Returns base64 PNG of the cropped+zoomed section
function cropSection(imagePath, section, outputPath) {
  // These coordinates are calibrated for the nGenius Enhanced ACT Answer Sheet
  // at 200dpi (1700x2200 pixels), after contrast enhancement
  // Section headers (dense bands) found at y: English=565, Math=910, Reading=1250, Science=1545
  // Bubble area starts ~50px after header
  const crops = {
    english: { x: 220, y: 610, w: 1260, h: 295 },
    math:    { x: 220, y: 955, w: 1260, h: 290 },
    reading: { x: 220, y: 1290, w: 1260, h: 250 },
    science: { x: 220, y: 1590, w: 1260, h: 330 },
  };
  const c = crops[section];
  if (!c) throw new Error('Unknown section: ' + section);
  // Crop and zoom 2x
  execSync(`magick "${imagePath}" -crop ${c.w}x${c.h}+${c.x}+${c.y} -resize ${c.w*2}x${c.h*2} "${outputPath}"`);
}

// Extract answers for one section using Claude vision
async function extractSection(imgPath, sectionName, totalQuestions) {
  const imgB64 = readFileSync(imgPath).toString('base64');
  
  const prompt = `This image shows the ${sectionName.toUpperCase()} section of an ACT answer sheet with ${totalQuestions} questions arranged in 5 columns.

ACT bubble format:
- ODD-numbered questions (1,3,5,...): choices are A  B  C  D
- EVEN-numbered questions (2,4,6,...): choices are F  G  H  J

Instructions:
1. Go through each question row from Q1 to Q${totalQuestions} in order
2. Identify which bubble is FILLED/DARKENED (solid circle) vs empty (outline circle)
3. Record that letter as the answer

Return ONLY a JSON array of ${totalQuestions} single-letter answers in order from Q1 to Q${totalQuestions}.
Example: ["C","G","A","F","D","F","C","J","B","G",...]
No explanation, just the JSON array.`;

  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } },
      { type: 'text', text: prompt }
    ]}]
  });
  
  const text = resp.content[0].text.trim();
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error(`Could not parse ${sectionName} answers from: ${text.slice(0, 100)}`);
  return JSON.parse(match[0]);
}

// Extract student info from header
async function extractHeader(imgPath) {
  const imgB64 = readFileSync(imgPath).toString('base64');
  const prompt = `Extract student info from this ACT answer sheet header. Return ONLY JSON:
{"studentName":"...","testNumber":"...","tutor":"...","testDate":"...","studentEmail":"...","parentEmail":""}`;
  
  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } },
      { type: 'text', text: prompt }
    ]}]
  });
  try {
    const match = resp.content[0].text.match(/\{[\s\S]*?\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch { return {}; }
}

// Main grade endpoint
app.post('/api/grade', async (req, res) => {
  const { imageBase64, mimeType, testId } = req.body;
  if (!imageBase64 || !testId) return res.status(400).json({ error: 'Missing required fields' });

  let tmpDir = null;
  try {
    // Find test data
    const testsDir = join(__dirname, 'tests');
    const files = readdirSync(testsDir).filter(f => f.endsWith('.json'));
    let testData = null;
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
      if (d.testId === testId) { testData = d; break; }
    }
    if (!testData) return res.status(404).json({ error: 'Test not found' });

    tmpDir = mkdtempSync(join(tmpdir(), 'ngenius-'));
    const rawPath = join(tmpDir, 'input.bin');
    const imagePath = join(tmpDir, 'sheet.png');
    const enhancedPath = join(tmpDir, 'enhanced.png');

    // Write input file
    writeFileSync(rawPath, Buffer.from(imageBase64, 'base64'));

    // Convert PDF to image if needed
    const isPDF = mimeType === 'application/pdf';
    if (isPDF) {
      pdfToImage(rawPath, imagePath);
    } else {
      execSync(`cp "${rawPath}" "${imagePath}"`);
    }

    // Enhance contrast
    enhanceImage(imagePath, enhancedPath);

    // Extract header info
    const headerCropPath = join(tmpDir, 'header.png');
    execSync(`magick "${enhancedPath}" -crop 1700x200+0+0 "${headerCropPath}"`);
    const headerInfo = await extractHeader(headerCropPath);

    // Extract each section separately
    const sections = ['english', 'math', 'reading', 'science'];
    const answers = {};
    for (const sec of sections) {
      const sectionPath = join(tmpDir, `${sec}.png`);
      cropSection(enhancedPath, sec, sectionPath);
      const totalQ = testData.sections[sec].totalQuestions;
      answers[sec] = await extractSection(sectionPath, sec, totalQ);
    }

    res.json({ ...headerInfo, ...answers });

  } catch (err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Failed to process: ' + err.message });
  } finally {
    if (tmpDir) try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

app.listen(port, () => console.log(`nGenius Grader v1.5 running on port ${port}`));

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { detectAnswers } from './omr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

function loadTest(testId) {
  const testsDir = join(__dirname, 'tests');
  for (const f of readdirSync(testsDir).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
    if (d.testId === testId) return d;
  }
  return null;
}

// List tests
app.get('/api/tests', (req, res) => {
  const testsDir = join(__dirname, 'tests');
  const tests = readdirSync(testsDir).filter(f => f.endsWith('.json')).sort()
    .map(f => { const d = JSON.parse(readFileSync(join(testsDir, f), 'utf8')); return { testId: d.testId, testName: d.testName }; });
  res.json(tests);
});

// Get test data
app.get('/api/tests/:testId', (req, res) => {
  const d = loadTest(req.params.testId);
  d ? res.json(d) : res.status(404).json({ error: 'Not found' });
});

// Extract student info from image using Claude
async function extractHeader(imgB64, mimeType) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imgB64 } },
        { type: 'text', text: 'Extract student info from this ACT answer sheet header. Return ONLY JSON: {"studentName":"...","testNumber":"...","tutor":"...","testDate":"...","studentEmail":"...","parentEmail":""}' }
      ]}]
    });
    const match = resp.content[0].text.match(/\{[\s\S]*?\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch { return {}; }
}

// Grade endpoint — uses OMR detector (pixel-based, no AI for answers)
app.post('/api/grade', async (req, res) => {
  const { imageBase64, mimeType, testId } = req.body;
  if (!imageBase64 || !testId) return res.status(400).json({ error: 'Missing fields' });

  const testData = loadTest(testId);
  if (!testData) return res.status(404).json({ error: 'Test not found' });

  const grid = JSON.parse(readFileSync(join(__dirname, 'public/bubble-grid-v2.json'), 'utf8'));

  let tmpDir = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'ngenius-'));
    const isPDF = mimeType === 'application/pdf';
    const ext = isPDF ? 'pdf' : 'png';
    const inputPath = join(tmpDir, `input.${ext}`);
    writeFileSync(inputPath, Buffer.from(imageBase64, 'base64'));

    // Run OMR pixel-based detection
    const answers = await detectAnswers(inputPath, grid);

    // Extract header info with Claude (just name/date/test# — small cheap call)
    const headerInfo = await extractHeader(imageBase64, mimeType);

    res.json({ ...headerInfo, ...answers });

  } catch (err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  } finally {
    if (tmpDir) try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

app.listen(port, () => console.log(`nGenius Grader v2.0 (OMR) running on port ${port}`));

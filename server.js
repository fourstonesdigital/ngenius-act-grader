import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';

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

  let tmpDir = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'ngenius-'));
    const isPDF = mimeType === 'application/pdf';
    const ext = isPDF ? 'pdf' : (mimeType === 'image/jpeg' ? 'jpg' : 'png');
    const inputPath = join(tmpDir, `input.${ext}`);
    writeFileSync(inputPath, Buffer.from(imageBase64, 'base64'));

    // Run Python OMR detector (hybrid HoughCircles + template grid)
    // Use PATH from environment so nix-installed python3 is found correctly
    const gridPath = join(__dirname, 'public/bubble-grid-v2.json');
    const scriptPath = join(__dirname, 'omr_detect.py');
    const pythonPath = process.env.PYTHON_PATH || 'python3';
    const result = spawnSync(pythonPath, [scriptPath, inputPath, '--grid', gridPath], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH + ':/nix/var/nix/profiles/default/bin' },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      throw new Error(`OMR failed: ${stderr.slice(0, 500)}`);
    }

    const omrOut = JSON.parse(result.stdout.toString().trim());
    if (omrOut.error) throw new Error(omrOut.error);

    const answers = {
      english: omrOut.english || [],
      math:    omrOut.math    || [],
      reading: omrOut.reading || [],
      science: omrOut.science || [],
    };

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

app.listen(port, () => {
  console.log(`nGenius Grader v2.1 (Hybrid OMR) running on port ${port}`);
  // Verify Python + OMR deps at startup
  const check = spawnSync('python3', ['-c', 'import cv2, numpy; print("OMR deps OK cv2="+cv2.__version__)'], {
    env: { ...process.env, PATH: process.env.PATH + ':/nix/var/nix/profiles/default/bin' },
  });
  if (check.error) {
    console.error('Python check failed:', check.error.message);
  } else {
    console.log('Python check:', check.stdout?.toString().trim() || check.stderr?.toString().trim());
  }
});

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '10mb' }));
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

// Get full test data (answer key)
app.get('/api/tests/:testId', (req, res) => {
  try {
    // Find by testId field inside json
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

// Extract answers from uploaded bubble sheet image
app.post('/api/grade', async (req, res) => {
  const { imageBase64, mimeType, testId } = req.body;
  if (!imageBase64 || !testId) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const testsDir = join(__dirname, 'tests');
    const files = readdirSync(testsDir).filter(f => f.endsWith('.json'));
    let testData = null;
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
      if (d.testId === testId) { testData = d; break; }
    }
    if (!testData) return res.status(404).json({ error: 'Test not found' });

    const sections = testData.sections;
    const isPDF = mimeType === 'application/pdf';

    // If PDF, convert page 1 to PNG using pdftoppm (poppler) for accurate vision
    let finalBase64 = imageBase64;
    let finalMime = mimeType;
    let tmpDir = null;
    if (isPDF) {
      try {
        tmpDir = mkdtempSync(join(tmpdir(), 'ngenius-'));
        const pdfPath = join(tmpDir, 'sheet.pdf');
        const outPrefix = join(tmpDir, 'page');
        writeFileSync(pdfPath, Buffer.from(imageBase64, 'base64'));
        // Convert first page only at 200dpi to PNG
        execSync(`pdftoppm -png -r 200 -f 1 -l 1 "${pdfPath}" "${outPrefix}"`);
        // pdftoppm outputs page-1.png or page-01.png
        const files = readdirSync(tmpDir).filter(f => f.startsWith('page') && f.endsWith('.png'));
        if (files.length > 0) {
          finalBase64 = readFileSync(join(tmpDir, files[0])).toString('base64');
          finalMime = 'image/png';
          console.log('PDF converted to PNG successfully');
        }
      } catch (e) {
        console.error('pdftoppm conversion failed, falling back to document mode:', e.message);
      } finally {
        if (tmpDir) try { execSync(`rm -rf "${tmpDir}"`); } catch {}
      }
    }

    const prompt = `You are grading an nGenius Prep ACT bubble sheet. Extract the student information and all bubble answers.

IMPORTANT — Answer choice format: This sheet uses the standard ACT alternating format:
- ODD-numbered questions (1, 3, 5, ...): choices are A, B, C, D
- EVEN-numbered questions (2, 4, 6, ...): choices are F, G, H, J

This test has:
- English: ${sections.english.totalQuestions} questions (Q1-Q${sections.english.totalQuestions})
- Math: ${sections.math.totalQuestions} questions (Q1-Q${sections.math.totalQuestions})
- Reading: ${sections.reading.totalQuestions} questions (Q1-Q${sections.reading.totalQuestions})
- Science: ${sections.science.totalQuestions} questions (Q1-Q${sections.science.totalQuestions})

Return ONLY valid JSON with this exact structure:
{
  "studentName": "...",
  "testNumber": "...",
  "tutor": "...",
  "testDate": "...",
  "studentEmail": "...",
  "parentEmail": "...",
  "english": ["A","G","B","F",...],
  "math": ["A","G","B","F",...],
  "reading": ["A","G","B","F",...],
  "science": ["A","G","B","F",...]
}

Each answer array must have exactly the number of answers shown above, in order Q1, Q2, Q3... Use "?" for any bubble you cannot clearly read. Return ONLY the JSON object, no explanation.`;

    // Always send as image (PDF was converted to PNG above)
    const mediaBlock = { type: 'image', source: { type: 'base64', media_type: finalMime, data: finalBase64 } };

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [ mediaBlock, { type: 'text', text: prompt } ]
      }]
    });

    let text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '');
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Failed to process image: ' + err.message });
  }
});

app.listen(port, () => console.log(`nGenius Grader running on port ${port}`));

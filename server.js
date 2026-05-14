import express from 'express';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const POSTMARK_KEY   = process.env.POSTMARK_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

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

// ── Diagnostic ────────────────────────────────────────────
app.get('/api/diag', (req, res) => {
  const r1 = spawnSync('which', ['python3']);
  const r2 = spawnSync('python3', ['--version']);
  const nixSP2 = '/nix/var/nix/profiles/default/lib/python3.12/site-packages';
  const r4 = spawnSync('python3', ['-c', 'import cv2, numpy; print("cv2:", cv2.__version__, "numpy:", numpy.__version__)'], {
    env: { ...process.env, PYTHONPATH: [process.env.PYTHONPATH, nixSP2].filter(Boolean).join(':') },
  });
  const r5 = spawnSync('find', ['/nix', '-name', 'cv2*', '-maxdepth', '8']);
  res.json({
    which_python3: r1.stdout?.toString().trim(),
    python_version: r2.stdout?.toString().trim(),
    cv2_test: r4.stdout?.toString().trim() || r4.stderr?.toString().trim(),
    nix_cv2: r5.stdout?.toString().trim().split('\n').slice(0, 5),
    PATH: process.env.PATH,
  });
});

// ── List tests ────────────────────────────────────────────
app.get('/api/tests', (req, res) => {
  const testsDir = join(__dirname, 'tests');
  const tests = readdirSync(testsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const d = JSON.parse(readFileSync(join(testsDir, f), 'utf8'));
      return { testId: d.testId, testName: d.testName };
    });
  res.json(tests);
});

// ── Get test data ─────────────────────────────────────────
app.get('/api/tests/:testId', (req, res) => {
  const d = loadTest(req.params.testId);
  d ? res.json(d) : res.status(404).json({ error: 'Not found' });
});

// ── Grade (OMR only — no AI) ──────────────────────────────
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

    const gridPath = join(__dirname, 'public/bubble-grid-v2.json');
    const scriptPath = join(__dirname, 'omr_detect.py');
    const pythonPath = process.env.PYTHON_PATH || 'python3';
    const nixSitePackages = '/nix/var/nix/profiles/default/lib/python3.12/site-packages';
    const pythonEnv = {
      ...process.env,
      PYTHONPATH: [process.env.PYTHONPATH, nixSitePackages].filter(Boolean).join(':'),
    };

    const result = spawnSync(pythonPath, [scriptPath, inputPath, '--grid', gridPath], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: pythonEnv,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      throw new Error(`OMR failed: ${stderr.slice(0, 500)}`);
    }

    const omrOut = JSON.parse(result.stdout.toString().trim());
    if (omrOut.error) throw new Error(omrOut.error);

    res.json({
      english: omrOut.english || [],
      math:    omrOut.math    || [],
      reading: omrOut.reading || [],
      science: omrOut.science || [],
    });

  } catch (err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  } finally {
    if (tmpDir) try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

// ── Generate AI email commentary ─────────────────────────
app.post('/api/generate-email', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });
  const { studentName, testName, testDate, composite, stem, sections, tutorNotes } = req.body;
  const sectionLabels = { english: 'English', math: 'Math', reading: 'Reading', science: 'Science' };
  const sectionLines = ['english','math','reading','science']
    .map(s => `  - ${sectionLabels[s]}: ${sections[s]?.scale}/36 (${sections[s]?.raw}/${sections[s]?.total} correct)`)
    .join('\n');

  const prompt = `You are a professional ACT tutor at nGenius Prep writing a personal score commentary for a student and their parents.

Student: ${studentName}
Test: ${testName}
Date: ${testDate || 'recent'}
ACT Composite: ${composite}/36  (English + Math + Reading)
STEM Score: ${stem}/36  (Math + Science)
Section scores:
${sectionLines}

Tutor notes / context:
${tutorNotes || 'No additional notes provided.'}

Write a warm, professional 2-3 paragraph commentary:
- Para 1: Acknowledge the test performance, mention the composite score naturally
- Para 2: Highlight strengths and 1-2 focus areas; weave in tutor notes if provided
- Para 3: Encouragement and concrete next step

Tone: personal, honest, positive but not generic. Write as if you personally tutored this student.
End with: "Your nGenius Prep Tutor Team"
Output ONLY the paragraphs — no greeting, no subject line.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || `Anthropic ${r.status}`); }
    const d = await r.json();
    res.json({ commentary: d.content[0].text.trim() });
  } catch (err) {
    console.error('generate-email error:', err);
    res.status(500).json({ error: 'Failed to generate commentary: ' + err.message });
  }
});

// ── Email results via Postmark ────────────────────────────
app.post('/api/email', async (req, res) => {
  const {
    studentName, testDate, tutorEmail, studentEmail, parentEmail,
    testName, composite, stem, sections, answers,
    imageBase64, imageMimeType, imageFilename,
    aiComment,
  } = req.body;

  const toList = [studentEmail, parentEmail].filter(Boolean);
  const ccList = [tutorEmail, 'support@ngeniusprep.com'].filter(Boolean);

  if (toList.length === 0 && ccList.length === 0) {
    return res.status(400).json({ error: 'No recipient emails provided' });
  }

  // If no To recipients, promote CC to To
  const toAddr = toList.length > 0 ? toList.join(', ') : ccList[0];
  const ccAddr = toList.length > 0 ? ccList.join(', ') : ccList.slice(1).join(', ');

  const formattedDate = testDate
    ? new Date(testDate + 'T12:00:00').toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '';

  const sectionOrder = ['english', 'math', 'reading', 'science'];
  const sectionLabels = { english: 'English', math: 'Math', reading: 'Reading', science: 'Science' };

  // Build per-section answer rows
  function buildAnswerRows(sec) {
    return (answers[sec] || []).map(a => `
      <tr style="border-bottom:1px solid ${a.isCorrect ? '#f3f4f6' : '#fee2e2'};background:${a.isCorrect ? '#fff' : '#fff1f2'};">
        <td style="padding:6px 12px;color:#6b7280;font-size:13px;">${sectionLabels[sec]}</td>
        <td style="padding:6px 12px;font-size:13px;font-weight:600;">Q${a.number}</td>
        <td style="padding:6px 12px;font-size:13px;font-weight:700;color:${a.isCorrect ? '#16a34a' : '#dc2626'};">${a.studentAns}</td>
        <td style="padding:6px 12px;font-size:13px;font-weight:700;color:#1f2937;">${a.correct}</td>
        <td style="padding:6px 12px;font-size:16px;text-align:center;">${a.isCorrect ? '✅' : '❌'}</td>
      </tr>`).join('');
  }

  const allAnswerRows = sectionOrder.map(buildAnswerRows).join('');

  const sectionCardsHtml = sectionOrder.map(sec => {
    const s = sections[sec] || {};
    return `
      <td style="width:25%;text-align:center;padding:16px 6px;border:1px solid #e5e7eb;border-radius:8px;vertical-align:top;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;letter-spacing:1px;margin-bottom:4px;">${sectionLabels[sec]}</div>
        <div style="font-size:38px;font-weight:900;color:#1d4ed8;line-height:1.1;">${s.scale ?? '—'}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${s.raw ?? '?'}/${s.total ?? '?'} correct</div>
      </td>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
<div style="max-width:680px;margin:0 auto;">

  <!-- Header -->
  <div style="background:#4f4f4f;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
    <img src="https://score.ngeniusprep.com/logo-color-blackbg.png" alt="nGenius Prep"
         style="height:60px;width:auto;display:block;margin:0 auto 16px;" />
    <h1 style="color:white;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.3px;">ACT Mock Test Score Report</h1>
  </div>

  <!-- Student Info Bar -->
  <div style="background:#f1f4f6;border-left:4px solid #2F3D4C;padding:14px 28px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:3px 12px 3px 0;font-size:13px;"><strong style="color:#2F3D4C;">Student:</strong> <span style="color:#1a1a1a;">${studentName || 'N/A'}</span></td>
        <td style="padding:3px 12px;font-size:13px;"><strong style="color:#2F3D4C;">Test:</strong> <span style="color:#1a1a1a;">${testName || ''}</span></td>
        <td style="padding:3px 0 3px 12px;font-size:13px;"><strong style="color:#2F3D4C;">Date:</strong> <span style="color:#1a1a1a;">${formattedDate || 'N/A'}</span></td>
      </tr>
    </table>
  </div>

${aiComment ? `
  <!-- Tutor Commentary -->
  <div style="background:#fafafa;border-left:4px solid #D7190B;padding:20px 28px;">
    <p style="font-size:11px;font-weight:700;color:#D7190B;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 12px;">From Your Tutor</p>
    ${aiComment.split('\n\n').filter(p=>p.trim()).map(p=>`<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 10px;">${p.replace(/\n/g,'<br/>')}</p>`).join('')}
  </div>` : ''}

  <!-- Body -->
  <div style="background:white;padding:32px;border-radius:0 0 12px 12px;">

    <!-- ACT Composite -->
    <div style="background:#2F3D4C;border-radius:12px;padding:32px;text-align:center;margin-bottom:16px;">
      <p style="color:#bfdbfe;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 6px;font-weight:600;">ACT Composite Score</p>
      <p style="color:#dbeafe;font-size:11px;margin:0 0 12px;">(English + Math + Reading)</p>
      <p style="color:white;font-size:72px;font-weight:900;margin:0;line-height:1;">${composite}</p>
      <p style="color:#bfdbfe;font-size:13px;margin:10px 0 0;">out of 36</p>
    </div>

    <!-- STEM Score -->
    <div style="background:#fff;border:2px solid #2F3D4C;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
      <p style="color:#4F4F4F;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px;font-weight:600;">STEM Score</p>
      <p style="color:#9ca3af;font-size:11px;margin:0 0 8px;">(Math + Science)</p>
      <p style="color:#2F3D4C;font-size:52px;font-weight:900;margin:0;line-height:1;">${stem}</p>
      <p style="color:#9ca3af;font-size:13px;margin:8px 0 0;">out of 36</p>
    </div>

    <!-- Section Scores -->
    <table style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:32px;">
      <tr>${sectionCardsHtml}</tr>
    </table>

    <!-- Answer Review -->
    <h2 style="font-size:16px;font-weight:700;color:#111827;margin:0 0 12px;border-top:1px solid #e5e7eb;padding-top:24px;">Answer Review</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;border-bottom:1px solid #e5e7eb;">Section</th>
          <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;border-bottom:1px solid #e5e7eb;">Q#</th>
          <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;border-bottom:1px solid #e5e7eb;">Student</th>
          <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;border-bottom:1px solid #e5e7eb;">Correct</th>
          <th style="text-align:center;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;border-bottom:1px solid #e5e7eb;"></th>
        </tr>
      </thead>
      <tbody>${allAnswerRows}</tbody>
    </table>

    <p style="margin:32px 0 0;font-size:12px;color:#9ca3af;text-align:center;">
      Generated by nGenius Prep &mdash; ACT Mock Test Grader
    </p>
  </div>
</div>
</body>
</html>`;

  try {
    const pmRes = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_KEY,
      },
      body: JSON.stringify({
        From: 'support@ngeniusprep.com',
        To: toAddr,
        ...(ccAddr ? { Cc: ccAddr } : {}),
        Subject: `ACT Mock Test Score Report — ${studentName || 'Student'} — ${testName || ''}`,
        Attachments: imageBase64 ? [{
          Name: imageFilename || `answer-sheet.${(imageMimeType || 'image/jpeg').split('/')[1]}`,
          Content: imageBase64,
          ContentType: imageMimeType || 'image/jpeg',
        }] : undefined,
        HtmlBody: html,
        MessageStream: 'outbound',
      }),
    });

    const pmData = await pmRes.json();
    if (!pmRes.ok) throw new Error(pmData.Message || `Postmark error ${pmRes.status}`);
    res.json({ ok: true, message: 'Email sent successfully' });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`nGenius Grader v2.2 running on port ${port}`);
  const nixSP = '/nix/var/nix/profiles/default/lib/python3.12/site-packages';
  const check = spawnSync('python3', ['-c', 'import cv2, numpy; print("OMR deps OK cv2="+cv2.__version__)'], {
    env: { ...process.env, PYTHONPATH: [process.env.PYTHONPATH, nixSP].filter(Boolean).join(':') },
  });
  console.log('Python check:', check.stdout?.toString().trim() || check.stderr?.toString().trim() || check.error?.message);
});

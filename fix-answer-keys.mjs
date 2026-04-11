/**
 * Fix answer keys: convert F/G/H/J/K (standard ACT even-question notation)
 * to A/B/C/D/E (what the nGenius bubble sheet actually uses for all questions).
 *
 * Standard ACT notation:
 *   Odd questions:  A B C D (E for Math)
 *   Even questions: F G H J (K for Math)
 *
 * nGenius bubble sheet uses A B C D for all non-Math questions,
 * and A B C D E for all Math questions.
 *
 * Mapping: F→A, G→B, H→C, J→D, K→E
 *
 * Also fix English field question positions for Test 1 based on actual printed
 * dash marks on the answer sheet (verified from student scan):
 *   25MC1 English field Qs: 5, 7, 11, 16, 21, 22, 27, 36, 40, 48
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, 'tests');

const fghjMap = { F: 'A', G: 'B', H: 'C', J: 'D', K: 'E' };

function convertAnswer(ans) {
  return fghjMap[ans] ?? ans;
}

// Correct field question positions for each test, derived from:
// - PDF gray cell data (Math/Reading/Science)
// - Printed dash marks on nGenius answer sheet (English Test 1 verified)
// These override whatever was previously in the JSON.
const fieldQuestions = {
  '25MC1': {
    english:  [5, 7, 11, 16, 21, 22, 27, 36, 40, 48],  // from printed sheet
    math:     [7, 16, 29, 40],                            // from PDF gray cells
    reading:  [2, 6, 7, 8, 28, 29, 30, 31, 32],          // from PDF gray cells
    science:  [29, 35, 36, 37, 38, 39],                   // from PDF gray cells
  },
  '25MC2': {
    english:  [41, 42, 43, 44, 45, 46, 47, 48, 49, 50],  // PDF (last 10)
    math:     [6, 18, 29, 30],
    reading:  [19, 20, 21, 22, 23, 24, 34, 35, 36],
    science:  [11, 12, 13, 14, 15, 16],
  },
  '25MC3': {
    english:  [31, 32, 43, 44, 45, 46, 47, 48, 49, 50],
    math:     [6, 7, 16, 28],
    reading:  [13, 14, 15, 16, 17, 18, 34, 35, 36],
    science:  [16, 17, 18, 19, 20, 21],
  },
  '25MC4': {
    english:  [15, 16, 17, 44, 45, 46, 47, 48, 49, 50],
    math:     [8, 16, 21, 28],
    reading:  [19, 20, 21, 22, 23, 24, 25, 26, 36],
    science:  [23, 24, 25, 26, 28, 40],
  },
};

const files = readdirSync(testsDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const path = join(testsDir, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const fq = fieldQuestions[data.testId];

  if (!fq) {
    console.log(`No field question config for ${data.testId}, skipping`);
    continue;
  }

  for (const [section, questions] of Object.entries(data.sections)) {
    const fieldSet = new Set(fq[section] ?? []);
    for (const q of questions.questions) {
      // Convert answer
      q.answer = convertAnswer(q.answer);
      // Fix field flag
      q.field = fieldSet.has(q.number);
      if (q.field) q.category = 'FIELD';
    }
  }

  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`✅ Fixed ${data.testId}`);
}

console.log('\nDone. Verify counts:');
for (const file of files) {
  const data = JSON.parse(readFileSync(join(testsDir, file), 'utf8'));
  for (const [section, s] of Object.entries(data.sections)) {
    const fieldCount = s.questions.filter(q => q.field).length;
    const scoredCount = s.questions.length - fieldCount;
    const status = scoredCount === s.scoredCount ? '✓' : `⚠️  expected ${s.scoredCount}`;
    console.log(`  ${data.testId} ${section}: ${scoredCount} scored, ${fieldCount} field ${status}`);
  }
}

#!/usr/bin/env node
// Generates the 4 ACT test JSON files with full answer keys + category assignments
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, 'tests'), { recursive: true });

// ── Category maps (position = 1-indexed position within scored questions) ──
function buildCatMap(assignments) {
  const map = {};
  for (const [cat, positions] of Object.entries(assignments)) {
    for (const p of positions) map[p] = cat;
  }
  return map;
}

const ENG_CAT = buildCatMap({
  CSE: [1,3,5,7,8,9,10,11,13,14,17,18,22,23,24,25,28,29,31,32],
  POW: [2,4,6,12,15,16,19,20,26,27],
  KLA: [21,30,33,34,35,36,37,38,39,40]
});
const MATH_CAT = buildCatMap({
  'PHM-A': [1,5,9,13,17,20,24,29],
  'PHM-F': [6,10,14,18,22,26,33],
  'PHM-G': [7,11,15,19,23,27,36],
  'PHM-N': [2,12,30,38],
  'PHM-S': [4,16,21,28,37],
  IES:     [3,8,25,31,34,39],
  MDL:     [32,35,40,41]
});
const READ_CAT = buildCatMap({
  KID: [1,2,4,6,8,10,12,14,17,19,22,24],
  CS:  [3,5,7,9,11,13,16,18,21],
  IKI: [15,20,23,25,26,27]
});
const SCI_CAT = buildCatMap({
  IOD: [1,2,4,5,7,8,9,10,11,12,13,15,17,20,21,24],
  SIN: [3,6,14,16,18,22,25,27,29],
  EMI: [19,23,26,28,30,31,32,33,34]
});

function buildQuestions(answers, fieldNums, catMap) {
  const fieldSet = new Set(fieldNums);
  let scoredPos = 0;
  return answers.map((answer, idx) => {
    const number = idx + 1;
    const field = fieldSet.has(number);
    let category;
    if (field) {
      category = 'FIELD';
    } else {
      scoredPos++;
      category = catMap[scoredPos] || 'UNKNOWN';
    }
    return { number, answer, field, category };
  });
}

function parseScaleStr(str) {
  // "36:[40], 35:[38,39], ..."  →  { "36": [40], "35": [38,39], ... }
  const result = {};
  const regex = /(\d+):\[([^\]]*)\]/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    result[m[1]] = m[2].split(',').map(Number);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// RAW ANSWER ARRAYS  (index 0 = Q1)
// ═══════════════════════════════════════════════════════════════════
const T1 = {
  eng: 'C,G,A,F,A,F,D,J,B,G,B,J,C,H,D,J,D,H,A,J,A,F,C,H,D,G,D,F,A,G,C,F,A,H,A,G,B,H,D,J,A,G,D,H,D,F,B,F,D,H'.split(','),
  engField: [41,42,43,44,45,46,47,48,49,50],
  math: 'D,J,B,F,C,J,B,H,D,H,B,J,A,J,A,G,A,J,B,H,G,G,C,G,A,G,B,F,C,J,C,J,C,G,C,J,C,J,C,J,D,F,C,J,A'.split(','),
  mathField: [7,16,29,40],
  read: 'D,H,A,J,C,G,A,F,A,J,B,H,B,J,C,J,C,F,B,H,D,H,A,H,D,F,B,J,D,F,A,G,C,J,B,H'.split(','),
  readField: [2,6,7,8,28,29,30,31,32],
  sci:  'A,F,D,H,D,F,C,J,C,F,C,G,C,H,B,H,B,F,D,F,C,J,C,J,B,J,D,G,D,J,C,J,D,F,B,F,B,G,C,J'.split(','),
  sciField: [29,35,36,37,38,39],
  scaleEng:  '36:[40], 35:[38,39], 33:[37], 31:[36], 29:[35], 28:[34], 27:[33], 26:[32], 25:[31], 24:[30], 23:[29], 22:[27,28], 21:[26], 20:[24,25], 19:[23], 18:[22], 17:[21], 16:[20], 15:[18,19], 14:[17], 13:[15,16], 12:[14], 11:[12,13], 10:[9,10,11], 9:[8], 8:[7], 7:[5,6], 6:[4], 5:[3], 3:[2], 2:[1], 1:[0]',
  scaleMath: '36:[40,41], 35:[39], 34:[37,38], 33:[36], 32:[35], 31:[34], 30:[33], 29:[31,32], 28:[30], 27:[28,29], 26:[27], 25:[26], 24:[25], 23:[24], 22:[23], 21:[22], 20:[21], 19:[19,20], 18:[18], 17:[15,16,17], 16:[13,14], 15:[10,11,12], 14:[8,9], 13:[6,7], 12:[5], 11:[4], 9:[3], 7:[2], 5:[1], 1:[0]',
  scaleRead: '36:[27], 35:[26], 32:[24], 30:[23], 28:[22], 26:[21], 25:[20], 24:[19], 23:[18], 22:[17], 21:[16], 20:[15], 18:[14], 17:[13], 16:[12], 15:[11], 14:[10], 13:[9], 12:[7,8], 11:[6], 10:[5], 9:[4], 7:[3], 5:[2], 3:[1], 1:[0]',
  scaleSci:  '36:[34], 35:[33], 34:[32], 33:[31], 32:[30], 31:[29], 30:[28], 29:[27], 28:[26], 27:[25], 26:[24], 25:[22,23], 24:[21], 23:[19,20], 22:[18], 21:[17], 20:[16], 19:[15], 18:[13,14], 17:[12], 16:[11], 15:[10], 14:[9], 12:[7,8], 11:[6], 10:[5], 9:[4], 7:[3], 6:[2], 3:[1], 1:[0]'
};

const T2 = {
  eng: 'D,H,A,F,A,H,A,G,C,G,B,H,A,H,A,G,D,J,D,F,D,G,B,F,B,H,A,G,B,G,C,H,D,G,D,F,B,J,B,J,A,H,A,J,D,J,A,G,B,H'.split(','),
  engField: [41,42,43,44,45,46,47,48,49,50],
  math: 'A,G,C,G,D,G,B,H,D,F,D,J,C,F,B,H,C,J,C,H,B,J,A,F,C,G,B,H,B,H,D,H,B,G,C,F,C,G,C,J,C,H,D,F,C'.split(','),
  mathField: [6,18,29,30],
  read: 'A,G,D,G,A,H,A,J,C,J,C,F,B,J,A,H,B,H,D,J,B,G,C,F,C,J,B,G,A,H,B,H,D,F,A,H'.split(','),
  readField: [19,20,21,22,23,24,34,35,36],
  sci:  'B,H,C,G,A,G,D,H,B,F,A,H,A,F,B,G,D,H,B,G,D,F,B,G,C,F,D,G,B,H,A,F,B,F,A,J,C,F,C,J'.split(','),
  sciField: [11,12,13,14,15,16],
  scaleEng:  '36:[40], 35:[38,39], 34:[37], 32:[36], 30:[35], 29:[34], 27:[33], 26:[32], 25:[31], 24:[29,30], 23:[28], 22:[26,27], 21:[25], 20:[23,24], 19:[22], 18:[21], 17:[20], 16:[19], 15:[17,18], 14:[16], 13:[15], 12:[13,14], 11:[11,12], 10:[8,9,10], 9:[7], 8:[6], 7:[5], 6:[4], 5:[3], 4:[2], 2:[1], 1:[0]',
  scaleMath: '36:[40,41], 35:[39], 34:[38], 33:[37], 32:[36], 31:[35], 30:[34], 29:[33], 28:[32], 27:[30,31], 26:[29], 25:[27,28], 24:[26], 23:[25], 22:[24], 21:[22,23], 20:[21], 19:[20], 18:[18,19], 17:[15,16,17], 16:[12,13,14], 15:[10,11], 14:[7,8,9], 13:[6], 12:[5], 11:[4], 10:[3], 8:[2], 5:[1], 1:[0]',
  scaleRead: '36:[27], 35:[26], 34:[25], 32:[24], 30:[23], 28:[22], 26:[21], 25:[20], 24:[19], 23:[18], 21:[17], 20:[16], 19:[15], 18:[14], 17:[13], 15:[12], 14:[11], 13:[9,10], 12:[8], 11:[7], 10:[6], 9:[5], 8:[4], 6:[3], 4:[2], 3:[1], 1:[0]',
  scaleSci:  '36:[34], 35:[33], 34:[32], 33:[31], 31:[30], 30:[29], 29:[28], 28:[27], 27:[26], 26:[24,25], 25:[23], 24:[20,21,22], 23:[18,19], 22:[17], 21:[16], 20:[15], 19:[14], 18:[13], 17:[12], 16:[11], 15:[10], 13:[9], 12:[8], 11:[7], 10:[5,6], 8:[4], 7:[3], 5:[2], 3:[1], 1:[0]'
};

const T3 = {
  eng: 'D,F,A,H,D,J,A,G,C,F,D,H,B,J,B,J,A,F,A,F,A,H,D,H,A,G,C,G,C,J,A,G,C,J,B,J,A,F,B,F,A,F,C,J,D,J,B,J,D,F'.split(','),
  engField: [31,32,43,44,45,46,47,48,49,50],
  math: 'C,G,D,H,D,G,D,H,C,G,D,G,B,F,B,J,B,H,B,H,A,H,D,H,B,H,C,J,A,G,C,H,D,F,B,F,A,G,A,F,D,H,B,F,A'.split(','),
  mathField: [6,7,16,28],
  read: 'C,F,B,H,A,G,B,J,B,G,A,G,B,H,B,J,A,F,B,G,D,G,D,H,C,F,B,F,C,G,A,F,C,G,D,J'.split(','),
  readField: [13,14,15,16,17,18,34,35,36],
  sci:  'B,G,A,J,D,G,D,F,B,F,A,F,C,G,C,A,A,F,D,G,C,G,A,F,D,H,D,J,B,H,B,F,C,J,C,H,B,H,D,H'.split(','),
  sciField: [16,17,18,19,20,21],
  scaleEng:  '36:[40], 35:[38,39], 34:[36,37], 32:[35], 30:[34], 29:[33], 28:[32], 27:[31], 26:[30], 25:[29], 24:[27,28], 23:[26], 22:[24,25], 21:[22,23], 20:[21], 19:[20], 18:[19], 17:[18], 16:[17], 15:[15,16], 14:[14], 13:[13], 12:[12], 11:[11], 10:[8,9,10], 9:[7], 8:[6], 7:[5], 6:[4], 5:[3], 4:[2], 2:[1], 1:[0]',
  scaleMath: '36:[40,41], 35:[38,39], 34:[36,37], 33:[35], 31:[34], 30:[33], 29:[32], 28:[31], 27:[30], 26:[28,29], 25:[27], 24:[26], 22:[25], 21:[24], 20:[23], 19:[22], 18:[20,21], 17:[17,18,19], 16:[15,16], 15:[12,13,14], 14:[8,9,10,11], 13:[6,7], 12:[5], 11:[4], 9:[3], 7:[2], 4:[1], 1:[0]',
  scaleRead: '36:[27], 35:[26], 33:[25], 31:[24], 29:[23], 28:[22], 27:[21], 25:[20], 24:[18,19], 23:[17], 22:[16], 21:[15], 19:[14], 18:[13], 17:[12], 15:[11], 14:[10], 13:[9], 11:[7,8], 10:[6], 9:[5], 7:[4], 6:[3], 4:[2], 2:[1], 1:[0]',
  scaleSci:  '36:[34], 35:[33], 34:[32], 33:[31], 31:[30], 30:[29], 29:[28], 28:[27], 27:[26], 26:[25], 25:[23,24], 24:[21,22], 23:[20], 22:[18,19], 21:[17], 20:[16], 19:[15], 18:[14], 17:[13], 16:[11,12], 15:[10], 13:[9], 12:[8], 11:[6,7], 10:[5], 9:[4], 7:[3], 5:[2], 3:[1], 1:[0]'
};

const T4 = {
  eng: 'C,H,A,F,D,J,C,F,D,G,C,F,A,J,B,H,D,H,A,G,A,J,C,J,A,G,D,J,C,F,A,F,B,F,C,F,A,F,B,J,D,G,D,J,C,J,C,J,D,J'.split(','),
  engField: [15,16,17,44,45,46,47,48,49,50],
  math: 'D,H,B,J,A,F,C,H,B,J,C,H,B,F,C,G,B,F,A,H,D,F,D,G,D,G,C,G,A,J,C,G,A,G,C,H,D,J,D,H,C,H,A,J,D'.split(','),
  mathField: [8,16,21,28],
  read: 'D,J,C,H,B,F,A,J,A,G,A,G,A,F,C,J,D,F,C,G,B,H,D,G,A,G,A,G,A,H,B,H,A,F,C,J'.split(','),
  readField: [19,20,21,22,23,24,25,26,36],
  sci:  'A,J,D,J,B,G,B,H,D,H,B,G,B,G,A,H,A,F,D,H,B,J,B,J,C,G,A,J,D,H,D,G,A,F,A,H,A,G,D,G'.split(','),
  sciField: [23,24,25,26,28,40],
  scaleEng:  '36:[40], 35:[38,39], 34:[37], 33:[36], 31:[35], 29:[34], 28:[33], 26:[32], 25:[31], 24:[30], 23:[28,29], 22:[27], 21:[26], 20:[24,25], 19:[23], 18:[22], 17:[21], 16:[20], 15:[18,19], 14:[16,17], 13:[15], 12:[14], 11:[12,13], 10:[9,10,11], 9:[7,8], 8:[6], 7:[5], 6:[4], 5:[3], 3:[2], 2:[1], 1:[0]',
  scaleMath: '36:[40,41], 35:[38,39], 34:[36,37], 33:[35], 32:[34], 31:[33], 30:[32], 29:[31], 28:[29,30], 27:[28], 26:[27], 25:[25,26], 24:[24], 23:[23], 22:[22], 21:[21], 20:[20], 19:[19], 18:[17,18], 17:[15,16], 16:[13,14], 15:[11,12], 14:[7,8,9,10], 13:[6], 12:[5], 11:[4], 9:[3], 7:[2], 5:[1], 1:[0]',
  scaleRead: '36:[27], 35:[26], 33:[25], 31:[24], 30:[23], 28:[22], 27:[21], 26:[20], 25:[19], 24:[18], 23:[17], 22:[16], 21:[15], 20:[14], 18:[13], 17:[12], 15:[11], 14:[10], 13:[9], 11:[7,8], 10:[6], 9:[5], 7:[4], 6:[3], 4:[2], 2:[1], 1:[0]',
  scaleSci:  '36:[34], 35:[33], 34:[32], 32:[31], 31:[30], 29:[29], 28:[28], 27:[27], 26:[26], 25:[24,25], 24:[22,23], 23:[20,21], 22:[19], 21:[18], 20:[17], 19:[15,16], 18:[14], 17:[13], 16:[11,12], 15:[10], 14:[9], 13:[8], 12:[7], 11:[6], 10:[5], 9:[4], 7:[3], 6:[2], 4:[1], 1:[0]'
};

// ── Build and write each test ──
const tests = [
  { testId: '25MC1', testName: 'Practice Test 1 (2025 Format)', data: T1, fn: '25MC1.json' },
  { testId: '25MC2', testName: 'Practice Test 2 (2025 Format)', data: T2, fn: '25MC2.json' },
  { testId: '25MC3', testName: 'Practice Test 3 (2025 Format)', data: T3, fn: '25MC3.json' },
  { testId: '25MC4', testName: 'Practice Test 4 (2025 Format)', data: T4, fn: '25MC4.json' },
];

for (const test of tests) {
  const d = test.data;
  const out = {
    testId: test.testId,
    testName: test.testName,
    sections: {
      english: {
        totalQuestions: d.eng.length,
        scoredCount: d.eng.length - d.engField.length,
        questions: buildQuestions(d.eng, d.engField, ENG_CAT)
      },
      math: {
        totalQuestions: d.math.length,
        scoredCount: d.math.length - d.mathField.length,
        questions: buildQuestions(d.math, d.mathField, MATH_CAT)
      },
      reading: {
        totalQuestions: d.read.length,
        scoredCount: d.read.length - d.readField.length,
        questions: buildQuestions(d.read, d.readField, READ_CAT)
      },
      science: {
        totalQuestions: d.sci.length,
        scoredCount: d.sci.length - d.sciField.length,
        questions: buildQuestions(d.sci, d.sciField, SCI_CAT)
      }
    },
    scaleScores: {
      english: parseScaleStr(d.scaleEng),
      math:    parseScaleStr(d.scaleMath),
      reading: parseScaleStr(d.scaleRead),
      science: parseScaleStr(d.scaleSci)
    }
  };

  const filepath = join(__dirname, 'tests', test.fn);
  writeFileSync(filepath, JSON.stringify(out, null, 2));
  console.log(`✓ Wrote ${test.fn}  (eng:${out.sections.english.scoredCount} math:${out.sections.math.scoredCount} read:${out.sections.reading.scoredCount} sci:${out.sections.science.scoredCount})`);
}
console.log('Done!');

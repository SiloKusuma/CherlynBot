#!/usr/bin/env node

// Simple syntax checker untuk index.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
const content = fs.readFileSync(filePath, 'utf-8');

let braceCount = 0;
let bracketCount = 0;
let parenCount = 0;
let lineNum = 1;
let errors = [];

for (let i = 0; i < content.length; i++) {
  const char = content[i];
  
  if (char === '{') braceCount++;
  if (char === '}') braceCount--;
  if (char === '[') bracketCount++;
  if (char === ']') bracketCount--;
  if (char === '(') parenCount++;
  if (char === ')') parenCount--;
  
  if (char === '\n') lineNum++;
  
  if (braceCount < 0) {
    errors.push(`Line ${lineNum}: Brace } tidak seimbang`);
    break;
  }
  if (bracketCount < 0) {
    errors.push(`Line ${lineNum}: Bracket ] tidak seimbang`);
    break;
  }
  if (parenCount < 0) {
    errors.push(`Line ${lineNum}: Parenthesis ) tidak seimbang`);
    break;
  }
}

if (braceCount !== 0) {
  errors.push(`Brace tidak seimbang. Sisa: ${braceCount}`);
}
if (bracketCount !== 0) {
  errors.push(`Bracket tidak seimbang. Sisa: ${bracketCount}`);
}
if (parenCount !== 0) {
  errors.push(`Parenthesis tidak seimbang. Sisa: ${parenCount}`);
}

if (errors.length === 0) {
  console.log('✅ Syntax check passed! File index.js tidak ada error bracket/braces');
} else {
  console.log('❌ Ada error:');
  errors.forEach(e => console.log('  ' + e));
  process.exit(1);
}

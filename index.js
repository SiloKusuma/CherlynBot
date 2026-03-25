const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const axios = require('axios');
const config = require('./config');
const pino = require('pino');
const db = require('./db');

const logger = pino({ level: 'error' });
let socket;
const MAX_RETRIES = 3;

// Initialize database (will be awaited in connectToWhatsApp)
let dbInitialized = false;

const axiosInstance = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// Fungsi untuk call Gemini API
async function callGeminiAI(prompt) {
  try {
    if (!config.geminiApiKey || config.geminiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      return '❌ API Key Gemini belum dikonfigurasi. Silakan update di config.js';
    }

    const response = await axiosInstance.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${config.geminiApiKey}`,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      const text = response.data.candidates[0].content.parts[0].text;
      return text;
    }
    return '❌ Tidak ada response dari AI';
  } catch (e) {
    console.error('Gemini API error:', e.message);
    return '❌ Error: ' + e.message.slice(0, 100);
  }
}

// Fungsi untuk check dan limit AI chat
function checkAIChatLimit(userId) {
  return db.checkAIChatLimit(userId);
}

// Fungsi untuk AI chat count
function incrementAIChatCount(userId) {
  return db.incrementAIChatCount(userId);
}

// Fungsi untuk generate Room ID
function generateRoomId() {
  return 'ROOM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Fungsi untuk game battle
function setupBattle(groupId, creatorId, language) {
  return db.setupBattle(groupId, creatorId, language);
}

// Fungsi untuk submit code battle
function submitBattleCode(roomId, playerId, playerName, code) {
  const battle = db.getBattleStatus(roomId);
  
  if (!battle) {
    return { success: false, message: '❌ Room tidak ditemukan! Room ID tidak valid.' };
  }

  // Validasi syntax based on language
  const isValid = validateCodeSyntax(code, battle.language);
  
  if (!isValid.valid) {
    return { success: false, message: '❌ [' + playerName + '] Syntax error: ' + isValid.error };
  }

  // Submit code to database
  db.submitBattleCode(roomId, playerId, playerName, code);
  
  // Get updated battle
  const updatedBattle = db.getBattleStatus(roomId);
  
  return { success: true, battle: updatedBattle, playerName: playerName };
} 

// Fungsi untuk validate code syntax
function validateCodeSyntax(code, language) {
  try {
    const trimmedCode = code.trim();
    
    if (!trimmedCode) {
      return { valid: false, error: 'Kode kosong!' };
    }

    if (language === 'python') {
      if (trimmedCode.length < 2) {
        return { valid: false, error: 'Kode terlalu pendek!' };
      }

      let brackets = 0, parens = 0, braces = 0;
      for (let char of trimmedCode) {
        if (char === '(') parens++;
        if (char === ')') parens--;
        if (char === '[') brackets++;
        if (char === ']') brackets--;
        if (char === '{') braces++;
        if (char === '}') braces--;
      }

      if (parens !== 0) return { valid: false, error: 'Parenthesis () tidak seimbang!' };
      if (brackets !== 0) return { valid: false, error: 'Bracket [] tidak seimbang!' };
      if (braces !== 0) return { valid: false, error: 'Brace {} tidak seimbang!' };

      return { valid: true };
    } else if (language === 'javascript') {
      if (trimmedCode.length < 2) {
        return { valid: false, error: 'Kode terlalu pendek!' };
      }

      let brackets = 0, parens = 0, braces = 0;
      let inString = false, stringChar = '';

      for (let i = 0; i < trimmedCode.length; i++) {
        const char = trimmedCode[i];
        const prevChar = i > 0 ? trimmedCode[i-1] : '';

        if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
          continue;
        }

        if (inString) continue;

        if (char === '(') parens++;
        if (char === ')') parens--;
        if (char === '[') brackets++;
        if (char === ']') brackets--;
        if (char === '{') braces++;
        if (char === '}') braces--;
      }

      if (parens !== 0) return { valid: false, error: 'Parenthesis () tidak seimbang!' };
      if (brackets !== 0) return { valid: false, error: 'Bracket [] tidak seimbang!' };
      if (braces !== 0) return { valid: false, error: 'Brace {} tidak seimbang!' };
      if (inString) return { valid: false, error: 'String tidak ditutup!' };

      return { valid: true };
    }

    return { valid: false, error: 'Language tidak didukung' };
  } catch (e) {
    return { valid: false, error: 'Error: ' + e.message };
  }
}

// Fungsi untuk get battle status
function getBattleStatus(roomId) {
  return db.getBattleStatus(roomId);
}

// Fungsi untuk get battle by group
function getBattleByGroup(groupId) {
  return db.getBattleByGroup(groupId);
}

// Fungsi format score board
function formatScoreboard(battle) {
  let scoreboard = '📊 *LEADERBOARD:*\n';
  let playerList = Object.entries(battle.players);
  
  if (playerList.length === 0) {
    scoreboard += 'Belum ada player';
  } else {
    // Sort by score descending
    playerList.sort((a, b) => b[1].score - a[1].score);
    playerList.forEach(([playerId, player], index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
      scoreboard += `${medal} ${index + 1}. ${player.name}: ${player.score} poin\n`;
    });
  }
  
  return scoreboard;
}

// ═══════════════════════════════════════════════════════════
// UTILITY CALCULATOR FUNCTIONS
// ═══════════════════════════════════════════════════════════

// Fungsi untuk show utility menu
function getUtilityMenu() {
  return `⫷ *UTILITY MENU* ⫸

🔢 *OPERASI DASAR:*
.add - Pertambahan
.sub - Pengurangan
.mul - Perkalian
.div - Pembagian
.mod - Modulo
.pow - Pangkat/Eksponen

📐 *OPERASI MATH:*
.sqrt - Akar kuadrat
.cbrt - Akar kubik
.abs  - Nilai mutlak
.round - Pembulatan

🏗️ *LUAS & KELILING:*
.luaspersegi 
.kelilispersegi 
.luaspersegipanjang 
.kelilispersegipanjang
.luassegitiga
.luastrapesium
.luaslingkaran
.kelilinglingkaran

3️⃣ *VOLUME & LUAS BANGUN RUANG:*
.volumekubus
.luaspermukaan
.volumebalok
.volumerasipanjang
.volumebola 
.luasbolasipanjang
.volumesilinder
.luassilinder

📊 *STATISTIK:*
.rata2 - Rata-rata
.median - Median
.modus - Modus 

🔀 *KONVERSI:*
.kmtom - KM ke Meter
.mtocm - Meter ke CM
.lbtokg - Pound ke KG
.kgtokg - KG ke Pound
.ctof - Celsius ke Fahrenheit
.ftoc - Fahrenheit ke Celsius

💰 *PERSENTASE & DISKON:*
.persen - Hitung persentase dari angka
.diskon - Hitung harga setelah diskon
.pajak - Hitung harga + pajak

🎲 *KOMBINASI & PERMUTASI:*
.faktorial - Faktorial
.kombinasi - Kombinasi C(n,r)
.permutasi - Permutasi P(n,r)

Contoh penggunaan:
.add 10 5
.luaspersegipanjang 20 15
.sqrt 144
.rata2 10 20 30 40 50`;
}

// Operasi Dasar
function calculate(a, b, operation) {
  a = parseFloat(a);
  b = parseFloat(b);
  
  if (isNaN(a) || isNaN(b)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  let result;
  switch(operation) {
    case 'add':
      result = a + b;
      break;
    case 'sub':
      result = a - b;
      break;
    case 'mul':
      result = a * b;
      break;
    case 'div':
      if (b === 0) return { success: false, error: 'Tidak bisa dibagi 0!' };
      result = a / b;
      break;
    case 'mod':
      if (b === 0) return { success: false, error: 'Tidak bisa modulo 0!' };
      result = a % b;
      break;
    case 'pow':
      result = Math.pow(a, b);
      break;
    default:
      return { success: false, error: 'Operasi tidak dikenal' };
  }
  
  return { success: true, result: result };
}

// Operasi Math
function mathOperation(num, operation) {
  num = parseFloat(num);
  if (isNaN(num)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  let result;
  switch(operation) {
    case 'sqrt':
      if (num < 0) return { success: false, error: 'Tidak bisa akar dari angka negatif!' };
      result = Math.sqrt(num);
      break;
    case 'cbrt':
      result = Math.cbrt(num);
      break;
    case 'abs':
      result = Math.abs(num);
      break;
    default:
      return { success: false, error: 'Operasi tidak dikenal' };
  }
  
  return { success: true, result: result };
}

// Pembulatan
function roundNumber(num, decimal) {
  num = parseFloat(num);
  decimal = parseInt(decimal) || 0;
  
  if (isNaN(num)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  const result = Math.round(num * Math.pow(10, decimal)) / Math.pow(10, decimal);
  return { success: true, result: result };
}

// Luas & Keliling
function calculateArea(shape, ...args) {
  const nums = args.map(n => parseFloat(n)).filter(n => !isNaN(n));
  
  if (nums.some(n => n < 0)) {
    return { success: false, error: 'Ukuran tidak boleh negatif!' };
  }
  
  let result;
  switch(shape) {
    case 'persegi':
      if (nums.length < 1) return { success: false, error: 'Masukkan sisi!' };
      result = nums[0] * nums[0];
      break;
    case 'keliling_persegi':
      if (nums.length < 1) return { success: false, error: 'Masukkan sisi!' };
      result = 4 * nums[0];
      break;
    case 'persegi_panjang':
      if (nums.length < 2) return { success: false, error: 'Masukkan panjang dan lebar!' };
      result = nums[0] * nums[1];
      break;
    case 'keliling_persegi_panjang':
      if (nums.length < 2) return { success: false, error: 'Masukkan panjang dan lebar!' };
      result = 2 * (nums[0] + nums[1]);
      break;
    case 'segitiga':
      if (nums.length < 2) return { success: false, error: 'Masukkan alas dan tinggi!' };
      result = (nums[0] * nums[1]) / 2;
      break;
    case 'trapesium':
      if (nums.length < 3) return { success: false, error: 'Masukkan sisi1, sisi2, dan tinggi!' };
      result = ((nums[0] + nums[1]) * nums[2]) / 2;
      break;
    case 'lingkaran':
      if (nums.length < 1) return { success: false, error: 'Masukkan radius!' };
      result = Math.PI * nums[0] * nums[0];
      break;
    case 'keliling_lingkaran':
      if (nums.length < 1) return { success: false, error: 'Masukkan radius!' };
      result = 2 * Math.PI * nums[0];
      break;
    default:
      return { success: false, error: 'Shape tidak dikenal' };
  }
  
  return { success: true, result: result };
}

// Volume & Luas Bangun Ruang
function calculateVolume(shape, ...args) {
  const nums = args.map(n => parseFloat(n)).filter(n => !isNaN(n));
  
  if (nums.some(n => n < 0)) {
    return { success: false, error: 'Ukuran tidak boleh negatif!' };
  }
  
  let result;
  switch(shape) {
    case 'kubus':
      if (nums.length < 1) return { success: false, error: 'Masukkan sisi!' };
      result = nums[0] * nums[0] * nums[0];
      break;
    case 'luas_kubus':
      if (nums.length < 1) return { success: false, error: 'Masukkan sisi!' };
      result = 6 * nums[0] * nums[0];
      break;
    case 'balok':
      if (nums.length < 3) return { success: false, error: 'Masukkan panjang, lebar, dan tinggi!' };
      result = nums[0] * nums[1] * nums[2];
      break;
    case 'luas_balok':
      if (nums.length < 3) return { success: false, error: 'Masukkan panjang, lebar, dan tinggi!' };
      result = 2 * (nums[0]*nums[1] + nums[1]*nums[2] + nums[0]*nums[2]);
      break;
    case 'bola':
      if (nums.length < 1) return { success: false, error: 'Masukkan radius!' };
      result = (4/3) * Math.PI * nums[0] * nums[0] * nums[0];
      break;
    case 'luas_bola':
      if (nums.length < 1) return { success: false, error: 'Masukkan radius!' };
      result = 4 * Math.PI * nums[0] * nums[0];
      break;
    case 'silinder':
      if (nums.length < 2) return { success: false, error: 'Masukkan radius dan tinggi!' };
      result = Math.PI * nums[0] * nums[0] * nums[1];
      break;
    case 'luas_silinder':
      if (nums.length < 2) return { success: false, error: 'Masukkan radius dan tinggi!' };
      result = 2 * Math.PI * nums[0] * (nums[0] + nums[1]);
      break;
    default:
      return { success: false, error: 'Shape tidak dikenal' };
  }
  
  return { success: true, result: result };
}

// Statistik
function calculateStatistics(operation, numbers) {
  const nums = numbers.map(n => parseFloat(n)).filter(n => !isNaN(n));
  
  if (nums.length === 0) {
    return { success: false, error: 'Tidak ada angka yang valid!' };
  }
  
  let result;
  switch(operation) {
    case 'rata2':
      result = nums.reduce((a, b) => a + b, 0) / nums.length;
      break;
    case 'median':
      const sorted = nums.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      break;
    case 'modus':
      const freq = {};
      nums.forEach(n => freq[n] = (freq[n] || 0) + 1);
      let maxFreq = 0, mode = null;
      for (let num in freq) {
        if (freq[num] > maxFreq) {
          maxFreq = freq[num];
          mode = num;
        }
      }
      result = mode ? `${mode} (muncul ${maxFreq}x)` : 'Tidak ada modus';
      break;
    default:
      return { success: false, error: 'Operasi tidak dikenal' };
  }
  
  return { success: true, result: result };
}

// Konversi
function convertUnit(value, fromUnit, toUnit) {
  value = parseFloat(value);
  
  if (isNaN(value)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  let result;
  
  // KM ke Meter
  if (fromUnit === 'km' && toUnit === 'm') {
    result = value * 1000;
  } 
  // Meter ke CM
  else if (fromUnit === 'm' && toUnit === 'cm') {
    result = value * 100;
  }
  // KG ke Pound
  else if (fromUnit === 'kg' && toUnit === 'lb') {
    result = value * 2.20462;
  }
  // Pound ke KG
  else if (fromUnit === 'lb' && toUnit === 'kg') {
    result = value / 2.20462;
  }
  // Celsius ke Fahrenheit
  else if (fromUnit === 'c' && toUnit === 'f') {
    result = (value * 9/5) + 32;
  }
  // Fahrenheit ke Celsius
  else if (fromUnit === 'f' && toUnit === 'c') {
    result = (value - 32) * 5/9;
  }
  else {
    return { success: false, error: 'Konversi tidak didukung!' };
  }
  
  return { success: true, result: result };
}

// Persentase & Diskon
function calculatePercent(value, percent) {
  value = parseFloat(value);
  percent = parseFloat(percent);
  
  if (isNaN(value) || isNaN(percent)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  const result = (value * percent) / 100;
  return { success: true, result: result };
}

function calculateDiscount(price, discount) {
  price = parseFloat(price);
  discount = parseFloat(discount);
  
  if (isNaN(price) || isNaN(discount)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  const discountAmount = (price * discount) / 100;
  const finalPrice = price - discountAmount;
  
  return { 
    success: true, 
    result: `Harga awal: ${price}\nDiskon: ${discountAmount} (${discount}%)\nHarga akhir: ${finalPrice}`
  };
}

function calculateTax(price, tax) {
  price = parseFloat(price);
  tax = parseFloat(tax);
  
  if (isNaN(price) || isNaN(tax)) {
    return { success: false, error: 'Input harus berupa angka!' };
  }
  
  const taxAmount = (price * tax) / 100;
  const finalPrice = price + taxAmount;
  
  return { 
    success: true, 
    result: `Harga awal: ${price}\nPajak: ${taxAmount} (${tax}%)\nHarga akhir: ${finalPrice}`
  };
}

// Faktorial
function factorial(n) {
  n = parseInt(n);
  
  if (isNaN(n) || n < 0) {
    return { success: false, error: 'Input harus angka positif!' };
  }
  
  if (n > 20) {
    return { success: false, error: 'Angka terlalu besar! (max 20)' };
  }
  
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  
  return { success: true, result: result };
}

// Kombinasi
function combination(n, r) {
  n = parseInt(n);
  r = parseInt(r);
  
  if (isNaN(n) || isNaN(r) || n < 0 || r < 0 || r > n) {
    return { success: false, error: 'Input tidak valid! (n >= r >= 0)' };
  }
  
  let nFact = 1, rFact = 1, nMinusRFact = 1;
  
  for (let i = 2; i <= n; i++) nFact *= i;
  for (let i = 2; i <= r; i++) rFact *= i;
  for (let i = 2; i <= (n - r); i++) nMinusRFact *= i;
  
  const result = nFact / (rFact * nMinusRFact);
  
  return { success: true, result: result };
}

// Permutasi
function permutation(n, r) {
  n = parseInt(n);
  r = parseInt(r);
  
  if (isNaN(n) || isNaN(r) || n < 0 || r < 0 || r > n) {
    return { success: false, error: 'Input tidak valid! (n >= r >= 0)' };
  }
  
  let nFact = 1, nMinusRFact = 1;
  
  for (let i = 2; i <= n; i++) nFact *= i;
  for (let i = 2; i <= (n - r); i++) nMinusRFact *= i;
  
  const result = nFact / nMinusRFact;
  
  return { success: true, result: result };
}

// Fitur Khodam Checker
const khodamList = [
  'Ijat',
  'PolisiTidur',
  'Pocong',
  'Katak',
  'MonyetNolep',
  'AnjingSunda',
  'KadalPemarah',
  'BelutJawa',
  'Gajah',
  'JarumPentul',
  'Dimsum',
  'Siomay',
  'SatePadang',
  'SateMadura',
  'SapiPerah',
  'Cilok',
  'Cilor',
  'UlarTerbang',
  'IkanLompat',
  'IkanGembul'
];

function getRandomKhodam() {
  return khodamList[Math.floor(Math.random() * khodamList.length)];
}

// Fitur Pengingat Agama
const religionReminders = {
  'islam': {
    name: '☪️ ISLAM',
    prayers: [
      { name: 'Subuh', time: '04:30' },
      { name: 'Dzuhur', time: '12:00' },
      { name: 'Ashar', time: '15:30' },
      { name: 'Maghrib', time: '18:00' },
      { name: 'Isya', time: '19:30' }
    ],
    holidays: [
      { date: '01-01', name: 'Tahun Baru Islam' },
      { date: '03-12', name: 'Maulid Nabi Muhammad' },
      { date: '04-09', name: 'Isra\' & Mi\'raj' },
      { date: '05-15', name: 'Lebaran (Eid al-Fitr)' },
      { date: '07-16', name: 'Wukuf di Arafah' },
      { date: '07-17', name: 'Idul Adha' }
    ]
  },
  'kristen': {
    name: '✝️ KRISTEN',
    prayers: [
      { name: 'Pagi', time: '06:00' },
      { name: 'Siang', time: '12:00' },
      { name: 'Sore', time: '18:00' }
    ],
    holidays: [
      { date: '12-25', name: 'Natal Tuhan' },
      { date: '02-14', name: 'Hari Valentine' },
      { date: '04-01', name: 'Paskah' },
      { date: '03-30', name: 'Jumat Agung' },
      { date: '05-19', name: 'Kenaikan Yesus' },
      { date: '12-31', name: 'Tahun Baru' }
    ]
  },
  'katolik': {
    name: '✝️ KATOLIK',
    prayers: [
      { name: 'Fajar', time: '06:00' },
      { name: 'Siang', time: '12:00' },
      { name: 'Sore', time: '18:00' },
      { name: 'Rosario', time: '20:00' }
    ],
    holidays: [
      { date: '12-25', name: 'Natal Kristus' },
      { date: '12-08', name: 'Bunda Maria' },
      { date: '01-01', name: 'Tahun Baru' },
      { date: '03-19', name: 'Santo Yusuf' },
      { date: '04-02', name: 'Paskah Suci' },
      { date: '05-01', name: 'Hari Buruh' }
    ]
  },
  'buddha': {
    name: '☸️ BUDDHA',
    prayers: [
      { name: 'Meditasi Pagi', time: '05:30' },
      { name: 'Meditasi Siang', time: '12:00' },
      { name: 'Meditasi Malam', time: '19:00' }
    ],
    holidays: [
      { date: '05-08', name: 'Hari Lahir Buddha' },
      { date: '07-28', name: 'Hari Waisak' },
      { date: '10-31', name: 'Hari Bodhi' },
      { date: '01-01', name: 'Tahun Baru Buddha' },
      { date: '02-15', name: 'Nirvana Buddha' },
      { date: '12-08', name: 'Pencerahan Buddha' }
    ]
  },
  'hindu': {
    name: '🕉️ HINDU',
    prayers: [
      { name: 'Puja Pagi', time: '06:00' },
      { name: 'Puja Siang', time: '12:00' },
      { name: 'Puja Malam', time: '18:00' }
    ],
    holidays: [
      { date: '03-21', name: 'Nyepi - Tahun Baru' },
      { date: '10-24', name: 'Diwali - Hari Cahaya' },
      { date: '02-19', name: 'Thaipusam' },
      { date: '03-08', name: 'Holi - Festival Warna' },
      { date: '09-16', name: 'Lahir Krishna' },
      { date: '10-02', name: 'Ratu Lakshmi Puja' }
    ]
  },
  'konghucu': {
    name: '☯️ KONGHUCU',
    prayers: [
      { name: 'Latihan Pagi', time: '06:00' },
      { name: 'Meditasi Siang', time: '12:00' },
      { name: 'Refleksi Malam', time: '19:00' }
    ],
    holidays: [
      { date: '02-10', name: 'Tahun Baru Imlek' },
      { date: '04-05', name: 'Menghormati Leluhur' },
      { date: '08-15', name: 'Mid-Autumn Festival' },
      { date: '09-09', name: 'Festival Ganda 9' },
      { date: '06-01', name: 'Lahir Konfusius' },
      { date: '10-10', name: 'Hari Pengajar' }
    ]
  }
};

// Fitur Quote Inspiratif
const quoteList = [
  'The only way to do great work is to love what you do. - Steve Jobs',
  'Innovation distinguishes between a leader and a follower. - Steve Jobs',
  'Life is what happens when you\'re busy making other plans. - John Lennon',
  'The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt',
  'It is during our darkest moments that we must focus to see the light. - Aristotle',
  'The only impossible journey is the one you never begin. - Tony Robbins',
  'Success is not final, failure is not fatal. - Winston Churchill',
  'Believe you can and you\'re halfway there. - Theodore Roosevelt',
  'The best time to plant a tree was 20 years ago. The second best time is now. - Chinese Proverb',
  'Don\'t watch the clock; do what it does. Keep going. - Sam Levenson'
];

function getRandomQuote() {
  return quoteList[Math.floor(Math.random() * quoteList.length)];
}

// Fungsi verifikasi admin
const ADMIN_ACCESS_CODE = 'silo';
const VERIFICATION_TIMEOUT = 300000; // jeda 5 menit

function isAdminVerified(userId) {
  return db.isAdminVerified(userId, VERIFICATION_TIMEOUT);
}

function verifyAdminUser(userId) {
  db.verifyAdminUser(userId);
}

// Search Google
async function searchGoogle(query) {
  try {
    const encoded = encodeURIComponent(query);
    const response = await axiosInstance.get(
      `https://www.google.com/search?q=${encoded}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
      }
    );
    
    // Extract basic results menggunakan regex
    const regex = /<h3[^>]*>.*?<\/h3>/gi;
    const matches = response.data.match(regex) || [];
    
    if (matches.length === 0) {
      return '❌ Tidak ada hasil untuk: ' + query;
    }
    
    let results = `🔍 *HASIL PENCARIAN GOOGLE*\n\n*Query:* ${query}\n\n`;
    matches.slice(0, 5).forEach((match, idx) => {
      const cleaned = match.replace(/<[^>]*>/g, '');
      results += `${idx + 1}. ${cleaned}\n`;
    });
    
    return results;
  } catch (e) {
    console.error('Google Search error:', e.message);
    return '❌ Error saat searching Google: ' + e.message.slice(0, 50);
  }
}

// Search Pinterest
async function searchPinterest(query) {
  try {
    const encoded = encodeURIComponent(query);
    const response = await axiosInstance.get(
      `https://api.pinterest.com/api/?source_url=/search/pins/?q=${encoded}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
      }
    );
    
    if (!response.data) {
      return '❌ Tidak ada hasil Pinterest untuk: ' + query;
    }
    
    let results = `📌 *HASIL PENCARIAN PINTEREST*\n\n*Query:* ${query}\n\n`;
    results += '📷 Silakan buka Pinterest untuk melihat hasil lengkap:\n';
    results += `https://pinterest.com/search/pins/?q=${encoded}`;
    
    return results;
  } catch (e) {
    console.error('Pinterest Search error:', e.message);
    return `📌 Search Pinterest:\nhttps://pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
  }
}

// FITUR ANTILINK UNTUK GRUP
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+|bit\.ly\/[^\s]+|tinyurl\.com\/[^\s]+)/gi;

function detectUrlInMessage(text) {
  return URL_PATTERN.test(text);
}

function setAntiLinkStatus(groupId, status) {
  return db.setAntiLinkStatus(groupId, status);
}

function isAntiLinkEnabled(groupId) {
  return db.isAntiLinkEnabled(groupId);
}

async function connectToWhatsApp() {
  try {
    // Initialize database on first connection
    if (!dbInitialized) {
      await db.initDatabase();
      dbInitialized = true;
      console.log('✅ Database SQLite berhasil diinisialisasi');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    socket = makeWASocket({
      version,
      logger,
      printQRInTerminal: true,
      auth: state,
      syncFullHistory: false
    });

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrcode.generate(qr, { small: true });
        console.log('Scan QR code dengan WhatsApp untuk connect');
      }
      if (connection === 'open') {
        console.log('✅ Little Princess siap dan terhubung!');
      } else if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Koneksi ditutup. Alasan:', lastDisconnect?.error);
        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 3000);
        }
      }
    });

    socket.ev.on('creds.update', saveCreds);
    registerMessageHandler();
  } catch (e) {
    console.error('Error saat koneksi ke WA:', e);
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

function registerMessageHandler() {
  socket.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!body.trim()) return;

      const jid = msg.key.remoteJid;
      const lower = body.toLowerCase().trim();
      const isGroup = jid.endsWith('@g.us');
      const sender = msg.key.participant || jid;

      // ANTILINK CHECK - Process before commands
      if (isGroup && isAntiLinkEnabled(jid)) {
        if (detectUrlInMessage(body)) {
          try {
            // Delete message with link
            await socket.sendMessage(jid, { delete: msg.key });
            
            // Send warning message
            const senderNumber = sender.split('@')[0];
            const warningMsg = `woi kamu jangan ngirim link dong <${senderNumber}> KARENA ANTI LINK NYA ON`;
            await socket.sendMessage(jid, { text: warningMsg });
            return;
          } catch (e) {
            console.error('Antilink delete error:', e.message);
            // Fallback: just send warning if delete fails
            const senderNumber = sender.split('@')[0];
            const warningMsg = `woi kamu jangan ngirim link dong <${senderNumber}> KARENA ANTI LINK NYA ON`;
            await socket.sendMessage(jid, { text: warningMsg });
            return;
          }
        }
      }

      // TAG ALL COMMAND - Tag semua member dalam grup
      if (lower === '.tagall') {
        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Perintah .tagall hanya untuk grup!' });
          return;
        }

        try {
          // Get group metadata
          const groupMetadata = await socket.groupMetadata(jid);
          const participants = groupMetadata.participants;
          
          if (participants.length === 0) {
            await socket.sendMessage(jid, { text: '❌ Tidak ada member di grup!' });
            return;
          }

          // Get all participant JIDs
          const participantJids = participants.map(p => p.id);
          
          // Check if message is a reply to another message
          let messageText = '';
          let quotedMsg = null;
          
          if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            // Message is a reply
            quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '[Pesan]';
            messageText = `${quotedText}

${'⏭️ '.repeat(participantJids.length)} TAG ALL 🔔`;
          } else {
            // Generate tag all message
            messageText = `${'⏭️ '.repeat(participantJids.length)} TAG ALL 🔔`;
          }

          // Send message with mentions
          await socket.sendMessage(jid, {
            text: messageText,
            mentions: participantJids
          });

          // Send confirmation
          const totalMembers = participantJids.length;
          await socket.sendMessage(jid, { 
            text: `✅ Berhasil mention semua ${totalMembers} member!` 
          });
          return;
        } catch (e) {
          console.error('Tag all error:', e.message);
          await socket.sendMessage(jid, { text: '❌ Error saat tag all: ' + e.message.slice(0, 100) });
          return;
        }
      }

      // Menu command
      if (lower === '.menu' || lower === 'menu' || lower === '.ksatriya' || lower === 'ksatriya' || lower === '.ksatriya') {
        await sendMenu(jid);
        return;
      }

      // AI Chat command
      if (lower.startsWith('.gptchan ')) {
        const question = body.substring(9).trim();
        
        if (!question) {
          await socket.sendMessage(jid, { text: '❌ Silakan tulis pertanyaan setelah .gptchan\n\nContoh: .gptchan apa itu AI?' });
          return;
        }

        const userLimit = checkAIChatLimit(sender);
        
        if (userLimit.locked) {
          const resetTime = new Date();
          resetTime.setDate(resetTime.getDate() + 1);
          resetTime.setHours(0, 0, 0, 0);
          
          const timeLeft = Math.ceil((resetTime - new Date()) / 1000 / 3600);
          await socket.sendMessage(jid, { 
            text: `⏳ Chat limit habis (3 chat/hari)\n\n⏰ Reset dalam ~${timeLeft} jam\n\n💬Coba lagi besok!` 
          });
          return;
        }

        await socket.sendMessage(jid, { text: '🤖 Sedang memproses pertanyaan...' });

        const response = await callGeminiAI(question);
        
        const statsAfter = incrementAIChatCount(sender);
        const remaining = 3 - statsAfter.count;
        
        let footer = `\n\n📊 Chat tersisa hari ini: ${remaining}`;
        if (remaining === 0) {
          footer = `\n\n⚠️ Chat limit habis! Reset besok pukul 00:00`;
        }

        await socket.sendMessage(jid, { text: '🤖 *AI Response:*\n\n' + response + footer });
        return;
      }

      // Battle game setup - Generate ROOM ID
      if (lower.startsWith('.battle ')) {
        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Battle hanya bisa dimainkan di grup!' });
          return;
        }

        const lang = lower.split(' ')[1]?.toLowerCase();
        if (!lang || (lang !== 'python' && lang !== 'javascript')) {
          await socket.sendMessage(jid, { 
            text: `❌ Format: .battle <python|javascript>\n\nContoh:\n.battle python\n.battle javascript` 
          });
          return;
        }

        // Check jika sudah ada battle waiting di grup ini
        const existingBattle = getBattleByGroup(jid);
        if (existingBattle) {
          await socket.sendMessage(jid, { 
            text: `⚠️ Sudah ada battle waiting!\n\n🎮 ROOM ID: ${existingBattle.roomId}\n🎯 Mode: ${existingBattle.battle.language}\n\nKetik: .ready <code>` 
          });
          return;
        }

        const battle = setupBattle(jid, sender, lang);
        const langText = lang === 'python' ? '🐍 Python' : '📜 JavaScript';
        
        await socket.sendMessage(jid, { 
          text: `⚔️ *BATTLE CODING DIMULAI!*\n\n🎮 Mode: ${langText}\n🏠 ROOM ID: ${battle.roomId}\n\n🎯 Pembuat: ${sender}\n⏳ Menunggu player lain...\n\n📝 Setiap player ketik:\n.ready <code>\n\nContoh:\n.ready print("Hello World")` 
        });
        return;
      }

      // Battle - Ready/Submit code command
      if (lower.startsWith('.ready ')) {
        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Ready hanya untuk battle di grup!' });
          return;
        }

        // Cari battle waiting di grup
        const battleByGroup = getBattleByGroup(jid);
        
        if (!battleByGroup) {
          await socket.sendMessage(jid, { text: '❌ Tidak ada battle waiting di grup ini. Ketik: .battle <python|javascript>' });
          return;
        }

        const roomId = battleByGroup.roomId;
        const code = body.substring(7).trim();
        
        if (!code) {
          await socket.sendMessage(jid, { text: '❌ Silakan masukkan kode setelah .ready\n\nContoh: .ready print("Hello")' });
          return;
        }

        const result = submitBattleCode(roomId, sender, sender, code);
        
        if (!result.success) {
          await socket.sendMessage(jid, { text: result.message });
          return;
        }

        const battle = result.battle;
        
        let message = `✅ Code diterima dari: ${result.playerName}\n\n`;
        message += formatScoreboard(battle);
        message += `\n🔄 Round: ${battle.round}/${battle.maxRound}`;

        if (battle.status === 'finished') {
          // Find winner
          let winner = null;
          let maxScore = -1;
          let winnerCount = 0;
          
          for (let playerId in   battle.players) {
            const score = battle.players[playerId].score;
            if (score > maxScore) {
              maxScore = score;
              winner = battle.players[playerId].name;
              winnerCount = 1;
            } else if (score === maxScore) {
              winnerCount++;
            }
          }
          
          message += `\n\n🏆 *BATTLE SELESAI!*\n`;
          if (winnerCount > 1) {
            message += `🥇 HASIL: SERI!\n`;
          } else {
            message += `🥇 Pemenang: ${winner}`;
          }
        }

        await socket.sendMessage(jid, { text: message });
        return;
      }

      // Battle - Start/Aktifkan dengan jumlah player
      if (lower.startsWith('.battle start')) {
        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Start hanya untuk battle di grup!' });
          return;
        }

        const battleByGroup = getBattleByGroup(jid);
        
        if (!battleByGroup) {
          await socket.sendMessage(jid, { text: '❌ Tidak ada battle yang pending. Ketik: .battle <python|javascript>' });
          return;
        }

        const roomId = battleByGroup.roomId;
        const battle = battleByGroup.battle;

        if (battle.creatorId !== sender) {
          await socket.sendMessage(jid, { text: '❌ Hanya pembuat battle yang bisa memulai!' });
          return;
        }

        if (Object.keys(battle.players).length < 1) {
          await socket.sendMessage(jid, { text: '❌ Minimal 2 player untuk mulai battle!' });
          return;
        }

        // Aktivasi battle
        db.activateBattle(roomId);

        let message = `🚀 *BATTLE DIMULAI!*\n\n`;
        message += `🏠 ROOM ID: ${roomId}\n`;
        message += `🎮 Mode: ${battle.language === 'python' ? '🐍 Python' : '📜 JavaScript'}\n\n`;
        message += formatScoreboard(battle);
        message += `\n\n▶️ Setiap player ketik: .ready <code>\n\n📌 Hanya syntax valid yang dapat poin!`;

        await socket.sendMessage(jid, { text: message });
        return;
      }

      // ═════════════════════════════════════════════════════════
      // UTILITY CALCULATOR COMMANDS
      // ═════════════════════════════════════════════════════════

      // Show utility menu
      if (lower === '.utility' || lower === '.kalkulator' || lower === '.hitung') {
        await socket.sendMessage(jid, { text: getUtilityMenu() });
        return;
      }

      // Operasi Dasar: Add, Sub, Mul, Div, Mod, Pow
      if (lower.startsWith('.add ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'add');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PERTAMBAHAN*\n\n${args[0]} + ${args[1]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.sub ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'sub');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PENGURANGAN*\n\n${args[0]} - ${args[1]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.mul ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'mul');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PERKALIAN*\n\n${args[0]} × ${args[1]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.div ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'div');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PEMBAGIAN*\n\n${args[0]} ÷ ${args[1]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.mod ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'mod');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *MODULO (SISA BAGI)*\n\n${args[0]} mod ${args[1]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.pow ')) {
        const args = body.substring(5).trim().split(' ');
        const result = calculate(args[0], args[1], 'pow');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PANGKAT*\n\n${args[0]}^${args[1]} = ${result.result}` });
        }
        return;
      }

      // Operasi Math: sqrt, cbrt, abs
      if (lower.startsWith('.sqrt ')) {
        const num = body.substring(6).trim();
        const result = mathOperation(num, 'sqrt');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *AKAR KUADRAT*\n\n√${num} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.cbrt ')) {
        const num = body.substring(6).trim();
        const result = mathOperation(num, 'cbrt');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *AKAR KUBIK*\n\n∛${num} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.abs ')) {
        const num = body.substring(5).trim();
        const result = mathOperation(num, 'abs');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *NILAI MUTLAK*\n\n|${num}| = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.round ')) {
        const args = body.substring(7).trim().split(' ');
        const result = roundNumber(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🧮 *PEMBULATAN*\n\nHasil: ${result.result}` });
        }
        return;
      }

      // Luas & Keliling
      if (lower.startsWith('.luaspersegi ')) {
        const num = body.substring(13).trim();
        const result = calculateArea('persegi', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *LUAS PERSEGI*\n\nSisi: ${num}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.kelilispersegi ')) {
        const num = body.substring(16).trim();
        const result = calculateArea('keliling_persegi', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *KELILING PERSEGI*\n\nSisi: ${num}\nKeliling: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luaspersegipanjang ')) {
        const args = body.substring(20).trim().split(' ');
        const result = calculateArea('persegi_panjang', args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *LUAS PERSEGI PANJANG*\n\nPanjang: ${args[0]}\nLebar: ${args[1]}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.kelilispersegipanjang ')) {
        const args = body.substring(23).trim().split(' ');
        const result = calculateArea('keliling_persegi_panjang', args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *KELILING PERSEGI PANJANG*\n\nPanjang: ${args[0]}\nLebar: ${args[1]}\nKeliling: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luassegitiga ')) {
        const args = body.substring(14).trim().split(' ');
        const result = calculateArea('segitiga', args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *LUAS SEGITIGA*\n\nAlas: ${args[0]}\nTinggi: ${args[1]}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luastrapesium ')) {
        const args = body.substring(15).trim().split(' ');
        const result = calculateArea('trapesium', args[0], args[1], args[2]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *LUAS TRAPESIUM*\n\nSisi 1: ${args[0]}\nSisi 2: ${args[1]}\nTinggi: ${args[2]}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luaslingkaran ')) {
        const num = body.substring(15).trim();
        const result = calculateArea('lingkaran', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *LUAS LINGKARAN*\n\nRadius: ${num}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.kelilinglingkaran ')) {
        const num = body.substring(19).trim();
        const result = calculateArea('keliling_lingkaran', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📐 *KELILING LINGKARAN*\n\nRadius: ${num}\nKeliling: ${result.result}` });
        }
        return;
      }

      // Volume & Bangun Ruang
      if (lower.startsWith('.volumekubus ')) {
        const num = body.substring(13).trim();
        const result = calculateVolume('kubus', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *VOLUME KUBUS*\n\nSisi: ${num}\nVolume: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luaspermukaan ')) {
        const num = body.substring(15).trim();
        const result = calculateVolume('luas_kubus', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *LUAS PERMUKAAN KUBUS*\n\nSisi: ${num}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.volumebalok ')) {
        const args = body.substring(13).trim().split(' ');
        const result = calculateVolume('balok', args[0], args[1], args[2]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *VOLUME BALOK*\n\nPanjang: ${args[0]}\nLebar: ${args[1]}\nTinggi: ${args[2]}\nVolume: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.volumerasipanjang ')) {
        const args = body.substring(19).trim().split(' ');
        const result = calculateVolume('luas_balok', args[0], args[1], args[2]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *LUAS PERMUKAAN BALOK*\n\nPanjang: ${args[0]}\nLebar: ${args[1]}\nTinggi: ${args[2]}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.volumebola ')) {
        const num = body.substring(12).trim();
        const result = calculateVolume('bola', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *VOLUME BOLA*\n\nRadius: ${num}\nVolume: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luasbolasipanjang ')) {
        const num = body.substring(19).trim();
        const result = calculateVolume('luas_bola', num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *LUAS PERMUKAAN BOLA*\n\nRadius: ${num}\nLuas: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.volumesilinder ')) {
        const args = body.substring(16).trim().split(' ');
        const result = calculateVolume('silinder', args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *VOLUME TABUNG*\n\nRadius: ${args[0]}\nTinggi: ${args[1]}\nVolume: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.luassilinder ')) {
        const args = body.substring(14).trim().split(' ');
        const result = calculateVolume('luas_silinder', args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `3️⃣ *LUAS PERMUKAAN TABUNG*\n\nRadius: ${args[0]}\nTinggi: ${args[1]}\nLuas: ${result.result}` });
        }
        return;
      }

      // Statistik
      if (lower.startsWith('.rata2 ')) {
        const args = body.substring(7).trim().split(' ');
        const result = calculateStatistics('rata2', args);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📊 *RATA-RATA*\n\nData: ${args.join(', ')}\nRata-rata: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.median ')) {
        const args = body.substring(8).trim().split(' ');
        const result = calculateStatistics('median', args);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📊 *MEDIAN*\n\nData: ${args.join(', ')}\nMedian: ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.modus ')) {
        const args = body.substring(7).trim().split(' ');
        const result = calculateStatistics('modus', args);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `📊 *MODUS*\n\nData: ${args.join(', ')}\nModus: ${result.result}` });
        }
        return;
      }

      // Konversi
      if (lower.startsWith('.kmtom ')) {
        const num = body.substring(7).trim();
        const result = convertUnit(num, 'km', 'm');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *KM KE METER*\n\n${num} km = ${result.result} m` });
        }
        return;
      }

      if (lower.startsWith('.mtocm ')) {
        const num = body.substring(7).trim();
        const result = convertUnit(num, 'm', 'cm');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *METER KE CM*\n\n${num} m = ${result.result} cm` });
        }
        return;
      }

      if (lower.startsWith('.lbtokg ')) {
        const num = body.substring(8).trim();
        const result = convertUnit(num, 'lb', 'kg');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *POUND KE KG*\n\n${num} lb = ${result.result.toFixed(2)} kg` });
        }
        return;
      }

      if (lower.startsWith('.kgtolb ')) {
        const num = body.substring(8).trim();
        const result = convertUnit(num, 'kg', 'lb');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *KG KE POUND*\n\n${num} kg = ${result.result.toFixed(2)} lb` });
        }
        return;
      }

      if (lower.startsWith('.ctof ')) {
        const num = body.substring(6).trim();
        const result = convertUnit(num, 'c', 'f');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *CELSIUS KE FAHRENHEIT*\n\n${num}°C = ${result.result.toFixed(2)}°F` });
        }
        return;
      }

      if (lower.startsWith('.ftoc ')) {
        const num = body.substring(6).trim();
        const result = convertUnit(num, 'f', 'c');
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🔀 *FAHRENHEIT KE CELSIUS*\n\n${num}°F = ${result.result.toFixed(2)}°C` });
        }
        return;
      }

      // Persentase & Diskon
      if (lower.startsWith('.persen ')) {
        const args = body.substring(8).trim().split(' ');
        const result = calculatePercent(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `💰 *PERSENTASE*\n\n${args[1]}% dari ${args[0]} = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.diskon ')) {
        const args = body.substring(8).trim().split(' ');
        const result = calculateDiscount(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: '💰 *DISKON*\n\n' + result.result });
        }
        return;
      }

      if (lower.startsWith('.pajak ')) {
        const args = body.substring(7).trim().split(' ');
        const result = calculateTax(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: '💰 *PAJAK/PPN*\n\n' + result.result });
        }
        return;
      }

      // Kombinasi & Permutasi
      if (lower.startsWith('.faktorial ')) {
        const num = body.substring(11).trim();
        const result = factorial(num);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🎲 *FAKTORIAL*\n\n${num}! = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.kombinasi ')) {
        const args = body.substring(11).trim().split(' ');
        const result = combination(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🎲 *KOMBINASI*\n\nC(${args[0]},${args[1]}) = ${result.result}` });
        }
        return;
      }

      if (lower.startsWith('.permutasi ')) {
        const args = body.substring(11).trim().split(' ');
        const result = permutation(args[0], args[1]);
        if (!result.success) {
          await socket.sendMessage(jid, { text: '❌ ' + result.error });
        } else {
          await socket.sendMessage(jid, { text: `🎲 *PERMUTASI*\n\nP(${args[0]},${args[1]}) = ${result.result}` });
        }
        return;
      }

      // Khodam checker
      if (lower === '.cekkhodam') {
        const khodam = getRandomKhodam();
        const msg = `✨ *KHODAM CHECKER* ✨\n\n` +
          `👤 Nama: ${sender}\n` +
          `🔮 Khodam: ${khodam}\n\n` +
          `Semoga dimudahkan dalam segala hal! 🙏`;
        
        await socket.sendMessage(jid, { text: msg });
        return;
      }

      // Prayer reminder
      if (lower === '.reminder' || lower === '.pengingat') {
        let reminderText = `🙏 *PENGINGAT IBADAH - 6 AGAMA* 🙏\n\n`;
        
        for (let religion in religionReminders) {
          const data = religionReminders[religion];
          reminderText += `${data.name}\n`;
          reminderText += `⏰ Waktu Ibadah:\n`;
          data.prayers.forEach(p => {
            reminderText += `  • ${p.name}: ${p.time}\n`;
          });
          reminderText += `\n`;
        }
        
        reminderText += `📅 Lihat hari besar agama: .liburanbesar`;
        
        await socket.sendMessage(jid, { text: reminderText });
        return;
      }

      // Religious holidays
      if (lower === '.liburanbesar' || lower === '.hari besar') {
        let holidayText = `📅 *HARI BESAR AGAMA 6 KEPERCAYAAN* 📅\n\n`;
        
        for (let religion in religionReminders) {
          const data = religionReminders[religion];
          holidayText += `${data.name}\n`;
          data.holidays.forEach(h => {
            holidayText += `  📌 ${h.date} - ${h.name}\n`;
          });
          holidayText += `\n`;
        }
        
        await socket.sendMessage(jid, { text: holidayText });
        return;
      }

      // Quote inspiratif random
      if (lower === '.quote') {
        const quote = getRandomQuote();
        const msg = `✨ *DAILY QUOTE* ✨\n\n"${quote}"\n\n💬 Semoga menginspirasi!`;
        
        await socket.sendMessage(jid, { text: msg });
        return;
      }

      // Admin access code verification
      if (lower === ':silo') {
        verifyAdminUser(sender);
        const msg = `✅ *ADMIN TERVERIFIKASI!*\n\n🔐 Akses: ${sender}\n\n📋 Ketik .admin untuk melihat menu admin`;
        await socket.sendMessage(jid, { text: msg });
        return;
      }

      // Admin menu
      if (lower === '.admin') {
        if (!isAdminVerified(sender)) {
          const msg = `🔒 *AKSES DITOLAK*\n\nAnda belum terverifikasi sebagai admin.\n\n📝 Kirim kode akses untuk mengakses fitur admin.`;
          await socket.sendMessage(jid, { text: msg });
          return;
        }

        const adminMenu = `👮 *ADMIN MENU*\n\n🔧 *Fitur Admin:*\n.kick <nomor>\nKick member dari grup\n\n.kudeta\nAmbil alih kontrol grup\n\n.antilink <on|off>\nAktifkan/Nonaktifkan antilink\n\n⚠️ *Persyaratan:*\nBot harus menjadi admin grup untuk fungsi penuh`;
        await socket.sendMessage(jid, { text: adminMenu });
        return;
      }

      // Kick member command
      if (lower.startsWith('.kick ')) {
        if (!isAdminVerified(sender)) {
          await socket.sendMessage(jid, { text: '🔒 Anda tidak terverifikasi sebagai admin!' });
          return;
        }

        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Perintah .kick hanya untuk grup!' });
          return;
        }

        const targetNumber = body.substring(6).trim();
        if (!targetNumber) {
          await socket.sendMessage(jid, { text: '❌ Format: .kick <nomor>\n\nContoh: .kick 6289123456789' });
          return;
        }

        try {
          const targetJid = targetNumber.includes('@') ? targetNumber : targetNumber + '@s.whatsapp.net';
          
          // Get group metadata to check membership
          const groupMetadata = await socket.groupMetadata(jid);
          const participantJids = groupMetadata.participants.map(p => p.id);
          
          if (!participantJids.includes(targetJid)) {
            await socket.sendMessage(jid, { text: `❌ Nomor ${targetNumber} tidak ada di grup ini!` });
            return;
          }

          // Check if bot is admin
          const botIsAdmin = groupMetadata.participants.some(p => 
            p.id === socket.user.id && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          if (!botIsAdmin) {
            await socket.sendMessage(jid, { text: '⚠️ Bot harus menjadi admin grup untuk kick member!\n\nMohon jadikan bot sebagai admin terlebih dahulu.' });
            return;
          }

          // Kick the member
          await socket.groupParticipantsUpdate(jid, [targetJid], 'remove');
          
          const msg = `👊 *KICKED!*\n\n🚪 Bye, Bye ${targetNumber}\nkamu telah di kick admin`;
          await socket.sendMessage(jid, { text: msg });
          return;
        } catch (e) {
          console.error('Kick error:', e.message);
          await socket.sendMessage(jid, { text: '❌ Error saat kick: ' + e.message.slice(0, 50) });
          return;
        }
      }

      // Kudeta command (takeover group)
      if (lower === '.kudeta') {
        if (!isAdminVerified(sender)) {
          await socket.sendMessage(jid, { text: '🔒 Anda tidak terverifikasi sebagai admin!' });
          return;
        }

        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Perintah .kudeta hanya untuk grup!' });
          return;
        }

        try {
          const groupMetadata = await socket.groupMetadata(jid);
          
          // Promote sender ke admin jika belum
          const senderJid = sender;
          const isAlreadyAdmin = groupMetadata.participants.some(p => 
            p.id === senderJid && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          if (!isAlreadyAdmin) {
            // Bot harus admin untuk promote
            const botIsAdmin = groupMetadata.participants.some(p => 
              p.id === socket.user.id && (p.admin === 'admin' || p.admin === 'superadmin')
            );

            if (!botIsAdmin) {
              await socket.sendMessage(jid, { text: '⚠️ Bot harus menjadi admin grup untuk eksekusi kudeta!' });
              return;
            }

            await socket.groupParticipantsUpdate(jid, [senderJid], 'promote');
          }

          const msg = `👑 *KUDETA BERHASIL!*\n\n🏰 Kontrol grup telah diambil alih!\n\n👤 Admin Baru: ${sender}`;
          await socket.sendMessage(jid, { text: msg });
          return;
        } catch (e) {
          console.error('Kudeta error:', e.message);
          await socket.sendMessage(jid, { text: '❌ Error saat kudeta: ' + e.message.slice(0, 50) });
          return;
        }
      }

      // Antilink command
      if (lower.startsWith('.antilink ')) {
        if (!isAdminVerified(sender)) {
          await socket.sendMessage(jid, { text: '🔒 Anda tidak terverifikasi sebagai admin!' });
          return;
        }

        if (!isGroup) {
          await socket.sendMessage(jid, { text: '❌ Perintah .antilink hanya untuk grup!' });
          return;
        }

        const parameter = body.substring(10).trim().toLowerCase();
        
        if (parameter !== 'on' && parameter !== 'off') {
          await socket.sendMessage(jid, { text: '❌ Format: .antilink <on|off>\n\nContoh:\n.antilink on\n.antilink off' });
          return;
        }

        try {
          const groupMetadata = await socket.groupMetadata(jid);
          const botIsAdmin = groupMetadata.participants.some(p => 
            p.id === socket.user.id && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          if (!botIsAdmin) {
            await socket.sendMessage(jid, { text: '⚠️ Bot harus menjadi admin grup untuk menggunakan antilink!\n\nMohon jadikan bot sebagai admin terlebih dahulu.' });
            return;
          }

          const status = setAntiLinkStatus(jid, parameter);
          const statusText = status.enabled ? '✅ ON' : '❌ OFF';
          const msg = `🔗 *ANTILINK ${statusText}*\n\n📝 Sistem antilink telah diatur ke: ${parameter.toUpperCase()}\n\nLink akan ${status.enabled ? 'DIHAPUS' : 'DIPERBOLEHKAN'}`;
          
          await socket.sendMessage(jid, { text: msg });
          return;
        } catch (e) {
          console.error('Antilink error:', e.message);
          await socket.sendMessage(jid, { text: '❌ Error saat mengatur antilink: ' + e.message.slice(0, 50) });
          return;
        }
      }

      // Search Google
      if (lower.startsWith('.search ')) {
        const query = body.substring(8).trim();
        if (!query) {
          await socket.sendMessage(jid, { text: '❌ Format: .search <query>\n\nContoh: .search cara membuat bot' });
          return;
        }

        await socket.sendMessage(jid, { text: '🔍 Sedang mencari...' });
        const result = await searchGoogle(query);
        await socket.sendMessage(jid, { text: result });
        return;
      }

      // Search Pinterest
      if (lower.startsWith('.pinterest ')) {
        const query = body.substring(11).trim();
        if (!query) {
          await socket.sendMessage(jid, { text: '❌ Format: .pinterest <query>\n\nContoh: .pinterest aesthetic room' });
          return;
        }

        const result = await searchPinterest(query);
        await socket.sendMessage(jid, { text: result });
        return;
      }

      // Help battle
      if (lower === '.battle help' || lower === '.battle ?') {
        const helpText = `⚔️ *BATTLE CODING GUIDE*\n\n` +
          `📝 *Cara Bermain:*\n` +
          `1. Ketik: .battle <python|javascript>\n` +
          `2. Setiap player ketik: .ready <code>\n` +
          `3. Pembuat ketik: .battle start\n` +
          `4. Setiap .ready = 1 poin (jika syntax valid)\n` +
          `5. Pemenang = score tertinggi\n\n` +
          `🎮 *Contoh:*\n` +
          `.battle python\n` +
          `.ready print("Hello World")\n` +
          `.ready x = 5\n` +
          `.battle start\n\n` +
          `⚠️ RULES:\n` +
          `• Hanya di GRUP\n` +
          `• Syntax HARUS benar\n` +
          `• Bot TIDAK ikut main\n` +
          `• Multi-player supported`;
        
        await socket.sendMessage(jid, { text: helpText });
        return;
      }

      const parts = body.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const potentialUrl = parts[1] || parts[0];
      const urlPattern = /(https?:\/\/[^\s]+)/i;
      const isUrl = urlPattern.test(potentialUrl);

      if ((cmd === '.youtube' || cmd === 'youtube' || cmd === '.yt' || cmd === 'yt') && isUrl) {
        await socket.sendMessage(jid, { text: '⏳ Sedang meng koneksikan ke API youtube downloader' });
        await downloadYoutubeMsg(potentialUrl, socket, jid);
        return;
      }

      if ((cmd === '.tiktok' || cmd === 'tiktok' || cmd === '.tt' || cmd === 'tt') && isUrl) {
        await socket.sendMessage(jid, { text: '⏳ Sedang meng koneksikan ke API tiktok downloader' });
        await downloadTiktokMsg(potentialUrl, socket, jid);
        return;
      }

      // Instagram
      if ((cmd === '.instagram' || cmd === 'instagram' || cmd === '.ig' || cmd === 'ig') && isUrl) {
        await socket.sendMessage(jid, { text: '⏳ Sedang meng koneksikan ke API instagram downloader' });
        await downloadViaApisMsg('instagram', potentialUrl, socket, jid);
        return;

      }

      // Twitter
      if ((cmd === '.twitter' || cmd === 'twitter' || cmd === '.tw' || cmd === 'tw') && isUrl) {
        await socket.sendMessage(jid, { text: '⏳ Sedang meng koneksikan ke API twitter downloader' });
        await downloadViaApisMsg('twitter', potentialUrl, socket, jid);
        return;
      }

      // Auto-detect URL
      if (isUrl && parts.length === 1) {
        const u = potentialUrl.toLowerCase();
        if (u.includes('youtube.com') || u.includes('youtu.be')) {
          await socket.sendMessage(jid, { text: '🔍 Terdeteksi sebagai YouTube — download...' });
          await downloadYoutubeMsg(potentialUrl, socket, jid);
          return;
        }
        if (u.includes('tiktok.com')) {
          await socket.sendMessage(jid, { text: '🔍 Terdeteksi sebagai TikTok — download...' });
          await downloadTiktokMsg(potentialUrl, socket, jid);
          return;
        }
        if (u.includes('instagram.com')) {
          await socket.sendMessage(jid, { text: '🔍 Terdeteksi sebagai Instagram — download...' });
          await downloadViaApisMsg('instagram', potentialUrl, socket, jid);
          return;
        }
        if (u.includes('twitter.com') || u.includes('x.com')) {
          await socket.sendMessage(jid, { text: '🔍 Terdeteksi sebagai Twitter/X — download...' });
          await downloadViaApisMsg('twitter', potentialUrl, socket, jid);
          return;
        }
      }
    } catch (e) {
      console.error('Error handler:', e);
    }
  });
}

async function sendMenu(jid) {
  const imgUrl = config.bannerImage;
  try {
    const imgRes = await axiosInstance.get(imgUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const tmpImg = path.join(__dirname, 'banner_${Date.now()}.jpg');
    fs.writeFileSync(tmpImg, Buffer.from(imgRes.data));

    const imgRes2 = await axiosInstance.get(config.bannerImage, { responseType: 'arraybuffer', timeout: 10000 });
    const tmpImg2 = path.join(__dirname, 'banner2_${Date.now()}.jpg');
    fs.writeFileSync(tmpImg2, Buffer.from(imgRes2.data));

    await socket.sendMessage(jid, {
      image: fs.readFileSync(tmpImg),
      caption: '🎉 *Selamat datang di Little Princess Bot!*\n\n📢 Klik link di bawah untuk informasi lebih lanjut:',
      contextInfo: {
        externalAdReply: {
          title: '📢 Lihat Saluran',
          body: 'Klik untuk mengunjungi saluran kami',
          mediaUrl: config.menuChannelLink || 'https://example.com',
          mediaType: 1,
          sourceUrl: config.menuChannelLink || 'https://example.com'
        }
      }
    });

    const menuText = `˜”*°•.˜”*°• Little Princess •°*”˜.•°”˜

『 *Menu bot:* 』

❖ Downloader
❖ AI Chat
❖ Search  
❖ Game
❖ Spiritual
❖ Admin
❖ Kalkulator

⫷ *Downloader* ⫸
> .youtube <link>
> .tiktok <link>
> .instagram <link>
> .twitter <link>

*Males?* kirim link doang
Bot akan auto-detect!

⫷ *AI MENU* ⫸
> .gptchan <pertanyaan>

⫷ *SEARCH MENU* ⫸
> .search <query>
> .pinterest <query>

⫷ *GAME MENU* ⫸
> .battle <python|javascript> 
> .ready <code>
> .battle start
> .battle help

⫷ *UTILITY MENU* ⫸
> .utility 

⫷ *SPIRITUAL MENU* ⫸
> .cekkhodam
> .reminder
> .liburanbesar
> .quote

⫷ *ADMIN MENU* ⫸
> .admin
> .kick <nomor>
> .kudeta
> .antilink <on|off>

⫷ *GROUP MENU* ⫸
> .tagall
Tag semua member

⫷ *Other menu* ⫸
> .utility
> .credit
> .support`;

    await socket.sendMessage(jid, { text: menuText });

    await socket.sendMessage(jid, {
      image: fs.readFileSync(tmpImg2),
      caption: '📸 Menu Banner Tambahan\n✨ Nikmati berbagai fitur menarik dari bot kami!'
    });

    if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg);
    if (fs.existsSync(tmpImg2)) fs.unlinkSync(tmpImg2);
  } catch (e) {
    console.error('Menu error:', e.message);
    const fallback = '⫷ Little Princess ⫸\n\n.youtube <link>\n.tiktok <link>\n.instagram <link>\n.twitter <link>\n\n.gptchan <pertanyaan>\n\n.search <query>\n.pinterest <query>\n\n.battle <python|javascript>\n.ready <code>\n.battle start\n.battle help\n\n.utility\n\n.cekkhodam\n.reminder\n.liburanbesar\n.quote\n\n:silo\n.admin\n.kick <nomor>\n.kudeta\n.antilink\n\n.tagall';
    await socket.sendMessage(jid, { text: fallback });
  }
}

async function downloadYoutubeMsg(url, sock, jid) {
  try {
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
    const ext = format.container || 'mp4';
    const tmp = path.join(__dirname, `yt_${Date.now()}.${ext}`);
    
    const stream = ytdl(url, { quality: 'highestvideo' });
    const writeStream = fs.createWriteStream(tmp);
    
    stream.pipe(writeStream);
    
    await new Promise((res, rej) => {
      writeStream.on('finish', res);
      writeStream.on('error', rej);
      stream.on('error', rej);
    });
    
    const fileSize = fs.statSync(tmp).size;
    if (fileSize === 0) throw new Error('File kosong');
    
    await sock.sendMessage(jid, { 
      video: fs.readFileSync(tmp),
      caption: '❖ YouTube - Little Princess' 
    });
    
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (e) {
    console.error('YouTube error:', e.message);
    await sock.sendMessage(jid, { text: '❌ Gagal download YouTube' });
  }
}

async function downloadTiktokMsg(url, sock, jid) {
  try {
    const encodedUrl = encodeURIComponent(url);
    
    try {
      const res = await axiosInstance.get(`https://www.tikwm.com/api/?url=${encodedUrl}`);
      const j = res.data;
      
      if (j.code === 0 && j.data) {
        const videoUrl = j.data.play;
        const title = j.data.title || 'TikTok Video';
        
        if (videoUrl) {
          const videoRes = await axiosInstance.get(videoUrl, { 
            responseType: 'arraybuffer',
            headers: { 'Referer': 'https://www.tikwm.com/' }
          });
          
          const tmp = path.join(__dirname, `tiktok_${Date.now()}.mp4`);
          fs.writeFileSync(tmp, Buffer.from(videoRes.data));
          
          const fileSize = fs.statSync(tmp).size;
          if (fileSize === 0) throw new Error('File kosong');
          
          await sock.sendMessage(jid, { 
            video: fs.readFileSync(tmp),
            caption: `❖ TikTok - Little Princess`
          });
          
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          return;
        }
      }
    } catch (e) {
      console.log('tikwm fallback:', e.message);
    }
    
    await downloadViaApisMsg('tiktok', url, sock, jid);
  } catch (e) {
    console.error('TikTok error:', e.message);
    await sock.sendMessage(jid, { text: '❌ Gagal download TikTok' });
  }
}

async function tryApis(list, targetUrl, platform = '') {
  if (!Array.isArray(list) || list.length === 0) return null;
  
  for (let i = 0; i < list.length; i++) {
    const api = list[i];
    if (!api) continue;
    
    const endpoint = api.replace('{url}', encodeURIComponent(targetUrl));
    
    try {
      const res = await axiosInstance.get(endpoint);
      
      if (!res.data) continue;
      
      const body = res.data;
      let videoUrl = null;
      
      if (typeof body === 'string' && body.startsWith('http')) {
        videoUrl = body;
      } else if (body.url && body.url.startsWith('http')) {
        videoUrl = body.url;
      } else if (body.download && body.download.startsWith('http')) {
        videoUrl = body.download;
      } else if (body.play && body.play.startsWith('http')) {
        videoUrl = body.play;
      } else if (body.result && typeof body.result === 'string' && body.result.startsWith('http')) {
        videoUrl = body.result;
      } else if (body.result && Array.isArray(body.result) && body.result[0] && body.result[0].url) {
        videoUrl = body.result[0].url;
      } else if (body.data && body.data.startsWith && body.data.startsWith('http')) {
        videoUrl = body.data;
      } else if (body.data && body.data.url && body.data.url.startsWith('http')) {
        videoUrl = body.data.url;
      } else if (body.videoUrl && body.videoUrl.startsWith('http')) {
        videoUrl = body.videoUrl;
      } else if (body.video_url && body.video_url.startsWith('http')) {
        videoUrl = body.video_url;
      }
      
      if (videoUrl) {
        console.log(`✅ API working: ${endpoint.slice(0, 50)}...`);
        return { url: videoUrl, api: endpoint };
      }
    } catch (e) {
    }
  }
  
  return null;
}

async function downloadViaApisMsg(platform, url, sock, jid) {
  try {
    // Coba tanpa key dulu
    let r = await tryApis(config[`${platform}NoKeyApis`] || [], url, platform);
    
    // Kalau gagal, coba dengan key/cadangan
    if (!r) {
      r = await tryApis(config[`${platform}Apis`] || [], url, platform);
    }
    
    if (!r) {
      await sock.sendMessage(jid, { text: `❌ Gagal download ${platform}. API tidak merespons.` });
      return;
    }

    // Download video/image dari URL yang sudah di-extract
    const mediaRes = await axiosInstance.get(r.url, { 
      responseType: 'arraybuffer',
      headers: {
        'Referer': url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const ct = mediaRes.headers['content-type'] || '';
    let ext = 'bin';
    if (ct.includes('mp4')) ext = 'mp4';
    if (ct.includes('mpeg')) ext = 'mp3';
    if (ct.includes('image/jpeg') || ct.includes('image/jpg')) ext = 'jpg';
    if (ct.includes('image/png')) ext = 'png';
    
    const tmp = path.join(__dirname, `${platform}_${Date.now()}.${ext}`);
    fs.writeFileSync(tmp, Buffer.from(mediaRes.data));
    
    const fileSize = fs.statSync(tmp).size;
    if (fileSize === 0) throw new Error('File kosong');
    
    if (ext === 'mp4') {
      await sock.sendMessage(jid, { 
        video: fs.readFileSync(tmp),
        caption: `🎥 ${platform} - Little Princess`
      });
    } else if (ext === 'mp3') {
      await sock.sendMessage(jid, { 
        audio: fs.readFileSync(tmp),
        mimetype: 'audio/mpeg',
        ptt: false
      });
    } else if (ext === 'jpg' || ext === 'png') {
      await sock.sendMessage(jid, { 
        image: fs.readFileSync(tmp),
        caption: `🖼️ ${platform} - Little Princess`
      });
    }
    
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (e) {
    console.error(`${platform} error:`, e.message);
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message.slice(0, 50)}` });
  }
}

connectToWhatsApp().catch(e => {
  console.error('Fatal error:', e);
  db.closeDatabase();
  process.exit(1);
});

// Cleanup on process termination
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  db.closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  db.closeDatabase();
  process.exit(0);
});

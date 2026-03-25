const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// New sendMenu function to inject into index.js (built safely without nested template literals)
const newFunc = [
  'async function sendMenu(jid) {',
  "  const imgUrl = config.bannerImage;",
  '  try {',
  "    const imgRes = await axiosInstance.get(imgUrl, { responseType: 'arraybuffer', timeout: 10000 });",
  "    const tmpImg = path.join(__dirname, 'banner_${Date.now()}.jpg');",
  "    fs.writeFileSync(tmpImg, Buffer.from(imgRes.data));",
  '',
  "    const imgRes2 = await axiosInstance.get(config.bannerImage, { responseType: 'arraybuffer', timeout: 10000 });",
  "    const tmpImg2 = path.join(__dirname, 'banner2_${Date.now()}.jpg');",
  "    fs.writeFileSync(tmpImg2, Buffer.from(imgRes2.data));",
  '',
  '    await socket.sendMessage(jid, {',
  "      image: fs.readFileSync(tmpImg),",
  "      caption: '🎉 *Selamat datang di Little Princess Bot!*\\n\\n📢 Klik link di bawah untuk informasi lebih lanjut:',",
  '      contextInfo: {',
  '        externalAdReply: {',
  "          title: '📢 Lihat Saluran',",
  "          body: 'Klik untuk mengunjungi saluran kami',",
  "          mediaUrl: config.menuChannelLink || 'https://example.com',",
  "          mediaType: 1,",
  "          sourceUrl: config.menuChannelLink || 'https://example.com'",
  '        }',
  '      }',
  '    });',
  '',
  "    const menuText = \"˜\\\"*°•.˜\\\"*°• Little Princess •°*\\\\\"˜.•°*\\\\\"˜\\n\\n『 *Menu bot:* 』\\n\\n❖ Downloader\\n❖ AI Chat\\n❖ Search  \\\\n> .youtube <link>\\n> .tiktok <link>\\n> .instagram <link>\\n> .twitter <link>\\n\\n*Males?* kirim link doang\\nBot akan auto-detect!\\n\\n⫷ *AI MENU* ⫸\\n> .gptchan <pertanyaan>\\n\\n⫷ *SEARCH MENU* ⫸\\n> .search <query>\\n> .pinterest <query>\\n\\n⫷ *GAME MENU* ⫸\\n> .battle <python|javascript> \\\\n> .ready <code>\\n> .battle start\\n> .battle help\\n\\n⫷ *UTILITY MENU* ⫸\\n> .utility \\\\n\\n⫷ *SPIRITUAL MENU* ⫸\\n> .cekkhodam\\n> .reminder\\n> .liburanbesar\\n> .quote\\n\\n⫷ *ADMIN MENU* ⫸\\n> .admin\\n> .kick <nomor>\\n> .kudeta\\n> .antilink <on|off>\\n\\n⫷ *GROUP MENU* ⫸\\n> .tagall\\nTag semua member\\n\\n⫷ *Other menu* ⫸\\n> .utility\\n> .credit\\n> .support\";",
  '',
  '    await socket.sendMessage(jid, { text: menuText });',
  '',
  "    await socket.sendMessage(jid, {",
  "      image: fs.readFileSync(tmpImg2),",
  "      caption: '📸 Menu Banner Tambahan\\n✨ Nikmati berbagai fitur menarik dari bot kami!'",
  '    });',
  '',
  "    if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg);",
  "    if (fs.existsSync(tmpImg2)) fs.unlinkSync(tmpImg2);",
  '  } catch (e) {',
  "    console.error('Menu error:', e.message);",
  "    const fallback = '⫷ Little Princess ⫸\\n\\n.youtube <link>\\n.tiktok <link>\\n.instagram <link>\\n.twitter <link>\\n\\n.gptchan <pertanyaan>\\n\\n.search <query>\\n.pinterest <query>\\n\\n.battle <python|javascript>\\n.ready <code>\\n.battle start\\n.battle help\\n\\n.utility\\n\\n.cekkhodam\\n.reminder\\n.liburanbesar\\n.quote\\n\\n:silo\\n.admin\\n.kick <nomor>\\n.kudeta\\n.antilink\\n\\n.tagall';",
  "    await socket.sendMessage(jid, { text: fallback });",
  '  }',
  '}',
].join('\n');

// Locate existing sendMenu function in index.js
const funcStart = content.indexOf('async function sendMenu(jid) {');
if (funcStart === -1) {
  console.error('Fungsi sendMenu tidak ditemukan di index.js');
  process.exit(1);
}

// Find function end by counting braces (ignoring strings)
let braceCount = 0;
let inString = false;
let stringChar = '';
let funcEnd = funcStart + 'async function sendMenu(jid) {'.length;
for (let i = funcEnd; i < content.length; i++) {
  const ch = content[i];
  const prev = i > 0 ? content[i - 1] : '';
  if (!inString && (ch === '"' || ch === "'" || ch === '`') && prev !== '\\') {
    inString = true; stringChar = ch; continue;
  }
  if (inString) {
    if (ch === stringChar && prev !== '\\') inString = false;
    continue;
  }
  if (ch === '{') braceCount++;
  if (ch === '}') {
    braceCount--;
    if (braceCount === -1) { funcEnd = i + 1; break; }
  }
}

const newContent = content.substring(0, funcStart) + newFunc + content.substring(funcEnd);
fs.writeFileSync(filePath, newContent, 'utf8');
console.log('✅ Fungsi sendMenu berhasil diperbarui di index.js');

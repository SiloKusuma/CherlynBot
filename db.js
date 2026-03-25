const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const adminPath = path.join(__dirname, 'admin.json');

let db = null;
let SQL = null;

// Initialize database with SQL.js
async function initDatabase() {
  if (SQL) return db; // Already initialized
  
  try {
    SQL = await initSqlJs();
    
    // Try to load existing database file
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }
    
    // Create tables
    createTables();
    saveDatabase();
    
    console.log('✅ SQLite Database initialized with sql.js');
    return db;
  } catch (e) {
    console.error('Error initializing database:', e);
    throw e;
  }
}

function createTables() {
  // AI Chat table
  db.run(`
    CREATE TABLE IF NOT EXISTS aiChat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT UNIQUE NOT NULL,
      count INTEGER DEFAULT 0,
      lastDate TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Battle Game table
  db.run(`
    CREATE TABLE IF NOT EXISTS battleGame (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomId TEXT UNIQUE NOT NULL,
      groupId TEXT NOT NULL,
      creatorId TEXT NOT NULL,
      language TEXT NOT NULL,
      status TEXT DEFAULT 'waiting',
      round INTEGER DEFAULT 0,
      maxRound INTEGER DEFAULT 3,
      playersReady INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Battle Players table
  db.run(`
    CREATE TABLE IF NOT EXISTS battlePlayers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomId TEXT NOT NULL,
      playerId TEXT NOT NULL,
      name TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(roomId, playerId),
      FOREIGN KEY(roomId) REFERENCES battleGame(roomId) ON DELETE CASCADE
    )
  `);

  // Anti Link Groups table
  db.run(`
    CREATE TABLE IF NOT EXISTS antiLinkGroups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupId TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 0,
      enabledAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for better performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_aiChat_userId ON aiChat(userId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_battleGame_roomId ON battleGame(roomId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_battleGame_groupId ON battleGame(groupId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_battlePlayers_roomId ON battlePlayers(roomId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_antiLinkGroups_groupId ON antiLinkGroups(groupId)`);
}

function saveDatabase() {
  try {
    if (db) {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbPath, buffer);
    }
  } catch (e) {
    console.error('Error saving database:', e);
  }
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// ===== AI Chat Functions =====
function checkAIChatLimit(userId) {
  const database = getDb();
  const today = new Date().toDateString();
  
  const stmt = database.prepare('SELECT * FROM aiChat WHERE userId = ?');
  stmt.bind([userId]);
  let user = null;
  if (stmt.step()) {
    user = stmt.getAsObject();
  }
  stmt.free();
  
  if (!user) {
    const insertStmt = database.prepare('INSERT INTO aiChat (userId, count, lastDate, locked) VALUES (?, ?, ?, ?)');
    insertStmt.bind([userId, 0, today, 0]);
    insertStmt.step();
    insertStmt.free();
    saveDatabase();
    return { count: 0, lastDate: today, locked: false };
  }
  
  // Reset if different day
  if (user.lastDate !== today) {
    const updateStmt = database.prepare('UPDATE aiChat SET count = ?, lastDate = ?, locked = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?');
    updateStmt.bind([0, today, 0, userId]);
    updateStmt.step();
    updateStmt.free();
    saveDatabase();
    return { count: 0, lastDate: today, locked: false };
  }
  
  return { count: user.count, lastDate: user.lastDate, locked: user.locked === 1 };
}

function incrementAIChatCount(userId) {
  const database = getDb();
  const today = new Date().toDateString();
  
  const stmt = database.prepare('SELECT * FROM aiChat WHERE userId = ?');
  stmt.bind([userId]);
  let user = null;
  if (stmt.step()) {
    user = stmt.getAsObject();
  }
  stmt.free();
  
  if (!user) {
    const insertStmt = database.prepare('INSERT INTO aiChat (userId, count, lastDate, locked) VALUES (?, ?, ?, ?)');
    insertStmt.bind([userId, 1, today, 0]);
    insertStmt.step();
    insertStmt.free();
    saveDatabase();
    return { count: 1, lastDate: today, locked: false };
  }
  
  if (user.lastDate !== today) {
    const updateStmt = database.prepare('UPDATE aiChat SET count = ?, lastDate = ?, locked = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?');
    updateStmt.bind([1, today, 0, userId]);
    updateStmt.step();
    updateStmt.free();
    saveDatabase();
    return { count: 1, lastDate: today, locked: false };
  }
  
  const newCount = user.count + 1;
  const locked = newCount >= 3 ? 1 : 0;
  const updateStmt = database.prepare('UPDATE aiChat SET count = ?, locked = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?');
  updateStmt.bind([newCount, locked, userId]);
  updateStmt.step();
  updateStmt.free();
  saveDatabase();
  
  return { count: newCount, lastDate: user.lastDate, locked: locked === 1 };
}

// ===== Battle Game Functions =====
function setupBattle(groupId, creatorId, language) {
  const database = getDb();
  const roomId = 'ROOM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  
  const stmt = database.prepare(`
    INSERT INTO battleGame (roomId, groupId, creatorId, language, status, round, maxRound, playersReady)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.bind([roomId, groupId, creatorId, language, 'waiting', 0, 3, 0]);
  stmt.step();
  stmt.free();
  saveDatabase();
  
  return {
    roomId: roomId,
    groupId: groupId,
    creatorId: creatorId,
    language: language,
    players: {},
    status: 'waiting',
    round: 0,
    maxRound: 3,
    playersReady: 0
  };
}

function submitBattleCode(roomId, playerId, playerName, code) {
  const database = getDb();
  
  // Check battle exists
  const battleStmt = database.prepare('SELECT * FROM battleGame WHERE roomId = ?');
  battleStmt.bind([roomId]);
  let battleExists = false;
  if (battleStmt.step()) {
    battleExists = true;
  }
  battleStmt.free();
  
  if (!battleExists) {
    return { success: false, message: '❌ Room tidak ditemukan! Room ID tidak valid.' };
  }
  
  // Check if player exists, if not add them
  const checkPlayerStmt = database.prepare('SELECT * FROM battlePlayers WHERE roomId = ? AND playerId = ?');
  checkPlayerStmt.bind([roomId, playerId]);
  let playerExists = false;
  if (checkPlayerStmt.step()) {
    playerExists = true;
  }
  checkPlayerStmt.free();
  
  if (!playerExists) {
    const insertPlayerStmt = database.prepare('INSERT INTO battlePlayers (roomId, playerId, name, score) VALUES (?, ?, ?, ?)');
    insertPlayerStmt.bind([roomId, playerId, playerName, 0]);
    insertPlayerStmt.step();
    insertPlayerStmt.free();
  }
  
  // Update player score
  const updateScoreStmt = database.prepare('UPDATE battlePlayers SET score = score + 1, updatedAt = CURRENT_TIMESTAMP WHERE roomId = ? AND playerId = ?');
  updateScoreStmt.bind([roomId, playerId]);
  updateScoreStmt.step();
  updateScoreStmt.free();
  
  // Update battle ready status
  const countStmt = database.prepare('SELECT COUNT(*) as cnt FROM battlePlayers WHERE roomId = ?');
  countStmt.bind([roomId]);
  let playerCount = 0;
  if (countStmt.step()) {
    const result = countStmt.getAsObject();
    playerCount = result.cnt;
  }
  countStmt.free();
  
  const updateBattleStmt = database.prepare('UPDATE battleGame SET playersReady = playersReady + 1, updatedAt = CURRENT_TIMESTAMP WHERE roomId = ?');
  updateBattleStmt.bind([roomId]);
  updateBattleStmt.step();
  updateBattleStmt.free();
  
  // Check if all players ready
  const checkBattleStmt = database.prepare('SELECT * FROM battleGame WHERE roomId = ?');
  checkBattleStmt.bind([roomId]);
  let updatedBattle = null;
  if (checkBattleStmt.step()) {
    updatedBattle = checkBattleStmt.getAsObject();
  }
  checkBattleStmt.free();
  
  if (updatedBattle && updatedBattle.playersReady >= playerCount && playerCount > 0) {
    const updateRoundStmt = database.prepare('UPDATE battleGame SET round = round + 1, playersReady = 0, updatedAt = CURRENT_TIMESTAMP WHERE roomId = ?');
    updateRoundStmt.bind([roomId]);
    updateRoundStmt.step();
    updateRoundStmt.free();
    
    const nextBattleStmt = database.prepare('SELECT * FROM battleGame WHERE roomId = ?');
    nextBattleStmt.bind([roomId]);
    let nextBattle = null;
    if (nextBattleStmt.step()) {
      nextBattle = nextBattleStmt.getAsObject();
    }
    nextBattleStmt.free();
    
    if (nextBattle && nextBattle.round >= nextBattle.maxRound) {
      const finishStmt = database.prepare('UPDATE battleGame SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE roomId = ?');
      finishStmt.bind(['finished', roomId]);
      finishStmt.step();
      finishStmt.free();
    }
  }
  
  saveDatabase();
  return { success: true, message: 'Code submitted successfully' };
}

function getBattleStatus(roomId) {
  const database = getDb();
  
  const stmt = database.prepare('SELECT * FROM battleGame WHERE roomId = ?');
  stmt.bind([roomId]);
  let battle = null;
  if (stmt.step()) {
    battle = stmt.getAsObject();
  }
  stmt.free();
  
  if (!battle) return null;
  
  const playerStmt = database.prepare('SELECT * FROM battlePlayers WHERE roomId = ?');
  playerStmt.bind([roomId]);
  const players = [];
  while (playerStmt.step()) {
    players.push(playerStmt.getAsObject());
  }
  playerStmt.free();
  
  const playersObj = {};
  players.forEach(p => {
    playersObj[p.playerId] = { name: p.name, score: p.score };
  });
  
  return {
    roomId: battle.roomId,
    groupId: battle.groupId,
    creatorId: battle.creatorId,
    language: battle.language,
    players: playersObj,
    status: battle.status,
    round: battle.round,
    maxRound: battle.maxRound,
    playersReady: battle.playersReady
  };
}

function getBattleByGroup(groupId) {
  const database = getDb();
  
  const stmt = database.prepare('SELECT * FROM battleGame WHERE groupId = ? AND status = ? LIMIT 1');
  stmt.bind([groupId, 'waiting']);
  let battle = null;
  if (stmt.step()) {
    battle = stmt.getAsObject();
  }
  stmt.free();
  
  if (!battle) return null;
  
  const playerStmt = database.prepare('SELECT * FROM battlePlayers WHERE roomId = ?');
  playerStmt.bind([battle.roomId]);
  const players = [];
  while (playerStmt.step()) {
    players.push(playerStmt.getAsObject());
  }
  playerStmt.free();
  
  const playersObj = {};
  players.forEach(p => {
    playersObj[p.playerId] = { name: p.name, score: p.score };
  });
  
  return {
    roomId: battle.roomId,
    battle: {
      roomId: battle.roomId,
      groupId: battle.groupId,
      creatorId: battle.creatorId,
      language: battle.language,
      players: playersObj,
      status: battle.status,
      round: battle.round,
      maxRound: battle.maxRound,
      playersReady: battle.playersReady
    }
  };
}

// ===== Update Battle Status =====
function activateBattle(roomId) {
  const database = getDb();
  
  const stmt = database.prepare('UPDATE battleGame SET status = ?, round = ?, updatedAt = CURRENT_TIMESTAMP WHERE roomId = ?');
  stmt.bind(['active', 1, roomId]);
  stmt.step();
  stmt.free();
  saveDatabase();
  
  return getBattleStatus(roomId);
}

// ===== Anti Link Functions =====
function setAntiLinkStatus(groupId, status) {
  const database = getDb();
  const enabled = status === 'on' || status === true ? 1 : 0;
  
  const checkStmt = database.prepare('SELECT * FROM antiLinkGroups WHERE groupId = ?');
  checkStmt.bind([groupId]);
  let existing = null;
  if (checkStmt.step()) {
    existing = checkStmt.getAsObject();
  }
  checkStmt.free();
  
  if (!existing) {
    const insertStmt = database.prepare('INSERT INTO antiLinkGroups (groupId, enabled, enabledAt) VALUES (?, ?, CURRENT_TIMESTAMP)');
    insertStmt.bind([groupId, enabled]);
    insertStmt.step();
    insertStmt.free();
  } else {
    const updateStmt = database.prepare('UPDATE antiLinkGroups SET enabled = ?, enabledAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE groupId = ?');
    updateStmt.bind([enabled, groupId]);
    updateStmt.step();
    updateStmt.free();
  }
  
  saveDatabase();
  return { enabled: enabled === 1, enabledAt: new Date().toISOString() };
}

function isAntiLinkEnabled(groupId) {
  const database = getDb();
  
  const stmt = database.prepare('SELECT enabled FROM antiLinkGroups WHERE groupId = ?');
  stmt.bind([groupId]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  
  return result && result.enabled === 1;
}

// ===== Admin User Functions (in separate admin.json) =====
function loadAdminData() {
  try {
    if (fs.existsSync(adminPath)) {
      return JSON.parse(fs.readFileSync(adminPath, 'utf-8'));
    }
  } catch (e) {
    console.log('Admin database tidak ditemukan, membuat baru...');
  }
  return { adminUsers: {} };
}

function saveAdminData(data) {
  try {
    fs.writeFileSync(adminPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error save admin database:', e);
  }
}

function isAdminVerified(userId, VERIFICATION_TIMEOUT) {
  const data = loadAdminData();
  if (!data.adminUsers) data.adminUsers = {};
  
  const user = data.adminUsers[userId];
  if (!user) return false;
  
  // Check if verification still valid
  if (Date.now() - user.verifiedAt > VERIFICATION_TIMEOUT) {
    delete data.adminUsers[userId];
    saveAdminData(data);
    return false;
  }
  
  return user.verified === true;
}

function verifyAdminUser(userId) {
  const data = loadAdminData();
  if (!data.adminUsers) data.adminUsers = {};
  
  data.adminUsers[userId] = {
    verified: true,
    verifiedAt: Date.now()
  };
  
  saveAdminData(data);
}

// ===== Cleanup =====
function closeDatabase() {
  if (db) {
    try {
      saveDatabase();
      db.close();
      db = null;
    } catch (e) {
      console.error('Error closing database:', e);
    }
  }
}

module.exports = {
  initDatabase,
  getDb,
  checkAIChatLimit,
  incrementAIChatCount,
  setupBattle,
  submitBattleCode,
  getBattleStatus,
  getBattleByGroup,
  activateBattle,
  setAntiLinkStatus,
  isAntiLinkEnabled,
  isAdminVerified,
  verifyAdminUser,
  closeDatabase,
  loadAdminData,
  saveAdminData
};

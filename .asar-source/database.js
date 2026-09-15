const fs = require('fs');
const path = require('path');

let pool = null;
let localConfig = {};
function getConfig() {
  return {
    host: localConfig.host || process.env.SARAFA_DB_HOST || '127.0.0.1',
    port: Number(localConfig.port || process.env.SARAFA_DB_PORT || 3306),
    user: localConfig.user || process.env.SARAFA_DB_USER || 'sarafa_user',
    password: localConfig.password || process.env.SARAFA_DB_PASSWORD || '',
    database: localConfig.database || process.env.SARAFA_DB_NAME || 'sarafa',
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    connectTimeout: 3000
  };
}
function configure(config = {}) {
  localConfig = { ...config };
  if (pool) pool.end().catch(() => undefined);
  pool = null;
}
async function connect() {
  if (pool) return pool;
  try {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool(getConfig());
    await pool.query('SELECT 1');
    return pool;
  } catch (error) {
    pool = null;
    return null;
  }
}
async function query(sql, params = []) {
  const db = await connect();
  if (!db) return { rows: [], offline: true };
  const [rows] = await db.execute(sql, params);
  return { rows, offline: false };
}
async function transaction(work) {
  const db = await connect();
  if (!db) throw new Error('تعذر الاتصال بقاعدة MySQL');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
function localSettingsFile(userDataPath) {
  const dir = path.join(userDataPath, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'settings.json');
}
module.exports = { connect, query, transaction, getConfig, configure, localSettingsFile };

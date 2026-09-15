const { query, transaction, getConfig } = require('./database');
const crypto = require('crypto');
let activeSession = null;
const operationalSchema = { readyKey:'', task:null };
function operationalSchemaKey() { const config=getConfig(); return [config.host,config.port,config.database,config.user].map((value) => String(value || '')).join('\u0001'); }

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`حقل ${label} مطلوب`);
  return text;
}

function numberValue(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(`قيمة ${label} غير صحيحة`);
  return number;
}

async function rows(sql, params = []) {
  const result = await query(sql, params);
  if (result.offline) throw new Error('تعذر الاتصال بقاعدة MySQL. تحقق من الإعدادات والخدمة.');
  return result.rows;
}

async function currentUserId() {
  if (!activeSession?.id) throw new Error('يرجى تسجيل الدخول أولًا');
  const users = await rows('SELECT id FROM users WHERE id = ? AND active = TRUE LIMIT 1', [activeSession.id]);
  if (!users[0]) throw new Error('المستخدم الحالي محجوب أو غير موجود');
  return users[0].id;
}

function verifyPassword(password, storedHash) {
  if (storedHash === 'CHANGE_ME') return password === 'admin';
  const [method, salt, expected] = String(storedHash || '').split('$');
  if (method !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function login(input) {
  await ensureOperationalTables();
  const username = requireText(input.username, 'اسم المستخدم');
  const password = requireText(input.password, 'كلمة المرور');
  const users = await rows('SELECT id, username, password_hash, display_name, role_name, active, device_restricted FROM users WHERE username = ? LIMIT 1', [username]);
  const user = users[0];
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحين، أو أن الحساب محجوب');
  const deviceName = String(input.deviceName || 'Windows محلي').slice(0, 150);
  if (user.device_restricted) {
    const devices = await rows('SELECT id FROM user_devices WHERE user_id = ? AND device_name = ? AND allowed = TRUE LIMIT 1', [user.id, deviceName]);
    if (!devices[0]) throw new Error('هذا الجهاز غير معتمد لهذا المستخدم. راجع مدير النظام.');
  }
  await transaction(async (connection) => {
    await connection.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    const [session] = await connection.execute('INSERT INTO user_sessions (user_id, device_name) VALUES (?, ?)', [user.id, deviceName]);
    activeSession = { id: user.id, sessionId: session.insertId, username: user.username, displayName: user.display_name, roleName: user.role_name };
    await audit(connection, user.id, 'login', 'users', user.id, { username: user.username });
  });
  return { id: user.id, username: user.username, displayName: user.display_name, roleName: user.role_name, initialPassword: user.password_hash === 'CHANGE_ME' };
}

async function getSession() {
  if (!activeSession?.id) return null;
  const users = await rows('SELECT id, username, display_name, role_name, active FROM users WHERE id = ? LIMIT 1', [activeSession.id]);
  if (!users[0]?.active) { activeSession = null; return null; }
  return { id: users[0].id, username: users[0].username, displayName: users[0].display_name, roleName: users[0].role_name };
}

async function verifyAdministratorPassword(input) {
  const session = await getSession();
  if (!session || !(session.username === 'admin' || /(مدير|مدراء|admin)/i.test(session.roleName || ''))) throw new Error('فتح الإدارة المحمية متاح لمدير النظام فقط');
  const password = requireText(input?.password, 'كلمة مرور مدير النظام');
  const users = await rows('SELECT password_hash FROM users WHERE id = ? AND active = TRUE LIMIT 1', [session.id]);
  if (!users[0] || !verifyPassword(password, users[0].password_hash)) throw new Error('كلمة مرور مدير النظام غير صحيحة');
  return { userId: session.id, username: session.username };
}

async function logout() {
  if (activeSession?.id) {
    await transaction(async (connection) => {
      if (activeSession.sessionId) await connection.execute('UPDATE user_sessions SET logout_at = NOW() WHERE id = ?', [activeSession.sessionId]);
      await audit(connection, activeSession.id, 'logout', 'users', activeSession.id, {});
    });
  }
  activeSession = null;
  return { ok: true };
}

async function changeOwnPassword(input) {
  const userId = await currentUserId();
  const currentPassword = requireText(input.currentPassword, 'كلمة المرور الحالية');
  const newPassword = requireText(input.newPassword, 'كلمة المرور الجديدة');
  if (newPassword.length < 8) throw new Error('كلمة المرور الجديدة يجب أن تتكون من 8 أحرف على الأقل');
  return transaction(async (connection) => {
    const [users] = await connection.execute('SELECT password_hash FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!users[0] || !verifyPassword(currentPassword, users[0].password_hash)) throw new Error('كلمة المرور الحالية غير صحيحة');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [`scrypt$${salt}$${hash}`, userId]);
    await audit(connection, userId, 'password_change', 'users', userId, {});
    return { ok: true };
  });
}

function passwordHash(password) { const salt=crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(password,salt,64).toString('hex')}`; }
function recoveryCodeHash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }

async function requestManagerPasswordRecovery() {
  await ensureOperationalTables();
  const managers=await rows("SELECT id, username, display_name FROM users WHERE active=TRUE AND (username='admin' OR role_name REGEXP 'مدير|admin') ORDER BY username='admin' DESC LIMIT 1");
  const manager=managers[0]; if (!manager) throw new Error('لا يوجد مدير نظام نشط لاستعادة كلمة المرور');
  const recent=await rows('SELECT created_at FROM password_recovery_tokens WHERE user_id=? ORDER BY id DESC LIMIT 1',[manager.id]);
  if (recent[0] && Date.now()-new Date(recent[0].created_at).getTime() < 5*60*1000) throw new Error('تم طلب رمز حديثًا. انتظر خمس دقائق قبل طلب رمز جديد');
  const code=String(crypto.randomInt(100000,1000000)); const expiresAt=new Date(Date.now()+15*60*1000);
  await transaction(async (connection) => {
    await connection.execute('UPDATE password_recovery_tokens SET used_at=NOW() WHERE user_id=? AND used_at IS NULL',[manager.id]);
    await connection.execute('INSERT INTO password_recovery_tokens (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)',[manager.id,recoveryCodeHash(code),expiresAt]);
    await audit(connection,manager.id,'password_recovery_requested','users',manager.id,{ expiresAt:expiresAt.toISOString() });
  });
  return { code, expiresAt:expiresAt.toISOString(), managerName:manager.display_name || manager.username };
}

async function completeManagerPasswordRecovery(input) {
  await ensureOperationalTables();
  const code=requireText(input.code,'رمز الاستعادة'); const newPassword=requireText(input.newPassword,'كلمة المرور الجديدة');
  if (newPassword.length < 12) throw new Error('كلمة المرور الجديدة يجب أن تتكون من 12 حرفًا على الأقل');
  return transaction(async (connection) => {
    const [tokens]=await connection.execute("SELECT t.id,t.user_id,t.code_hash,t.expires_at,t.attempts,u.username FROM password_recovery_tokens t JOIN users u ON u.id=t.user_id WHERE t.used_at IS NULL ORDER BY t.id DESC LIMIT 1 FOR UPDATE");
    const token=tokens[0]; if (!token || new Date(token.expires_at).getTime() < Date.now()) throw new Error('رمز الاستعادة غير صالح أو انتهت صلاحيته');
    if (Number(token.attempts) >= 5) throw new Error('تم إيقاف هذا الرمز بعد محاولات متعددة. اطلب رمزًا جديدًا');
    if (recoveryCodeHash(code) !== token.code_hash) { await connection.execute('UPDATE password_recovery_tokens SET attempts=attempts+1 WHERE id=?',[token.id]); await audit(connection,token.user_id,'password_recovery_failed','users',token.user_id,{ attempts:Number(token.attempts)+1 }); throw new Error('رمز الاستعادة غير صحيح'); }
    await connection.execute('UPDATE users SET password_hash=? WHERE id=?',[passwordHash(newPassword),token.user_id]);
    await connection.execute('UPDATE password_recovery_tokens SET used_at=NOW() WHERE id=?',[token.id]);
    await audit(connection,token.user_id,'password_recovery_completed','users',token.user_id,{});
    return { ok:true, username:token.username };
  });
}

async function requireAdministrator(userId) {
  const users = await rows('SELECT username, role_name FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!users[0] || !(users[0].username === 'admin' || /(مدير|مدراء|admin)/i.test(users[0].role_name || ''))) throw new Error('هذه العملية متاحة لمدير النظام فقط');
}

async function requirePermission(userId, moduleKey, capability) {
  const columnMap = { view: 'can_view', add: 'can_add', edit: 'can_edit', delete: 'can_delete', post: 'can_post', print: 'can_print' };
  const column = columnMap[capability];
  if (!column) throw new Error('صلاحية العملية غير معروفة');
  const users = await rows('SELECT role_name FROM users WHERE id = ? AND active = TRUE LIMIT 1', [userId]);
  const user = users[0];
  if (!user) throw new Error('المستخدم غير نشط');
  if (user.username === 'admin' || /(مدير|مدراء|admin)/i.test(user.role_name || '')) return;
  const direct = await rows(`SELECT ${column} AS allowed FROM user_permissions WHERE user_id = ? AND module_key = ? LIMIT 1`, [userId, moduleKey]);
  if (direct[0]) { if (direct[0].allowed) return; throw new Error('لا تملك الصلاحية المطلوبة لهذه العملية'); }
  const inherited = await rows(`SELECT gp.${column} AS allowed FROM user_groups ug JOIN group_permissions gp ON gp.group_id=ug.id WHERE ug.group_name = ? AND ug.active=TRUE AND gp.module_key = ? LIMIT 1`, [user.role_name, moduleKey]);
  if (inherited[0]?.allowed) return;
  throw new Error('لا تملك الصلاحية المطلوبة لهذه العملية');
}

async function audit(connection, userId, action, entity, entityId, details) {
  const payload = details || {};
  const [result] = await connection.execute('INSERT INTO audit_log (user_id, action_name, entity_name, entity_id, details_json) VALUES (?, ?, ?, ?, ?)', [userId, action, entity, entityId || null, JSON.stringify(payload)]);
  const before = Object.prototype.hasOwnProperty.call(payload, 'before') ? payload.before : null;
  const after = Object.prototype.hasOwnProperty.call(payload, 'after') ? payload.after : payload;
  const integrityHash = crypto.createHash('sha256').update(JSON.stringify({ auditId:result.insertId, userId, action, entity, entityId:entityId || null, before, after })).digest('hex');
  try {
    await connection.execute('INSERT INTO secret_audit_archive (audit_id, user_id, action_name, entity_name, entity_id, before_json, after_json, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [result.insertId, userId, action, entity, entityId || null, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), integrityHash]);
  } catch (error) {
    if (!/secret_audit_archive/i.test(String(error?.message || ''))) throw error;
  }
}

async function ensureOperationalTables() {
  const schemaKey=operationalSchemaKey();
  if (operationalSchema.readyKey === schemaKey) return;
  if (operationalSchema.task?.key === schemaKey) return operationalSchema.task.promise;
  const task=(async () => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS vouchers (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, voucher_no VARCHAR(50) NOT NULL UNIQUE,
      voucher_type ENUM('receipt','payment') NOT NULL, voucher_date DATE NOT NULL,
      cashbox_id INT NOT NULL, counter_account_id INT NOT NULL, currency_id INT NOT NULL,
      amount DECIMAL(20,6) NOT NULL, party_name VARCHAR(180) NULL, handler_name VARCHAR(180) NULL, reference_no VARCHAR(80) NULL,
      notes TEXT NULL, journal_id BIGINT NULL, status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
      created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id), FOREIGN KEY(counter_account_id) REFERENCES accounts(id),
      FOREIGN KEY(currency_id) REFERENCES currencies(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS cashbox_accounts (
      cashbox_id INT PRIMARY KEY, account_id INT NOT NULL,
      FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id)
    )`,
    `CREATE TABLE IF NOT EXISTS customer_cashbox_links (
      customer_id INT PRIMARY KEY, cashbox_id INT NOT NULL, account_id INT NOT NULL,
      created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id), FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS cashbox_counts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, count_no VARCHAR(50) NOT NULL UNIQUE,
      cashbox_id INT NOT NULL, count_date DATE NOT NULL, book_amount DECIMAL(20,6) NOT NULL,
      actual_amount DECIMAL(20,6) NOT NULL, variance_amount DECIMAL(20,6) NOT NULL,
      counter_account_id INT NULL, journal_id BIGINT NULL, notes TEXT NULL, created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id), FOREIGN KEY(counter_account_id) REFERENCES accounts(id),
      FOREIGN KEY(journal_id) REFERENCES journal_entries(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS cheques (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, cheque_no VARCHAR(80) NOT NULL, cheque_type ENUM('received','issued') NOT NULL,
      counterparty_name VARCHAR(180) NOT NULL, bank_name VARCHAR(180) NULL, amount DECIMAL(20,6) NOT NULL,
      currency_id INT NOT NULL, due_date DATE NULL, status ENUM('pending','collected','returned','cancelled') NOT NULL DEFAULT 'pending',
      notes TEXT NULL, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cheque_no (cheque_no), FOREIGN KEY(currency_id) REFERENCES currencies(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS transfer_journals (
      transfer_id BIGINT PRIMARY KEY, journal_id BIGINT NOT NULL,
      FOREIGN KEY(transfer_id) REFERENCES transfers(id), FOREIGN KEY(journal_id) REFERENCES journal_entries(id)
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY, employee_no VARCHAR(40) NOT NULL UNIQUE,
      full_name VARCHAR(180) NOT NULL, phone VARCHAR(40) NULL, job_title VARCHAR(120) NULL,
      monthly_salary DECIMAL(20,6) NOT NULL DEFAULT 0, account_id INT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(account_id) REFERENCES accounts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS user_groups (
      id INT AUTO_INCREMENT PRIMARY KEY, group_name VARCHAR(80) NOT NULL UNIQUE,
      description_ar VARCHAR(255) NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS group_permissions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, group_id INT NOT NULL, module_key VARCHAR(80) NOT NULL,
      can_add BOOLEAN NOT NULL DEFAULT FALSE, can_edit BOOLEAN NOT NULL DEFAULT FALSE,
      can_delete BOOLEAN NOT NULL DEFAULT FALSE, can_post BOOLEAN NOT NULL DEFAULT FALSE,
      can_print BOOLEAN NOT NULL DEFAULT FALSE, can_view BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE KEY uq_group_module (group_id, module_key), FOREIGN KEY(group_id) REFERENCES user_groups(id)
    )`,
    `CREATE TABLE IF NOT EXISTS user_devices (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, device_name VARCHAR(150) NOT NULL,
      device_token VARCHAR(120) NULL, allowed BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_device (user_id, device_name), FOREIGN KEY(user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, device_name VARCHAR(150) NULL,
      login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, logout_at DATETIME NULL,
      FOREIGN KEY(user_id) REFERENCES users(id), INDEX idx_session_user (user_id, login_at)
    )`,
    `CREATE TABLE IF NOT EXISTS password_recovery_tokens (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL, attempts INT NOT NULL DEFAULT 0, used_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recovery_user (user_id, created_at), FOREIGN KEY(user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS financial_periods (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, period_name VARCHAR(120) NOT NULL, date_from DATE NOT NULL,
      date_to DATE NOT NULL, status ENUM('open','closed') NOT NULL DEFAULT 'open',
      closed_by INT NULL, closed_at DATETIME NULL, notes TEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_period_dates (date_from, date_to), FOREIGN KEY(closed_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS transfer_payouts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, payout_no VARCHAR(50) NOT NULL UNIQUE, transfer_id BIGINT NOT NULL,
      payout_date DATE NOT NULL, cashbox_id INT NOT NULL, amount DECIMAL(20,6) NOT NULL,
      receiver_name VARCHAR(180) NULL, receiver_id_no VARCHAR(80) NULL, notes TEXT NULL,
      created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_transfer_payout (transfer_id), FOREIGN KEY(transfer_id) REFERENCES transfers(id),
      FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS secret_audit_archive (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, audit_id BIGINT NOT NULL UNIQUE, user_id INT NULL,
      action_name VARCHAR(100) NOT NULL, entity_name VARCHAR(100) NOT NULL, entity_id BIGINT NULL,
      before_json JSON NULL, after_json JSON NULL, integrity_hash CHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_secret_archive_created (created_at), INDEX idx_secret_archive_entity (entity_name, entity_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`,
    'SELECT 1'
  ];
  for (const statement of statements) await rows(statement);
  const optionalColumns = [
    ['accounts', 'is_frozen', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['accounts', 'freeze_reason', 'VARCHAR(255) NULL'],
    ['accounts', 'max_transaction_amount', 'DECIMAL(20,6) NULL'],
    ['users', 'device_restricted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['transfers', 'counter_account_id', 'INT NULL'],
    ['transfer_payouts', 'journal_id', 'BIGINT NULL'],
    ['currencies', 'min_buy_rate', 'DECIMAL(18,6) NULL'],
    ['currencies', 'max_sell_rate', 'DECIMAL(18,6) NULL'],
    ['customers', 'identity_no', 'VARCHAR(80) NULL'],
    ['customers', 'notes', 'TEXT NULL'],
    ['customers', 'max_transaction_amount', 'DECIMAL(20,6) NULL'],
    ['customers', 'is_blocked', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['customers', 'block_reason', 'VARCHAR(255) NULL'],
    ['accounts', 'statement_category', "VARCHAR(40) NOT NULL DEFAULT 'balance_sheet'"],
    ['accounts', 'display_rank', 'INT NOT NULL DEFAULT 0'],
    ['accounts', 'created_by', 'INT NULL'],
    ['accounts', 'created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['vouchers', 'handler_name', 'VARCHAR(180) NULL'],
    ['cashboxes', 'cashbox_no', 'INT NULL']
  ];
  for (const [tableName, columnName, columnDefinition] of optionalColumns) {
    const existing = await rows('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1', [tableName, columnName]);
    if (!existing[0]) await rows(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
  }
  // لا نعيد ترقيم الحسابات أو المستندات أو الصناديق الموجودة عند فتح التطبيق.
  // الأرقام البسيطة تطبق فقط عند إنشاء سجل جديد عبر nextNo/createCashbox، حمايةً
  // للمراجع التاريخية والعلاقات المالية وبيانات المستخدم القائمة.
  operationalSchema.readyKey=schemaKey;
  })();
  operationalSchema.task={ key:schemaKey, promise:task };
  try { await task; } finally { if (operationalSchema.task?.promise === task) operationalSchema.task=null; }
}

function bootstrapDiagnostic(key, label, error) {
  const message=String(error?.message || 'تعذر قراءة القسم').replace(/[\r\n]+/g, ' ').slice(0, 220);
  return { key, label, message };
}

async function loadBootstrapData(fetchRows = rows) {
  const section=async (key, label, load, fallback = []) => {
    try { return { key, value:await load(), diagnostic:null }; }
    catch (error) { return { key, value:fallback, diagnostic:bootstrapDiagnostic(key,label,error) }; }
  };
  const sections=await Promise.all([
    section('currencies','دليل العملات',() => fetchRows('SELECT id, code, name_ar, is_base, buy_rate, sell_rate, transfer_rate, min_buy_rate, max_sell_rate, active FROM currencies ORDER BY is_base DESC, code')),
    section('accounts','دليل الحسابات',() => fetchRows(`SELECT a.id, a.code, a.name_ar, a.parent_id, a.account_type, a.statement_category, a.display_rank, a.active, a.is_frozen, a.freeze_reason, a.max_transaction_amount, a.created_at, u.display_name AS created_by_name FROM accounts a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.display_rank, a.code`)),
    section('customers','دليل العملاء',() => fetchRows(`SELECT c.id, c.customer_no, c.full_name, c.phone, c.address_ar, c.customer_type, c.identity_no, c.notes, c.max_transaction_amount, c.is_blocked, c.block_reason, c.active, ccl.cashbox_id AS linked_cashbox_id, ccl.account_id AS linked_account_id, cb.name_ar AS linked_cashbox_name, a.name_ar AS linked_account_name FROM customers c LEFT JOIN customer_cashbox_links ccl ON ccl.customer_id=c.id LEFT JOIN cashboxes cb ON cb.id=ccl.cashbox_id LEFT JOIN accounts a ON a.id=ccl.account_id ORDER BY c.id DESC`)),
    section('cashboxes','الصناديق',() => fetchRows(`SELECT cb.id, COALESCE(cb.cashbox_no,cb.id) AS cashbox_no, cb.name_ar, cb.active, COALESCE(b.name_ar,'غير مرتبط بفرع') AS branch_name, u.display_name AS user_name, ca.account_id, a.name_ar AS account_name FROM cashboxes cb LEFT JOIN branches b ON b.id=cb.branch_id LEFT JOIN users u ON u.id=cb.user_id LEFT JOIN cashbox_accounts ca ON ca.cashbox_id=cb.id LEFT JOIN accounts a ON a.id=ca.account_id ORDER BY COALESCE(cb.cashbox_no,cb.id), cb.id`)),
    section('cashboxCounts','جرد الصناديق',() => fetchRows(`SELECT cc.id, cc.count_no, cc.count_date, cc.book_amount, cc.actual_amount, cc.variance_amount, cb.name_ar AS cashbox_name FROM cashbox_counts cc LEFT JOIN cashboxes cb ON cb.id=cc.cashbox_id ORDER BY cc.id DESC LIMIT 50`)),
    section('cheques','الشيكات',() => fetchRows(`SELECT ch.id, ch.cheque_no, ch.cheque_type, ch.counterparty_name, ch.bank_name, ch.amount, ch.due_date, ch.status, c.code AS currency_code FROM cheques ch LEFT JOIN currencies c ON c.id=ch.currency_id ORDER BY ch.id DESC LIMIT 100`)),
    section('transfers','الحوالات',() => fetchRows(`SELECT t.id, t.transfer_no, t.transfer_type, t.sender_name, t.sender_phone, t.beneficiary_name, t.beneficiary_phone, t.amount, c.code AS currency_code, t.commission, t.status, t.created_at, DATE(t.created_at) AS transfer_date, t.notes, ag.full_name AS agent_name, NULL AS cashbox_name, ca.name_ar AS counter_account_name, p.payout_no, p.payout_date FROM transfers t LEFT JOIN currencies c ON c.id=t.currency_id LEFT JOIN customers ag ON ag.id=t.agent_id LEFT JOIN accounts ca ON ca.id=t.counter_account_id LEFT JOIN transfer_payouts p ON p.transfer_id=t.id ORDER BY t.id DESC LIMIT 100`)),
    section('exchanges','عمليات الصرافة',() => fetchRows(`SELECT e.id, e.operation_no, e.operation_type, e.operation_date, e.created_at, e.customer_id, e.amount, e.deal_rate, e.local_value, e.status, c.code AS currency_code, COALESCE(cu.full_name, '') AS customer_name FROM exchange_operations e LEFT JOIN currencies c ON c.id=e.currency_id LEFT JOIN customers cu ON cu.id=e.customer_id ORDER BY e.id DESC LIMIT 100`)),
    section('vouchers','السندات',() => fetchRows(`SELECT v.id, v.voucher_no, v.voucher_type, v.voucher_date, v.created_at, v.amount, v.party_name, v.handler_name, v.reference_no, v.notes, v.cashbox_id, v.counter_account_id, v.currency_id, v.status, c.code AS currency_code, cb.name_ar AS cashbox_name, ca.name_ar AS counter_account_name FROM vouchers v LEFT JOIN currencies c ON c.id=v.currency_id LEFT JOIN cashboxes cb ON cb.id=v.cashbox_id LEFT JOIN accounts ca ON ca.id=v.counter_account_id ORDER BY v.id DESC LIMIT 100`)),
    section('cashPurchases','شراء العملات النقدية',() => fetchRows(`SELECT p.id, p.purchase_no, p.purchase_date, p.created_at, p.customer_name, p.amount, p.purchase_rate, p.local_value, p.status, c.code AS currency_code, cb.name_ar AS cashbox_name FROM cash_currency_purchases p LEFT JOIN currencies c ON c.id=p.currency_id LEFT JOIN cashboxes cb ON cb.id=p.cashbox_id ORDER BY p.id DESC LIMIT 100`)),
    section('journalEntries','القيود اليومية',() => fetchRows('SELECT id, entry_no, entry_date, description_ar, source_type, posted, created_at FROM journal_entries ORDER BY id DESC LIMIT 200')),
    section('users','المستخدمون',() => fetchRows('SELECT id, username, display_name, role_name, active, last_login FROM users ORDER BY id')),
    section('employees','الموظفون',() => fetchRows('SELECT e.id, e.employee_no, e.full_name, e.phone, e.job_title, e.monthly_salary, e.account_id, e.active, a.name_ar AS account_name FROM employees e LEFT JOIN accounts a ON a.id=e.account_id ORDER BY e.id DESC')),
    section('permissions','صلاحيات المستخدمين',() => fetchRows('SELECT user_id, module_key, can_add, can_edit, can_delete, can_post, can_print, can_view FROM user_permissions ORDER BY user_id, module_key')),
    section('groups','المجموعات',() => fetchRows('SELECT id, group_name, description_ar, active FROM user_groups ORDER BY group_name')),
    section('groupPermissions','صلاحيات المجموعات',() => fetchRows('SELECT group_id, module_key, can_add, can_edit, can_delete, can_post, can_print, can_view FROM group_permissions ORDER BY group_id, module_key')),
    section('periods','الفترات المالية',() => fetchRows('SELECT id, period_name, date_from, date_to, status, closed_at FROM financial_periods ORDER BY date_to DESC LIMIT 50')),
    section('summary','ملخص لوحة التحكم',() => fetchRows(`SELECT (SELECT COUNT(*) FROM transfers WHERE DATE(created_at)=CURDATE()) AS transfers_today, (SELECT COUNT(*) FROM transfers WHERE status='pending') AS transfers_pending, (SELECT COUNT(*) FROM vouchers WHERE voucher_date=CURDATE() AND status='posted') AS vouchers_today, (SELECT COALESCE(SUM(CASE WHEN voucher_type='receipt' THEN amount ELSE 0 END),0) FROM vouchers WHERE voucher_date=CURDATE() AND status='posted') AS receipts_today, (SELECT COALESCE(SUM(CASE WHEN voucher_type='payment' THEN amount ELSE 0 END),0) FROM vouchers WHERE voucher_date=CURDATE() AND status='posted') AS payments_today, (SELECT COALESCE(SUM(local_value),0) FROM exchange_operations WHERE status='posted') AS exchange_volume, (SELECT COALESCE(SUM(handling_fee),0) FROM exchange_operations WHERE status='posted') AS exchange_handling, (SELECT COALESCE(SUM(commission),0) FROM transfers WHERE status <> 'cancelled') AS transfer_commission, (SELECT COUNT(*) FROM journal_entries WHERE entry_date=CURDATE() AND posted=TRUE) AS journals_today, (SELECT COUNT(*) FROM journal_entries WHERE posted=FALSE) AS journal_drafts, (SELECT COUNT(*) FROM (SELECT jl.journal_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id WHERE je.posted=TRUE GROUP BY jl.journal_id HAVING ABS(SUM(jl.debit)-SUM(jl.credit))>0.000001) invalid_journals) AS unbalanced_journals, (SELECT COALESCE(SUM(jl.credit-jl.debit),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE je.posted=TRUE AND je.entry_date=CURDATE() AND a.account_type='income') AS income_today, (SELECT COALESCE(SUM(jl.debit-jl.credit),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE je.posted=TRUE AND je.entry_date=CURDATE() AND a.account_type='expense') AS expense_today`), [{}])
  ]);
  const data=Object.fromEntries(sections.map((item) => [item.key,item.value]));
  return { ...data, summary:data.summary?.[0] || {}, loadDiagnostics:sections.filter((item) => item.diagnostic).map((item) => item.diagnostic) };
}

async function bootstrap() { return loadBootstrapData(); }

/* قارئ توافق احتياطي: لا ينفذ ترقية جداول أو ربط علاقات أو كتابة بيانات.
   يستخدم فقط عندما يفشل bootstrap الشامل في قاعدة إصدار سابق، حتى تبقى أدلة
   التشغيل القابلة للقراءة ظاهرة ولا يمنع فشل دليل واحد بقية الأدلة. */
async function getCoreDirectories() {
  const directory = async (key, label, load) => {
    try { return { key, value:await load(), diagnostic:null }; }
    catch (error) { return { key, value:[], diagnostic:bootstrapDiagnostic(key,label,error) }; }
  };
  const sections=await Promise.all([
    directory('currencies','دليل العملات المتوافق',() => rows('SELECT id, code, name_ar, is_base, buy_rate, sell_rate, active FROM currencies ORDER BY is_base DESC, code')),
    directory('accounts','دليل الحسابات المتوافق',() => rows('SELECT id, code, name_ar, parent_id, account_type, active FROM accounts ORDER BY code')),
    directory('cashboxes','دليل الصناديق المتوافق',async () => {
      try { return await rows('SELECT cb.id, COALESCE(cb.cashbox_no,cb.id) AS cashbox_no, cb.name_ar, cb.active, ca.account_id FROM cashboxes cb LEFT JOIN cashbox_accounts ca ON ca.cashbox_id=cb.id ORDER BY COALESCE(cb.cashbox_no,cb.id), cb.id'); }
      catch { return rows('SELECT id, id AS cashbox_no, name_ar, active FROM cashboxes ORDER BY id'); }
    }),
    directory('customers','دليل العملاء المتوافق',() => rows('SELECT id, customer_no, full_name, phone, address_ar, customer_type, active FROM customers ORDER BY id DESC'))
  ]);
  const data=Object.fromEntries(sections.map((item) => [item.key,item.value]));
  return { ...data, cashboxCounts:[], loadDiagnostics:sections.filter((item) => item.diagnostic).map((item) => item.diagnostic) };
}

async function ensurePostingDateOpen(connection, entryDate) {
  const date = entryDate || new Date().toISOString().slice(0, 10);
  const [policy] = await connection.execute("SELECT setting_value FROM app_settings WHERE setting_key='prevent_past_posting' LIMIT 1");
  if (policy[0]?.setting_value === 'true' && date < new Date().toISOString().slice(0, 10)) throw new Error('سياسة النظام تمنع الترحيل أو الصرف بتاريخ سابق');
  const [closed] = await connection.execute("SELECT id, period_name FROM financial_periods WHERE status='closed' AND ? BETWEEN date_from AND date_to LIMIT 1", [date]);
  if (closed[0]) throw new Error(`الفترة المالية «${closed[0].period_name}» مقفلة ولا تسمح بترحيل حركة جديدة`);
}

async function ensureAccountAllowed(connection, accountId, amount) {
  const [accounts] = await connection.execute('SELECT active, is_frozen, max_transaction_amount FROM accounts WHERE id = ?', [accountId]);
  const account = accounts[0];
  if (!account || !account.active) throw new Error('الحساب غير نشط أو غير موجود');
  if (account.is_frozen) throw new Error('الحساب مجمد ولا يسمح بالحركات');
  if (account.max_transaction_amount != null && Number(amount) > Number(account.max_transaction_amount)) throw new Error(`المبلغ يتجاوز سقف حركة الحساب (${account.max_transaction_amount})`);
}

async function enforceTransferLimit(connection, amount) {
  const [settings] = await connection.execute("SELECT setting_value FROM app_settings WHERE setting_key='max_transfer_amount' LIMIT 1");
  const limit = Number(settings[0]?.setting_value || 0);
  if (limit > 0 && Number(amount) > limit) throw new Error(`المبلغ يتجاوز سقف الحوالة المحلي (${limit})`);
}

async function resolveStatementAccount(input) {
  const targetType = ['account', 'customer', 'cashbox'].includes(input.targetType) ? input.targetType : 'account';
  const targetId = Number(input.targetId || input.accountId || 0);
  if (!targetId) throw new Error(targetType === 'customer' ? 'اختر العميل أولًا' : targetType === 'cashbox' ? 'اختر الصندوق أولًا' : 'اختر الحساب أولًا');
  if (targetType === 'cashbox') {
    const result = await rows('SELECT account_id FROM cashbox_accounts WHERE cashbox_id=? LIMIT 1', [targetId]);
    if (!result[0]?.account_id) throw new Error('الصندوق غير مرتبط بحساب محاسبي');
    return Number(result[0].account_id);
  }
  if (targetType === 'customer') {
    const result = await rows('SELECT account_id FROM customer_cashbox_links WHERE customer_id=? LIMIT 1', [targetId]);
    if (!result[0]?.account_id) throw new Error('لا يوجد حساب مرتبط بهذا العميل. افتح العميل واربطه بالصندوق أولًا.');
    return Number(result[0].account_id);
  }
  return targetId;
}

async function accountStatement(input) {
  const accountId = await resolveStatementAccount(input);
  const filters = ['jl.account_id = ?', 'je.posted = TRUE'];
  const params = [accountId];
  if (input.dateFrom) { filters.push('je.entry_date >= ?'); params.push(input.dateFrom); }
  if (input.dateTo) { filters.push('je.entry_date <= ?'); params.push(input.dateTo); }
  if (input.currencyId) { filters.push('jl.currency_id = ?'); params.push(Number(input.currencyId)); }
  return rows(`SELECT je.entry_date, je.entry_no, je.description_ar, je.source_type, je.source_id, jl.debit, jl.credit, c.code AS currency_code
               FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN currencies c ON c.id=jl.currency_id
               WHERE ${filters.join(' AND ')} ORDER BY je.entry_date, jl.id`, params);
}

async function accountStatementSummary(input) {
  const accountId = await resolveStatementAccount(input);
  const baseFilters = ['jl.account_id = ?', 'je.posted = TRUE'];
  const baseParams = [accountId];
  if (input.currencyId) { baseFilters.push('jl.currency_id = ?'); baseParams.push(Number(input.currencyId)); }
  const periodFilters = [...baseFilters]; const periodParams = [...baseParams];
  if (input.dateFrom) { periodFilters.push('je.entry_date >= ?'); periodParams.push(input.dateFrom); }
  if (input.dateTo) { periodFilters.push('je.entry_date <= ?'); periodParams.push(input.dateTo); }
  const periodRows = await rows(`SELECT c.id AS currency_id, c.code AS currency_code, c.name_ar AS currency_name, c.is_base AS currency_rank,
    COALESCE(SUM(jl.debit),0) AS debit_total, COALESCE(SUM(jl.credit),0) AS credit_total, COUNT(jl.id) AS movement_count
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN currencies c ON c.id=jl.currency_id
    WHERE ${periodFilters.join(' AND ')} GROUP BY c.id,c.code,c.name_ar,c.is_base`, periodParams);
  let openingRows = [];
  if (input.dateFrom) openingRows = await rows(`SELECT c.id AS currency_id, c.code AS currency_code, c.name_ar AS currency_name, c.is_base AS currency_rank,
    COALESCE(SUM(jl.debit - jl.credit),0) AS opening_balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN currencies c ON c.id=jl.currency_id
    WHERE ${[...baseFilters, 'je.entry_date < ?'].join(' AND ')} GROUP BY c.id,c.code,c.name_ar,c.is_base`, [...baseParams, input.dateFrom]);
  const summary = new Map(periodRows.map((item) => [Number(item.currency_id), { ...item, opening_balance:0 }]));
  openingRows.forEach((item) => { const key=Number(item.currency_id); const existing=summary.get(key) || { ...item, debit_total:0, credit_total:0, movement_count:0 }; existing.opening_balance=Number(item.opening_balance || 0); summary.set(key,existing); });
  return [...summary.values()].map((item) => ({ ...item, opening_balance:Number(item.opening_balance || 0), closing_balance:Number(item.opening_balance || 0) + Number(item.debit_total || 0) - Number(item.credit_total || 0) })).sort((a,b) => Number(b.currency_rank) - Number(a.currency_rank) || String(a.currency_code).localeCompare(String(b.currency_code)));
}

async function trialBalance(input) {
  const filters = ['je.posted = TRUE'];
  const params = [];
  if (input.dateFrom) { filters.push('je.entry_date >= ?'); params.push(input.dateFrom); }
  if (input.dateTo) { filters.push('je.entry_date <= ?'); params.push(input.dateTo); }
  return rows(`SELECT a.id, a.code, a.name_ar, a.account_type,
    COALESCE(SUM(jl.debit), 0) AS debit_total, COALESCE(SUM(jl.credit), 0) AS credit_total,
    COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id=a.id
    LEFT JOIN journal_entries je ON je.id=jl.journal_id AND ${filters.join(' AND ')}
    GROUP BY a.id, a.code, a.name_ar, a.account_type ORDER BY a.code`, params);
}

async function generalJournal(input) {
  const filters = ['je.posted = TRUE'];
  const params = [];
  if (input.dateFrom) { filters.push('je.entry_date >= ?'); params.push(input.dateFrom); }
  if (input.dateTo) { filters.push('je.entry_date <= ?'); params.push(input.dateTo); }
  return rows(`SELECT je.entry_date, je.entry_no, je.description_ar, je.source_type, je.source_id,
    a.code AS account_code, a.name_ar AS account_name, c.code AS currency_code, jl.debit, jl.credit
    FROM journal_entries je JOIN journal_lines jl ON jl.journal_id=je.id
    JOIN accounts a ON a.id=jl.account_id JOIN currencies c ON c.id=jl.currency_id
    WHERE ${filters.join(' AND ')} ORDER BY je.entry_date DESC, je.id DESC, jl.id`, params);
}

async function quickEntryBalances(input) {
  const cashboxId = Number(input.cashboxId);
  const accountId = Number(input.accountId);
  const currencyId = Number(input.currencyId);
  if (!currencyId) throw new Error('اختر العملة لعرض الرصيد');
  const balanceForAccount = async (id) => {
    if (!id) return 0;
    const result = await rows(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id
      WHERE je.posted=TRUE AND jl.account_id=? AND jl.currency_id=?`, [id, currencyId]);
    return Number(result[0]?.balance || 0);
  };
  let cashAccountId = null;
  if (cashboxId) {
    const cashAccount = await rows('SELECT account_id FROM cashbox_accounts WHERE cashbox_id=? LIMIT 1', [cashboxId]);
    cashAccountId = Number(cashAccount[0]?.account_id || 0) || null;
  }
  return { cashboxBalance: await balanceForAccount(cashAccountId), accountBalance: await balanceForAccount(accountId) };
}

async function globalSearch(input) {
  const userId = await currentUserId();
  await requirePermission(userId, 'reports', 'view');
  const text = requireText(input.query, 'كلمة البحث');
  if (text.length < 2) throw new Error('اكتب حرفين على الأقل للبحث');
  const like = `%${text}%`;
  const [transfers, vouchers, exchanges, customers, accounts, currencies] = await Promise.all([
    rows(`SELECT transfer_no AS ref, CONCAT(sender_name, ' ← ', beneficiary_name) AS label, CONCAT(DATE_FORMAT(created_at,'%d/%m/%Y'),' — ',amount) AS detail, 'حوالة' AS kind, 'transfers' AS destination FROM transfers WHERE transfer_no LIKE ? OR sender_name LIKE ? OR beneficiary_name LIKE ? OR sender_phone LIKE ? OR beneficiary_phone LIKE ? OR CAST(amount AS CHAR) LIKE ? OR DATE_FORMAT(created_at,'%d/%m/%Y') LIKE ? ORDER BY id DESC LIMIT 12`, [like, like, like, like, like, like, like]),
    rows(`SELECT voucher_no AS ref, CONCAT(COALESCE(party_name,''), ' — ', amount) AS label, CONCAT(DATE_FORMAT(voucher_date,'%d/%m/%Y'),' — ',COALESCE(notes,'')) AS detail, 'سند' AS kind, 'vouchers' AS destination FROM vouchers WHERE voucher_no LIKE ? OR party_name LIKE ? OR reference_no LIKE ? OR notes LIKE ? OR CAST(amount AS CHAR) LIKE ? OR DATE_FORMAT(voucher_date,'%d/%m/%Y') LIKE ? ORDER BY id DESC LIMIT 12`, [like, like, like, like, like, like]),
    rows(`SELECT operation_no AS ref, CONCAT(COALESCE(c.full_name,''), ' — ', e.amount, ' ', cu.code) AS label, CONCAT(DATE_FORMAT(e.operation_date,'%d/%m/%Y'),' — ',COALESCE(e.notes,'')) AS detail, 'صرافة' AS kind, 'exchange' AS destination FROM exchange_operations e JOIN currencies cu ON cu.id=e.currency_id LEFT JOIN customers c ON c.id=e.customer_id WHERE e.operation_no LIKE ? OR c.full_name LIKE ? OR e.notes LIKE ? OR CAST(e.amount AS CHAR) LIKE ? OR DATE_FORMAT(e.operation_date,'%d/%m/%Y') LIKE ? ORDER BY e.id DESC LIMIT 12`, [like, like, like, like, like]),
    rows(`SELECT customer_no AS ref, CONCAT(full_name, COALESCE(CONCAT(' — ', phone), '')) AS label, CONCAT(COALESCE(identity_no,''),' — ',COALESCE(address_ar,'')) AS detail, 'عميل' AS kind, 'customers' AS destination FROM customers WHERE customer_no LIKE ? OR full_name LIKE ? OR phone LIKE ? OR identity_no LIKE ? ORDER BY id DESC LIMIT 12`, [like, like, like, like]),
    rows(`SELECT code AS ref, name_ar AS label, CONCAT(account_type,' — ',IF(active,'نشط','موقوف')) AS detail, 'حساب' AS kind, 'accounts' AS destination FROM accounts WHERE code LIKE ? OR name_ar LIKE ? ORDER BY code LIMIT 12`, [like, like]),
    rows(`SELECT code AS ref, name_ar AS label, CONCAT('شراء: ',buy_rate,' — بيع: ',sell_rate) AS detail, 'عملة' AS kind, 'currency-settings' AS destination FROM currencies WHERE code LIKE ? OR name_ar LIKE ? ORDER BY code LIMIT 12`, [like, like])
  ]);
  return [...transfers, ...vouchers, ...exchanges, ...customers, ...accounts, ...currencies].slice(0, 50);
}

async function operationalAlerts() {
  const userId = await currentUserId();
  await requirePermission(userId, 'reports', 'view');
  const [pending, drafts, variances, frozen, blockedCustomers, rateBreaches, backup] = await Promise.all([
    rows("SELECT COUNT(*) AS total FROM transfers WHERE status='pending'"),
    rows("SELECT COUNT(*) AS total FROM cash_currency_purchases WHERE status='unposted'"),
    rows('SELECT count_no, variance_amount, cashbox_id FROM cashbox_counts WHERE ABS(variance_amount) > 0.000001 ORDER BY id DESC LIMIT 20'),
    rows('SELECT code, name_ar FROM accounts WHERE is_frozen=TRUE ORDER BY code LIMIT 20'),
    rows('SELECT customer_no, full_name FROM customers WHERE is_blocked=TRUE OR active=FALSE ORDER BY id DESC LIMIT 20'),
    rows('SELECT code, name_ar, buy_rate, sell_rate, min_buy_rate, max_sell_rate FROM currencies WHERE (min_buy_rate IS NOT NULL AND buy_rate < min_buy_rate) OR (max_sell_rate IS NOT NULL AND sell_rate > max_sell_rate) LIMIT 20'),
    rows("SELECT setting_value FROM app_settings WHERE setting_key='backup_last_at' LIMIT 1")
  ]);
  const alerts = [];
  if (Number(pending[0]?.total || 0)) alerts.push({ level: 'warning', title: 'حوالات قيد الانتظار', detail: `${pending[0].total} حوالة تحتاج متابعة أو صرفًا`, destination: 'transfers' });
  if (Number(drafts[0]?.total || 0)) alerts.push({ level: 'info', title: 'مسودات شراء نقدي', detail: `${drafts[0].total} مسودة تنتظر التجميع والترحيل`, destination: 'cash-purchases' });
  variances.forEach((item) => alerts.push({ level: 'danger', title: `فرق جرد ${item.count_no}`, detail: `فرق: ${Number(item.variance_amount).toLocaleString('en-US')}`, destination: 'cashboxes' }));
  frozen.forEach((item) => alerts.push({ level: 'warning', title: `حساب مجمد: ${item.code}`, detail: item.name_ar, destination: 'financial-controls' }));
  blockedCustomers.forEach((item) => alerts.push({ level: 'warning', title: `عميل مقيد: ${item.customer_no}`, detail: item.full_name, destination: 'customers' }));
  rateBreaches.forEach((item) => alerts.push({ level: 'danger', title: `تنبيه سعر ${item.code}`, detail: `${item.name_ar} خارج الحدود المحددة`, destination: 'currency-settings' }));
  const backupAt = backup[0]?.setting_value;
  const ageHours = backupAt ? (Date.now() - new Date(backupAt).getTime()) / 36e5 : Infinity;
  if (ageHours > 24) alerts.push({ level: 'danger', title: 'نسخة احتياطية متأخرة', detail: backupAt ? `آخر نسخة منذ ${Math.floor(ageHours)} ساعة` : 'لا يوجد سجل لنسخة احتياطية حديثة', destination: 'backup-center' });
  return alerts;
}

async function managementReports() {
  const userId = await currentUserId();
  await requirePermission(userId, 'reports', 'view');
  const [byCurrency, byEmployee, byAgent, cashboxes, topCustomers, variances] = await Promise.all([
    rows(`SELECT c.code AS label, COALESCE(SUM(e.handling_fee),0) AS exchange_profit, COALESCE(SUM(e.local_value),0) AS volume
          FROM exchange_operations e JOIN currencies c ON c.id=e.currency_id WHERE e.status='posted' GROUP BY c.id, c.code ORDER BY exchange_profit DESC`),
    rows(`SELECT u.display_name AS label, COUNT(e.id) AS operation_count, COALESCE(SUM(e.handling_fee),0) AS amount
          FROM users u LEFT JOIN exchange_operations e ON e.created_by=u.id AND e.status='posted' GROUP BY u.id, u.display_name ORDER BY amount DESC LIMIT 20`),
    rows(`SELECT COALESCE(c.full_name,'بدون وكيل') AS label, COUNT(t.id) AS operation_count, COALESCE(SUM(t.commission),0) AS amount
          FROM transfers t LEFT JOIN customers c ON c.id=t.agent_id WHERE t.status<>'cancelled' GROUP BY t.agent_id, c.full_name ORDER BY amount DESC LIMIT 20`),
    rows(`SELECT cb.name_ar AS label, COALESCE(SUM(jl.debit-jl.credit),0) AS amount
          FROM cashboxes cb JOIN cashbox_accounts ca ON ca.cashbox_id=cb.id LEFT JOIN journal_lines jl ON jl.account_id=ca.account_id
          LEFT JOIN journal_entries je ON je.id=jl.journal_id AND je.posted=TRUE GROUP BY cb.id, cb.name_ar ORDER BY amount DESC`),
    rows(`SELECT c.full_name AS label, COUNT(e.id) AS operation_count, COALESCE(SUM(e.local_value),0) AS amount
          FROM customers c JOIN exchange_operations e ON e.customer_id=c.id WHERE e.status='posted' GROUP BY c.id, c.full_name ORDER BY amount DESC LIMIT 20`),
    rows(`SELECT cc.count_no AS label, cb.name_ar AS cashbox_name, cc.variance_amount AS amount, cc.count_date
          FROM cashbox_counts cc JOIN cashboxes cb ON cb.id=cc.cashbox_id WHERE ABS(cc.variance_amount)>0.000001 ORDER BY cc.id DESC LIMIT 50`)
  ]);
  return { byCurrency, byEmployee, byAgent, cashboxes, topCustomers, variances };
}

function reportDate(value, fallback) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

async function incomeExpenseReport(input = {}) {
  const userId = await currentUserId();
  await requirePermission(userId, 'reports', 'view');
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = reportDate(input.dateFrom, `${today.slice(0, 8)}01`);
  const dateTo = reportDate(input.dateTo, today);
  if (dateFrom > dateTo) throw new Error('تاريخ بداية التقرير يجب أن يسبق أو يساوي تاريخ نهايته');
  const reportRows = await rows(`SELECT a.id, a.code, a.name_ar, a.account_type,
    COALESCE(SUM(CASE WHEN a.account_type='income' THEN jl.credit-jl.debit ELSE jl.debit-jl.credit END),0) AS amount,
    COUNT(DISTINCT je.id) AS entry_count
    FROM accounts a JOIN journal_lines jl ON jl.account_id=a.id JOIN journal_entries je ON je.id=jl.journal_id
    WHERE je.posted=TRUE AND je.entry_date BETWEEN ? AND ? AND a.account_type IN ('income','expense')
    GROUP BY a.id, a.code, a.name_ar, a.account_type HAVING ABS(amount)>0.000001
    ORDER BY a.account_type, amount DESC, a.code`, [dateFrom, dateTo]);
  const income = reportRows.filter((item) => item.account_type === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expense = reportRows.filter((item) => item.account_type === 'expense').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const durationDays = Math.max(1, Math.round((new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000) + 1);
  const previousEnd = new Date(`${dateFrom}T00:00:00Z`); previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd); previousStart.setUTCDate(previousStart.getUTCDate() - durationDays + 1);
  const formatDate = (date) => date.toISOString().slice(0,10);
  const priorFrom = formatDate(previousStart); const priorTo = formatDate(previousEnd);
  const previousRows = await rows(`SELECT
    COALESCE(SUM(CASE WHEN a.account_type='income' THEN jl.credit-jl.debit ELSE 0 END),0) AS income,
    COALESCE(SUM(CASE WHEN a.account_type='expense' THEN jl.debit-jl.credit ELSE 0 END),0) AS expense
    FROM accounts a JOIN journal_lines jl ON jl.account_id=a.id JOIN journal_entries je ON je.id=jl.journal_id
    WHERE je.posted=TRUE AND je.entry_date BETWEEN ? AND ? AND a.account_type IN ('income','expense')`, [priorFrom, priorTo]);
  const previous = previousRows[0] || {};
  const previousIncome = Number(previous.income || 0); const previousExpense = Number(previous.expense || 0); const previousNet = previousIncome - previousExpense;
  return { dateFrom, dateTo, income, expense, net:income-expense, rows:reportRows, comparison:{ dateFrom:priorFrom, dateTo:priorTo, income:previousIncome, expense:previousExpense, net:previousNet, netChange:(income-expense)-previousNet } };
}

async function financialDashboard() {
  const userId = await currentUserId();
  await requirePermission(userId, 'reports', 'view');
  const today = new Date().toISOString().slice(0, 10);
  const [summaryRows, trend, recent, alerts] = await Promise.all([
    rows(`SELECT
      (SELECT COUNT(*) FROM vouchers WHERE voucher_date=? AND status='posted') AS vouchers_today,
      (SELECT COUNT(*) FROM transfers WHERE DATE(created_at)=? AND status<>'cancelled') AS transfers_today,
      (SELECT COUNT(*) FROM exchange_operations WHERE operation_date=? AND status='posted') AS exchanges_today,
      (SELECT COUNT(*) FROM journal_entries WHERE entry_date=? AND posted=TRUE) AS journals_today,
      (SELECT COUNT(*) FROM journal_entries WHERE posted=FALSE) AS journal_drafts,
      (SELECT COUNT(*) FROM (SELECT jl.journal_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id WHERE je.posted=TRUE GROUP BY jl.journal_id HAVING ABS(SUM(jl.debit)-SUM(jl.credit))>0.000001) invalid_journals) AS invalid_journals,
      (SELECT COALESCE(SUM(jl.credit-jl.debit),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE je.posted=TRUE AND je.entry_date=? AND a.account_type='income') AS income_today,
      (SELECT COALESCE(SUM(jl.debit-jl.credit),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE je.posted=TRUE AND je.entry_date=? AND a.account_type='expense') AS expense_today`, [today,today,today,today,today,today]),
    rows(`SELECT DATE(je.entry_date) AS date_key, COUNT(DISTINCT je.id) AS journal_count, COALESCE(SUM(jl.debit),0) AS debit_total, COALESCE(SUM(jl.credit),0) AS credit_total
      FROM journal_entries je LEFT JOIN journal_lines jl ON jl.journal_id=je.id WHERE je.posted=TRUE AND je.entry_date BETWEEN DATE_SUB(?, INTERVAL 6 DAY) AND ? GROUP BY DATE(je.entry_date) ORDER BY date_key`, [today,today]),
    rows('SELECT entry_no, entry_date, description_ar, source_type, created_at FROM journal_entries WHERE posted=TRUE ORDER BY id DESC LIMIT 8'),
    operationalAlerts()
  ]);
  const summary = summaryRows[0] || {};
  return { today, summary:{ ...summary, net_today:Number(summary.income_today || 0)-Number(summary.expense_today || 0) }, trend, recent, alerts:alerts.slice(0,6) };
}

function auditReadLimit(input = {}) {
  const candidate = Number(input.limit);
  const requested = Number.isFinite(candidate) ? Math.trunc(candidate) : 200;
  return Math.min(Math.max(requested, 1), 500);
}

function buildAuditTrailReadQuery(input = {}) {
  const limit = auditReadLimit(input);
  return {
    sql: `SELECT a.id, a.action_name, a.entity_name, a.entity_id, a.details_json, a.created_at, u.username, u.display_name
      FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ${limit}`,
    params: []
  };
}

function buildSecretAuditArchiveReadQuery(input = {}) {
  const limit = auditReadLimit(input);
  const text = String(input.query || '').trim();
  const filters = []; const params = [];
  if (text) { filters.push('(s.action_name LIKE ? OR s.entity_name LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)'); const like = `%${text}%`; params.push(like,like,like,like); }
  if (input.dateFrom) { filters.push('DATE(s.created_at)>=?'); params.push(input.dateFrom); }
  if (input.dateTo) { filters.push('DATE(s.created_at)<=?'); params.push(input.dateTo); }
  return {
    sql: `SELECT s.id, s.audit_id, s.action_name, s.entity_name, s.entity_id, s.before_json, s.after_json, s.integrity_hash, s.created_at, u.username, u.display_name
      FROM secret_audit_archive s LEFT JOIN users u ON u.id=s.user_id ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ${limit}`,
    params
  };
}

async function auditTrail(input = {}) {
  const userId = await currentUserId();
  await requireAdministrator(userId);
  const { sql, params } = buildAuditTrailReadQuery(input);
  return rows(sql, params);
}

async function backfillSecretAuditArchive() {
  await ensureOperationalTables();
  const missing = await rows(`SELECT a.id, a.user_id, a.action_name, a.entity_name, a.entity_id, a.details_json
    FROM audit_log a LEFT JOIN secret_audit_archive s ON s.audit_id=a.id
    WHERE s.audit_id IS NULL ORDER BY a.id ASC LIMIT 5000`);
  for (const item of missing) {
    let details = {};
    try { details = typeof item.details_json === 'string' ? JSON.parse(item.details_json || '{}') : item.details_json || {}; } catch { details = { legacy_details:String(item.details_json || '') }; }
    const before = Object.prototype.hasOwnProperty.call(details, 'before') ? details.before : null;
    const after = Object.prototype.hasOwnProperty.call(details, 'after') ? details.after : details;
    const integrityHash = crypto.createHash('sha256').update(JSON.stringify({ auditId:item.id, userId:item.user_id, action:item.action_name, entity:item.entity_name, entityId:item.entity_id || null, before, after })).digest('hex');
    await rows('INSERT IGNORE INTO secret_audit_archive (audit_id, user_id, action_name, entity_name, entity_id, before_json, after_json, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.user_id, item.action_name, item.entity_name, item.entity_id || null, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), integrityHash]);
  }
  return missing.length;
}

async function secretAuditArchive(input = {}) {
  const userId = await currentUserId();
  await requireAdministrator(userId);
  const { sql, params } = buildSecretAuditArchiveReadQuery(input);
  return rows(sql, params);
}

async function recordBackupActivity(input) {
  const mode = input.mode === 'google' ? 'Google Drive' : 'محلي';
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    const when = new Date().toISOString();
    await connection.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES ('backup_last_at', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [when]);
    await audit(connection, userId, 'backup_completed', 'app_settings', null, { mode, when });
    return { when, mode };
  });
}

async function createCheque(input) {
  const counterparty = requireText(input.counterpartyName, 'اسم الطرف');
  const amount = numberValue(input.amount, 'المبلغ');
  const currencyId = Number(input.currencyId);
  if (!currencyId) throw new Error('اختر عملة الشيك');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const chequeNo = await nextNo(connection, 'cheques');
    const type = input.chequeType === 'issued' ? 'issued' : 'received';
    const [result] = await connection.execute('INSERT INTO cheques (cheque_no, cheque_type, counterparty_name, bank_name, amount, currency_id, due_date, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [chequeNo, type, counterparty, input.bankName || null, amount, currencyId, input.dueDate || null, 'pending', input.notes || null, userId]);
    await audit(connection, userId, 'create', 'cheques', result.insertId, { chequeNo, type, amount, currencyId });
    return { id: result.insertId, chequeNo };
  });
}

async function setChequeStatus(input) {
  const chequeId = Number(input.chequeId);
  const status = ['pending', 'collected', 'returned', 'cancelled'].includes(input.status) ? input.status : 'pending';
  if (!chequeId) throw new Error('اختر الشيك');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [found] = await connection.execute('SELECT cheque_no, status FROM cheques WHERE id=? FOR UPDATE', [chequeId]);
    if (!found[0]) throw new Error('الشيك غير موجود');
    await connection.execute('UPDATE cheques SET status=? WHERE id=?', [status, chequeId]);
    await audit(connection, userId, 'status_update', 'cheques', chequeId, { chequeNo: found[0].cheque_no, before: found[0].status, after: status });
    return { id: chequeId, status };
  });
}

async function createAccount(input) {
  const name = requireText(input.nameAr, 'اسم الحساب');
  const type = ['asset', 'liability', 'equity', 'income', 'expense'].includes(input.accountType) ? input.accountType : 'asset';
  const statementCategory = ['balance_sheet', 'profit_loss'].includes(input.statementCategory) ? input.statementCategory : 'balance_sheet';
  const displayRank = Number.isFinite(Number(input.displayRank)) ? Number(input.displayRank) : 0;
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const code = await nextNo(connection, 'accounts');
    const [result] = await connection.execute('INSERT INTO accounts (code, name_ar, parent_id, account_type, statement_category, display_rank, created_by, active) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)', [code, name, input.parentId || null, type, statementCategory, displayRank, userId]);
    await audit(connection, userId, 'create', 'accounts', result.insertId, { code, name, type, statementCategory, displayRank });
    return { id: result.insertId };
  });
}

async function updateAccount(input) {
  const accountId=Number(input.accountId);
  const name=requireText(input.nameAr,'اسم الحساب');
  const type=['asset','liability','equity','income','expense'].includes(input.accountType) ? input.accountType : 'asset';
  const statementCategory=['balance_sheet','profit_loss'].includes(input.statementCategory) ? input.statementCategory : 'balance_sheet';
  const displayRank=Number.isFinite(Number(input.displayRank)) ? Number(input.displayRank) : 0;
  const parentId=Number(input.parentId || 0) || null;
  if (!Number.isInteger(accountId) || accountId<=0) throw new Error('اختر الحساب المراد تعديله');
  if (parentId===accountId) throw new Error('لا يمكن ربط الحساب بنفسه كحساب أب');
  return transaction(async (connection) => {
    const userId=await currentUserId();
    const [found]=await connection.execute('SELECT id, code, name_ar, parent_id, account_type, statement_category, display_rank FROM accounts WHERE id=? FOR UPDATE',[accountId]);
    if (!found[0]) throw new Error('الحساب غير موجود');
    if (parentId) {
      const [parents]=await connection.execute('SELECT id FROM accounts WHERE id=? AND active=TRUE FOR UPDATE',[parentId]);
      if (!parents[0]) throw new Error('الحساب الأب غير موجود أو غير نشط');
      const [children]=await connection.execute('SELECT id FROM accounts WHERE parent_id=? AND id=? LIMIT 1',[accountId,parentId]);
      if (children[0]) throw new Error('لا يمكن نقل الحساب تحت أحد حساباته الفرعية');
    }
    const code=found[0].code;
    await connection.execute('UPDATE accounts SET name_ar=?, parent_id=?, account_type=?, statement_category=?, display_rank=? WHERE id=?',[name,parentId,type,statementCategory,displayRank,accountId]);
    await audit(connection,userId,'update','accounts',accountId,{ before:found[0], after:{ code,name,parentId,type,statementCategory,displayRank } });
    return { id:accountId };
  });
}

async function deleteAccount(input) {
  const accountId=Number(input.accountId);
  if (!Number.isInteger(accountId) || accountId<=0) throw new Error('اختر الحساب المراد حذفه');
  return transaction(async (connection) => {
    const userId=await currentUserId();
    const [found]=await connection.execute('SELECT id, code, name_ar FROM accounts WHERE id=? FOR UPDATE',[accountId]);
    if (!found[0]) throw new Error('الحساب غير موجود');
    const checks=await Promise.all([
      connection.execute('SELECT COUNT(*) AS total FROM accounts WHERE parent_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM journal_lines WHERE account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM cashbox_accounts WHERE account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM customer_cashbox_links WHERE account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM employees WHERE account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM vouchers WHERE counter_account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM transfers WHERE counter_account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM exchange_operations WHERE branch_account_id=?',[accountId]),
      connection.execute('SELECT COUNT(*) AS total FROM cashbox_counts WHERE counter_account_id=?',[accountId])
    ]);
    if (checks.some(([items]) => Number(items[0]?.total || 0)>0)) throw new Error('لا يمكن حذف الحساب لأنه مرتبط بحسابات فرعية أو قيود أو عمليات أو صناديق');
    await connection.execute('DELETE FROM accounts WHERE id=?',[accountId]);
    await audit(connection,userId,'delete','accounts',accountId,{ before:found[0] });
    return { id:accountId };
  });
}

async function createCurrency(input) {
  const code = requireText(input.code, 'رمز العملة').toUpperCase();
  const name = requireText(input.nameAr, 'اسم العملة');
  const buyRate = numberValue(input.buyRate, 'سعر الشراء', true);
  const sellRate = numberValue(input.sellRate, 'سعر البيع', true);
  const transferRate = (buyRate + sellRate) / 2;
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const minBuyRate = input.minBuyRate === '' || input.minBuyRate == null ? null : numberValue(input.minBuyRate, 'الحد الأدنى للشراء', true);
    const maxSellRate = input.maxSellRate === '' || input.maxSellRate == null ? null : numberValue(input.maxSellRate, 'الحد الأعلى للبيع', true);
    if (minBuyRate != null && maxSellRate != null && minBuyRate > maxSellRate) throw new Error('الحد الأدنى لا يمكن أن يتجاوز الحد الأعلى');
    const [result] = await connection.execute('INSERT INTO currencies (code, name_ar, is_base, buy_rate, sell_rate, transfer_rate, min_buy_rate, max_sell_rate, active) VALUES (?, ?, FALSE, ?, ?, ?, ?, ?, TRUE)', [code, name, buyRate, sellRate, transferRate, minBuyRate, maxSellRate]);
    await audit(connection, userId, 'create', 'currencies', result.insertId, { code, name, minBuyRate, maxSellRate });
    return { id: result.insertId };
  });
}

async function updateCurrency(input) {
  const currencyId = Number(input.currencyId);
  if (!Number.isInteger(currencyId) || currencyId <= 0) throw new Error('اختر العملة المراد تعديلها');
  const name = requireText(input.nameAr, 'اسم العملة');
  const buyRate = numberValue(input.buyRate, 'سعر الشراء', true);
  const sellRate = numberValue(input.sellRate, 'سعر البيع', true);
  const transferRate = (buyRate + sellRate) / 2;
  const minBuyRate = input.minBuyRate === '' || input.minBuyRate == null ? null : numberValue(input.minBuyRate, 'الحد الأدنى للشراء', true);
  const maxSellRate = input.maxSellRate === '' || input.maxSellRate == null ? null : numberValue(input.maxSellRate, 'الحد الأعلى للبيع', true);
  if (minBuyRate != null && maxSellRate != null && minBuyRate > maxSellRate) throw new Error('الحد الأدنى لا يمكن أن يتجاوز الحد الأعلى');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [found] = await connection.execute('SELECT id, code FROM currencies WHERE id = ? FOR UPDATE', [currencyId]);
    if (!found[0]) throw new Error('العملة غير موجودة');
    await connection.execute('UPDATE currencies SET name_ar = ?, buy_rate = ?, sell_rate = ?, transfer_rate = ?, min_buy_rate = ?, max_sell_rate = ? WHERE id = ?', [name, buyRate, sellRate, transferRate, minBuyRate, maxSellRate, currencyId]);
    await audit(connection, userId, 'update', 'currencies', currencyId, { code: found[0].code, name, buyRate, sellRate, transferRate, minBuyRate, maxSellRate });
    return { id: currencyId };
  });
}

async function setCurrencyActive(input) {
  const currencyId = Number(input.currencyId);
  if (!Number.isInteger(currencyId) || currencyId <= 0) throw new Error('اختر العملة المراد تغيير حالتها');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [found] = await connection.execute('SELECT id, code, is_base FROM currencies WHERE id = ? FOR UPDATE', [currencyId]);
    if (!found[0]) throw new Error('العملة غير موجودة');
    if (found[0].is_base && input.active === false) throw new Error('لا يمكن إيقاف العملة الأساسية للنظام');
    const active = input.active !== false;
    await connection.execute('UPDATE currencies SET active = ? WHERE id = ?', [active, currencyId]);
    await audit(connection, userId, active ? 'activate' : 'deactivate', 'currencies', currencyId, { code: found[0].code, active });
    return { id: currencyId, active };
  });
}

async function createCustomer(input) {
  const name = requireText(input.fullName, 'اسم العميل أو الوكيل');
  const type = ['customer', 'agent', 'supplier'].includes(input.customerType) ? input.customerType : 'customer';
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const customerNo = await nextNo(connection, 'customers');
    const limit = input.maxTransactionAmount === '' || input.maxTransactionAmount == null ? null : numberValue(input.maxTransactionAmount, 'سقف تعامل العميل', true);
    const blocked = input.isBlocked === true;
    const [result] = await connection.execute('INSERT INTO customers (customer_no, full_name, phone, address_ar, customer_type, identity_no, notes, max_transaction_amount, is_blocked, block_reason, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)', [customerNo, name, input.phone || null, input.addressAr || null, type, input.identityNo || null, input.notes || null, limit, blocked ? 1 : 0, blocked ? requireText(input.blockReason, 'سبب الحظر') : null]);
    await audit(connection, userId, 'create', 'customers', result.insertId, { customerNo, name, type });
    return { id: result.insertId, customerNo };
  });
}

async function createCustomerCashboxLink(input) {
  const existingCustomerId = Number(input.customerId || 0);
  const cashboxId = Number(input.cashboxId || 0);
  if (!cashboxId) throw new Error('اختر الصندوق المراد ربطه بالعميل');
  const customerType = ['customer', 'agent', 'supplier'].includes(input.customerType) ? input.customerType : 'customer';
  const accountType = ['asset', 'liability'].includes(input.accountType) ? input.accountType : 'asset';
  const statementCategory = ['balance_sheet', 'profit_loss'].includes(input.statementCategory) ? input.statementCategory : 'balance_sheet';
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requirePermission(userId, 'accounts', 'add');
    const [cashboxes] = await connection.execute('SELECT id FROM cashboxes WHERE id=? AND active=TRUE FOR UPDATE', [cashboxId]);
    if (!cashboxes[0]) throw new Error('الصندوق غير نشط أو غير موجود');
    let customerId = existingCustomerId;
    let customerName = '';
    if (customerId) {
      const [customers] = await connection.execute('SELECT id, full_name FROM customers WHERE id=? AND active=TRUE FOR UPDATE', [customerId]);
      if (!customers[0]) throw new Error('العميل المختار غير نشط أو غير موجود');
      customerName = customers[0].full_name;
    } else {
      customerName = requireText(input.fullName, 'اسم العميل');
      const customerNo = await nextNo(connection, 'customers');
      const [created] = await connection.execute('INSERT INTO customers (customer_no, full_name, phone, address_ar, customer_type, active) VALUES (?, ?, ?, ?, ?, TRUE)', [customerNo, customerName, input.phone || null, input.addressAr || null, customerType]);
      customerId = created.insertId;
    }
    const [existingLinks] = await connection.execute('SELECT account_id FROM customer_cashbox_links WHERE customer_id=? FOR UPDATE', [customerId]);
    let accountId = Number(existingLinks[0]?.account_id || 0);
    if (!accountId) {
      const accountCode = await nextNo(connection, 'accounts');
      const accountName = String(input.accountName || `حساب ${customerName}`).trim();
      const parentId = Number(input.parentAccountId || 0) || null;
      const [account] = await connection.execute('INSERT INTO accounts (code, name_ar, parent_id, account_type, statement_category, display_rank, created_by, active) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)', [accountCode, accountName, parentId, accountType, statementCategory, Number(input.displayRank || 0), userId]);
      accountId = account.insertId;
    }
    await connection.execute('INSERT INTO customer_cashbox_links (customer_id, cashbox_id, account_id, created_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE cashbox_id=VALUES(cashbox_id), account_id=VALUES(account_id)', [customerId, cashboxId, accountId, userId]);
    await audit(connection, userId, 'link_customer_cashbox', 'customers', customerId, { cashboxId, accountId, customerName });
    return { customerId, cashboxId, accountId };
  });
}

async function updateCustomerProfile(input) {
  const customerId = Number(input.customerId);
  if (!customerId) throw new Error('اختر العميل المراد تعديله');
  const fullName = requireText(input.fullName, 'اسم العميل');
  const limit = input.maxTransactionAmount === '' || input.maxTransactionAmount == null ? null : numberValue(input.maxTransactionAmount, 'سقف تعامل العميل', true);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [foundRows] = await connection.execute('SELECT full_name, phone, address_ar, identity_no, notes, max_transaction_amount, is_blocked, block_reason, active FROM customers WHERE id=? FOR UPDATE', [customerId]);
    const before = foundRows[0];
    if (!before) throw new Error('العميل غير موجود');
    const blocked = input.isBlocked === true;
    const blockReason = blocked ? requireText(input.blockReason, 'سبب الحظر') : null;
    await connection.execute('UPDATE customers SET full_name=?, phone=?, address_ar=?, identity_no=?, notes=?, max_transaction_amount=?, is_blocked=?, block_reason=? WHERE id=?', [fullName, input.phone || null, input.addressAr || null, input.identityNo || null, input.notes || null, limit, blocked ? 1 : 0, blockReason, customerId]);
    const after = { fullName, phone: input.phone || null, addressAr: input.addressAr || null, identityNo: input.identityNo || null, notes: input.notes || null, maxTransactionAmount: limit, isBlocked: blocked, blockReason };
    await audit(connection, userId, 'update_profile', 'customers', customerId, { before, after });
    return { id: customerId };
  });
}

async function ensureCustomerAllowed(connection, customerId, amount) {
  if (!customerId) return;
  const [customers] = await connection.execute('SELECT active, is_blocked, max_transaction_amount FROM customers WHERE id=?', [customerId]);
  const customer = customers[0];
  if (!customer || !customer.active) throw new Error('العميل غير نشط أو غير موجود');
  if (customer.is_blocked) throw new Error('العميل محظور ولا يسمح له بإجراء عمليات');
  if (customer.max_transaction_amount != null && Number(amount) > Number(customer.max_transaction_amount)) throw new Error(`المبلغ يتجاوز سقف تعامل العميل (${customer.max_transaction_amount})`);
}

async function createCashbox(input) {
  const name = requireText(input.nameAr, 'اسم الصندوق');
  const branchId = Number(input.branchId || 1);
  const accountId = Number(input.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('اختر الحساب المحاسبي المرتبط بالصندوق');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [sequence] = await connection.execute('SELECT COALESCE(MAX(cashbox_no),0)+1 AS next_no FROM cashboxes');
    const cashboxNo=Number(sequence[0]?.next_no || 1);
    const [result] = await connection.execute('INSERT INTO cashboxes (cashbox_no, branch_id, user_id, name_ar, active) VALUES (?, ?, ?, ?, TRUE)', [cashboxNo, branchId, userId, name]);
    await connection.execute('INSERT INTO cashbox_accounts (cashbox_id, account_id) VALUES (?, ?)', [result.insertId, accountId]);
    await audit(connection, userId, 'create', 'cashboxes', result.insertId, { cashboxNo, name, accountId });
    return { id: result.insertId, cashboxNo };
  });
}

async function updateCashbox(input) {
  const cashboxId=Number(input.cashboxId);
  const name=requireText(input.nameAr,'اسم الصندوق');
  const accountId=Number(input.accountId);
  if (!Number.isInteger(cashboxId) || cashboxId<=0) throw new Error('اختر الصندوق المراد تعديله');
  if (!Number.isInteger(accountId) || accountId<=0) throw new Error('اختر الحساب المحاسبي المرتبط بالصندوق');
  return transaction(async (connection) => {
    const userId=await currentUserId();
    const [found]=await connection.execute('SELECT cb.id, cb.cashbox_no, cb.name_ar, cb.active, ca.account_id FROM cashboxes cb LEFT JOIN cashbox_accounts ca ON ca.cashbox_id=cb.id WHERE cb.id=? FOR UPDATE',[cashboxId]);
    if (!found[0]) throw new Error('الصندوق غير موجود');
    const [accounts]=await connection.execute("SELECT id FROM accounts WHERE id=? AND account_type='asset' AND active=TRUE FOR UPDATE",[accountId]);
    if (!accounts[0]) throw new Error('اختر حساب أصول نشطًا لربط الصندوق');
    const active=input.active !== false;
    await connection.execute('UPDATE cashboxes SET name_ar=?, active=? WHERE id=?',[name,active,cashboxId]);
    await connection.execute('INSERT INTO cashbox_accounts (cashbox_id,account_id) VALUES (?,?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id)',[cashboxId,accountId]);
    await audit(connection,userId,'update','cashboxes',cashboxId,{ before:found[0], after:{ name,accountId,active } });
    return { id:cashboxId };
  });
}

async function deleteCashbox(input) {
  const cashboxId=Number(input.cashboxId);
  if (!Number.isInteger(cashboxId) || cashboxId<=0) throw new Error('اختر الصندوق المراد حذفه');
  return transaction(async (connection) => {
    const userId=await currentUserId();
    const [found]=await connection.execute('SELECT id, cashbox_no, name_ar FROM cashboxes WHERE id=? FOR UPDATE',[cashboxId]);
    if (!found[0]) throw new Error('الصندوق غير موجود');
    const checks=await Promise.all([
      connection.execute('SELECT COUNT(*) AS total FROM vouchers WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM cashbox_counts WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM customer_cashbox_links WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM transfer_payouts WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM exchange_operations WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM cash_currency_purchases WHERE cashbox_id=?',[cashboxId]),
      connection.execute('SELECT COUNT(*) AS total FROM cash_purchase_totals WHERE cashbox_id=?',[cashboxId])
    ]);
    if (checks.some(([items]) => Number(items[0]?.total || 0)>0)) throw new Error('لا يمكن حذف الصندوق لأنه مرتبط بسندات أو جرد أو حوالات أو عمليات مالية');
    await connection.execute('DELETE FROM cashbox_accounts WHERE cashbox_id=?',[cashboxId]);
    await connection.execute('DELETE FROM cashboxes WHERE id=?',[cashboxId]);
    await audit(connection,userId,'delete','cashboxes',cashboxId,{ before:found[0] });
    return { id:cashboxId };
  });
}

async function createCashboxCount(input) {
  const cashboxId = Number(input.cashboxId);
  const actualAmount = numberValue(input.actualAmount, 'المبلغ الفعلي في الصندوق', true);
  const counterAccountId = Number(input.counterAccountId || 0);
  const countDate = input.countDate || new Date().toISOString().slice(0, 10);
  if (!cashboxId) throw new Error('اختر الصندوق المراد جرده');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await ensurePostingDateOpen(connection, countDate);
    const [cashboxes] = await connection.execute('SELECT ca.account_id, cb.name_ar FROM cashboxes cb JOIN cashbox_accounts ca ON ca.cashbox_id=cb.id WHERE cb.id=? AND cb.active=TRUE FOR UPDATE', [cashboxId]);
    const cashbox = cashboxes[0];
    if (!cashbox) throw new Error('الصندوق غير موجود أو غير مرتبط بحساب محاسبي');
    const [balanceRows] = await connection.execute(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS balance
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id
      WHERE jl.account_id=? AND je.posted=TRUE`, [cashbox.account_id]);
    const bookAmount = Number(balanceRows[0]?.balance || 0);
    const variance = actualAmount - bookAmount;
    if (Math.abs(variance) > 0.000001 && !counterAccountId) throw new Error('اختر الحساب المقابل لمعالجة فرق الجرد');
    if (counterAccountId) await ensureAccountAllowed(connection, counterAccountId, Math.abs(variance));
    const countNo = await nextNo(connection, 'cashbox_counts');
    const [count] = await connection.execute(`INSERT INTO cashbox_counts
      (count_no,cashbox_id,count_date,book_amount,actual_amount,variance_amount,counter_account_id,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`, [countNo, cashboxId, countDate, bookAmount, actualAmount, variance, counterAccountId || null, input.notes || null, userId]);
    let journalId = null;
    if (Math.abs(variance) > 0.000001) {
      const [baseRows] = await connection.execute('SELECT id FROM currencies WHERE is_base=TRUE LIMIT 1');
      if (!baseRows[0]) throw new Error('لا توجد عملة أساسية للنظام');
      const journal = await createBalancedJournal(connection, {
        amount: Math.abs(variance),
        debitAccountId: variance > 0 ? cashbox.account_id : counterAccountId,
        creditAccountId: variance > 0 ? counterAccountId : cashbox.account_id,
        currencyId: baseRows[0].id,
        entryDate: countDate,
        description: input.notes || `تسوية فرق جرد الصندوق ${cashbox.name_ar} ${countNo}`,
        sourceType: 'cashbox_count', sourceId: count.insertId, userId
      });
      journalId = journal.journalId;
      await connection.execute('UPDATE cashbox_counts SET journal_id=? WHERE id=?', [journalId, count.insertId]);
    }
    await audit(connection, userId, 'cashbox_count', 'cashbox_counts', count.insertId, { countNo, cashboxId, bookAmount, actualAmount, variance, journalId });
    return { id: count.insertId, countNo, bookAmount, actualAmount, variance, journalId };
  });
}

async function createUser(input) {
  const username = requireText(input.username, 'اسم المستخدم');
  const displayName = requireText(input.displayName, 'الاسم الظاهر');
  const password = requireText(input.password, 'كلمة المرور');
  if (password.length < 8) throw new Error('كلمة المرور يجب أن تتكون من 8 أحرف على الأقل');
  const roleName = requireText(input.roleName || 'مستخدم', 'المجموعة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const passwordHash = `scrypt$${salt}$${hash}`;
    const [result] = await connection.execute('INSERT INTO users (username, password_hash, display_name, role_name, active) VALUES (?, ?, ?, ?, TRUE)', [username, passwordHash, displayName, roleName]);
    await audit(connection, userId, 'create', 'users', result.insertId, { username, displayName, roleName });
    return { id: result.insertId, username };
  });
}

async function setUserActive(input) {
  const targetId = Number(input.userId);
  if (!targetId) throw new Error('اختر المستخدم');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    if (targetId === userId && input.active === false) throw new Error('لا يمكن حجب المستخدم الإداري الحالي');
    await connection.execute('UPDATE users SET active = ? WHERE id = ?', [input.active ? 1 : 0, targetId]);
    await audit(connection, userId, input.active ? 'activate' : 'block', 'users', targetId, {});
    return { id: targetId, active: Boolean(input.active) };
  });
}

async function saveUserDevice(input) {
  const targetId = Number(input.userId), deviceName = requireText(input.deviceName, 'اسم الجهاز');
  if (!targetId) throw new Error('اختر المستخدم');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute('INSERT INTO user_devices (user_id, device_name, allowed) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE allowed=VALUES(allowed), last_seen_at=NOW()', [targetId, deviceName, input.allowed === false ? 0 : 1]);
    await audit(connection, userId, 'device_access_update', 'users', targetId, { deviceName, allowed: input.allowed !== false });
    return { userId: targetId, deviceName };
  });
}

async function setUserDeviceRestriction(input) {
  const targetId = Number(input.userId);
  if (!targetId) throw new Error('اختر المستخدم');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute('UPDATE users SET device_restricted = ? WHERE id = ?', [input.restricted ? 1 : 0, targetId]);
    await audit(connection, userId, 'device_restriction', 'users', targetId, { restricted: Boolean(input.restricted) });
    return { userId: targetId, restricted: Boolean(input.restricted) };
  });
}

async function saveUserPermission(input) {
  const targetId = Number(input.userId);
  const moduleKey = requireText(input.moduleKey, 'الوحدة');
  if (!targetId) throw new Error('اختر المستخدم');
  const flags = ['canAdd', 'canEdit', 'canDelete', 'canPost', 'canPrint', 'canView'];
  const values = flags.map((key) => input[key] ? 1 : 0);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute('INSERT INTO user_permissions (user_id, module_key, can_add, can_edit, can_delete, can_post, can_print, can_view) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE can_add=VALUES(can_add), can_edit=VALUES(can_edit), can_delete=VALUES(can_delete), can_post=VALUES(can_post), can_print=VALUES(can_print), can_view=VALUES(can_view)', [targetId, moduleKey, ...values]);
    await audit(connection, userId, 'permissions_update', 'user_permissions', targetId, { moduleKey, ...input });
    return { userId: targetId, moduleKey };
  });
}

async function createEmployee(input) {
  const fullName = requireText(input.fullName, 'اسم الموظف');
  const salary = numberValue(input.monthlySalary || 0, 'الراتب', true);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const employeeNo = await nextNo(connection, 'employees');
    const [result] = await connection.execute('INSERT INTO employees (employee_no, full_name, phone, job_title, monthly_salary, account_id, active) VALUES (?, ?, ?, ?, ?, ?, TRUE)', [employeeNo, fullName, input.phone || null, input.jobTitle || null, salary, input.accountId || null]);
    await audit(connection, userId, 'create', 'employees', result.insertId, { employeeNo, fullName, salary });
    return { id: result.insertId, employeeNo };
  });
}

async function createUserGroup(input) {
  const groupName = requireText(input.groupName, 'اسم المجموعة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    const [result] = await connection.execute('INSERT INTO user_groups (group_name, description_ar, active) VALUES (?, ?, TRUE)', [groupName, input.descriptionAr || null]);
    await audit(connection, userId, 'create', 'user_groups', result.insertId, { groupName });
    return { id: result.insertId, groupName };
  });
}

async function saveGroupPermission(input) {
  const groupId = Number(input.groupId), moduleKey = requireText(input.moduleKey, 'الوحدة');
  if (!groupId) throw new Error('اختر المجموعة');
  const flags = ['canAdd', 'canEdit', 'canDelete', 'canPost', 'canPrint', 'canView'];
  const values = flags.map((key) => input[key] ? 1 : 0);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute('INSERT INTO group_permissions (group_id, module_key, can_add, can_edit, can_delete, can_post, can_print, can_view) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE can_add=VALUES(can_add), can_edit=VALUES(can_edit), can_delete=VALUES(can_delete), can_post=VALUES(can_post), can_print=VALUES(can_print), can_view=VALUES(can_view)', [groupId, moduleKey, ...values]);
    await audit(connection, userId, 'permissions_update', 'group_permissions', groupId, { moduleKey, ...input });
    return { groupId, moduleKey };
  });
}

async function setAccountControl(input) {
  const accountId = Number(input.accountId);
  if (!accountId) throw new Error('اختر الحساب');
  const maxAmount = input.maxTransactionAmount === '' || input.maxTransactionAmount == null ? null : numberValue(input.maxTransactionAmount, 'سقف الحركة', true);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute('UPDATE accounts SET is_frozen = ?, freeze_reason = ?, max_transaction_amount = ? WHERE id = ?', [input.frozen ? 1 : 0, input.frozen ? requireText(input.freezeReason, 'سبب التجميد') : null, maxAmount, accountId]);
    await audit(connection, userId, input.frozen ? 'freeze' : 'unfreeze', 'accounts', accountId, { maxAmount, reason: input.freezeReason || null });
    return { accountId, frozen: Boolean(input.frozen), maxAmount };
  });
}

async function setTransferLimit(input) {
  const limit = input.maxTransferAmount === '' || input.maxTransferAmount == null ? 0 : numberValue(input.maxTransferAmount, 'سقف الحوالة', true);
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES ('max_transfer_amount', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [String(limit)]);
    await audit(connection, userId, 'settings_update', 'app_settings', null, { key: 'max_transfer_amount', limit });
    return { maxTransferAmount: limit };
  });
}

async function setDatePostingPolicy(input) {
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    const value = input.preventPastPosting ? 'true' : 'false';
    await connection.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES ('prevent_past_posting', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [value]);
    await audit(connection, userId, 'settings_update', 'app_settings', null, { key: 'prevent_past_posting', value });
    return { preventPastPosting: input.preventPastPosting === true };
  });
}

async function closeFinancialPeriod(input) {
  const periodName = requireText(input.periodName, 'اسم الفترة');
  const dateFrom = requireText(input.dateFrom, 'من تاريخ'), dateTo = requireText(input.dateTo, 'إلى تاريخ');
  if (dateFrom > dateTo) throw new Error('تاريخ بداية الفترة يجب أن يسبق تاريخ نهايتها');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    const [result] = await connection.execute("INSERT INTO financial_periods (period_name, date_from, date_to, status, closed_by, closed_at, notes) VALUES (?, ?, ?, 'closed', ?, NOW(), ?)", [periodName, dateFrom, dateTo, userId, input.notes || null]);
    await audit(connection, userId, 'close', 'financial_periods', result.insertId, { periodName, dateFrom, dateTo });
    return { id: result.insertId, periodName };
  });
}

async function reopenFinancialPeriod(input) {
  const periodId = Number(input.periodId);
  if (!periodId) throw new Error('اختر الفترة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await requireAdministrator(userId);
    await connection.execute("UPDATE financial_periods SET status='open', closed_by=NULL, closed_at=NULL WHERE id = ?", [periodId]);
    await audit(connection, userId, 'reopen', 'financial_periods', periodId, {});
    return { id: periodId };
  });
}

async function createTransfer(input) {
  const sender = requireText(input.senderName, 'اسم المرسل');
  const beneficiary = requireText(input.beneficiaryName, 'اسم المستفيد');
  const amount = numberValue(input.amount, 'المبلغ');
  const currencyId = Number(input.currencyId);
  const cashboxId = Number(input.cashboxId), counterAccountId = Number(input.counterAccountId);
  if (!currencyId || !cashboxId || !counterAccountId) throw new Error('اختر العملة والصندوق والحساب المقابل');
  const transferType = input.transferType === 'incoming' ? 'incoming' : 'outgoing';
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const number = await nextNo(connection, 'transfers');
    await enforceTransferLimit(connection, amount);
    const [cashboxAccounts] = await connection.execute('SELECT account_id FROM cashbox_accounts WHERE cashbox_id = ?', [cashboxId]);
    if (!cashboxAccounts[0]) throw new Error('الصندوق غير مرتبط بحساب محاسبي');
    await ensureAccountAllowed(connection, counterAccountId, amount);
    const [result] = await connection.execute('INSERT INTO transfers (transfer_no, transfer_type, sender_name, sender_phone, beneficiary_name, beneficiary_phone, amount, currency_id, commission, agent_id, counter_account_id, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [number, transferType, sender, input.senderPhone || null, beneficiary, input.beneficiaryPhone || null, amount, currencyId, Number(input.commission || 0), input.agentId || null, counterAccountId, 'pending', input.notes || null, userId]);
    const cashAccountId = cashboxAccounts[0].account_id;
    const journal = await createBalancedJournal(connection, { amount, debitAccountId: transferType === 'incoming' ? cashAccountId : counterAccountId, creditAccountId: transferType === 'incoming' ? counterAccountId : cashAccountId, currencyId, entryDate: input.transferDate, description: input.notes || `حوالة ${transferType === 'incoming' ? 'واردة' : 'صادرة'} ${number}`, sourceType: 'transfer', sourceId: result.insertId, userId });
    await connection.execute('INSERT INTO transfer_journals (transfer_id, journal_id) VALUES (?, ?)', [result.insertId, journal.journalId]);
    await audit(connection, userId, 'create_post', 'transfers', result.insertId, { number, transferType, amount, currencyId, journalNo: journal.entryNo });
    return { id: result.insertId, transferNo: number, journalNo: journal.entryNo };
  });
}

async function nextNo(connection, tableName) {
  const sequenceColumns={ accounts:'code', customers:'customer_no', employees:'employee_no', vouchers:'voucher_no', transfers:'transfer_no', journal_entries:'entry_no', cashbox_counts:'count_no', exchange_operations:'operation_no', cash_currency_purchases:'purchase_no', cash_purchase_totals:'total_no', cheques:'cheque_no', transfer_payouts:'payout_no' };
  const column=sequenceColumns[tableName];
  if (!column) throw new Error('جدول الترقيم غير معتمد');
  const [sequence] = await connection.execute(`SELECT COALESCE(MAX(CAST(\`${column}\` AS UNSIGNED)), 0) + 1 AS next_no FROM \`${tableName}\``);
  return String(sequence[0].next_no);
}

async function createBalancedJournal(connection, input) {
  const amount = numberValue(input.amount, 'المبلغ');
  const debitAccountId = Number(input.debitAccountId);
  const creditAccountId = Number(input.creditAccountId);
  const currencyId = Number(input.currencyId);
  if (!debitAccountId || !creditAccountId || debitAccountId === creditAccountId || !currencyId) throw new Error('اختر حسابين مختلفين وعملة صحيحة للقيد');
  const userId = input.userId || await currentUserId();
  await ensurePostingDateOpen(connection, input.entryDate);
  await ensureAccountAllowed(connection, debitAccountId, amount);
  await ensureAccountAllowed(connection, creditAccountId, amount);
  const entryNo = await nextNo(connection, 'journal_entries');
  const [entry] = await connection.execute('INSERT INTO journal_entries (entry_no, entry_date, description_ar, source_type, source_id, posted, created_by) VALUES (?, ?, ?, ?, ?, FALSE, ?)', [entryNo, input.entryDate || new Date().toISOString().slice(0, 10), input.description || null, input.sourceType || 'manual', input.sourceId || null, userId]);
  const rate = Number(input.exchangeRate || 1);
  await connection.execute('INSERT INTO journal_lines (journal_id, account_id, currency_id, exchange_rate, debit, credit, notes) VALUES (?, ?, ?, ?, ?, 0, ?), (?, ?, ?, ?, 0, ?, ?)', [entry.insertId, debitAccountId, currencyId, rate, amount, input.description || null, entry.insertId, creditAccountId, currencyId, rate, amount, input.description || null]);
  await connection.execute('CALL post_journal_entry(?)', [entry.insertId]);
  return { journalId: entry.insertId, entryNo };
}

async function payoutTransfer(input) {
  const transferId = Number(input.transferId), cashboxId = Number(input.cashboxId);
  if (!transferId || !cashboxId) throw new Error('اختر الحوالة والصندوق');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [transferRows] = await connection.execute('SELECT id, transfer_no, transfer_type, amount, currency_id, counter_account_id, status FROM transfers WHERE id = ? FOR UPDATE', [transferId]);
    const transfer = transferRows[0];
    if (!transfer) throw new Error('الحوالة غير موجودة');
    if (transfer.transfer_type !== 'incoming') throw new Error('صرف الحوالة متاح للحوالات الواردة فقط');
    if (transfer.status !== 'pending') throw new Error('لا يمكن صرف حوالة ليست قيد الانتظار');
    const [cashboxAccounts] = await connection.execute('SELECT account_id FROM cashbox_accounts WHERE cashbox_id = ?', [cashboxId]);
    if (!cashboxAccounts[0] || !transfer.counter_account_id) throw new Error('الصندوق أو الحساب المقابل غير مهيأ');
    const payoutNo = await nextNo(connection, 'transfer_payouts');
    const [payout] = await connection.execute('INSERT INTO transfer_payouts (payout_no, transfer_id, payout_date, cashbox_id, amount, receiver_name, receiver_id_no, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [payoutNo, transferId, input.payoutDate || new Date().toISOString().slice(0, 10), cashboxId, transfer.amount, input.receiverName || null, input.receiverIdNo || null, input.notes || null, userId]);
    const journal = await createBalancedJournal(connection, { amount: transfer.amount, debitAccountId: transfer.counter_account_id, creditAccountId: cashboxAccounts[0].account_id, currencyId: transfer.currency_id, entryDate: input.payoutDate, description: input.notes || `صرف حوالة واردة ${transfer.transfer_no}`, sourceType: 'transfer_payout', sourceId: payout.insertId, userId });
    await connection.execute("UPDATE transfer_payouts SET journal_id = ? WHERE id = ?", [journal.journalId, payout.insertId]);
    await connection.execute("UPDATE transfers SET status = 'completed' WHERE id = ?", [transferId]);
    await audit(connection, userId, 'payout_post', 'transfers', transferId, { payoutNo, journalNo: journal.entryNo, cashboxId });
    return { id: payout.insertId, payoutNo, journalNo: journal.entryNo };
  });
}

async function cancelTransfer(input) {
  const transferId = Number(input.transferId);
  if (!transferId) throw new Error('اختر الحوالة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [transferRows] = await connection.execute('SELECT t.id, t.transfer_no, t.status, tj.journal_id FROM transfers t LEFT JOIN transfer_journals tj ON tj.transfer_id=t.id WHERE t.id = ? FOR UPDATE', [transferId]);
    const transfer = transferRows[0];
    if (!transfer) throw new Error('الحوالة غير موجودة');
    if (transfer.status !== 'pending') throw new Error('لا يمكن إلغاء حوالة مكتملة أو ملغاة');
    const [lines] = await connection.execute('SELECT account_id, currency_id, debit, credit FROM journal_lines WHERE journal_id = ? ORDER BY id', [transfer.journal_id]);
    const debitLine = lines.find((line) => Number(line.debit) > 0), creditLine = lines.find((line) => Number(line.credit) > 0);
    if (!debitLine || !creditLine) throw new Error('تعذر العثور على قيد الحوالة الأصلي');
    const journal = await createBalancedJournal(connection, { amount: debitLine.debit, debitAccountId: creditLine.account_id, creditAccountId: debitLine.account_id, currencyId: debitLine.currency_id, entryDate: input.cancelDate, description: input.notes || `قيد عكسي لإلغاء حوالة ${transfer.transfer_no}`, sourceType: 'transfer_cancel', sourceId: transferId, userId });
    await connection.execute("UPDATE transfers SET status = 'cancelled' WHERE id = ?", [transferId]);
    await audit(connection, userId, 'cancel_post', 'transfers', transferId, { journalNo: journal.entryNo, reason: input.notes || null });
    return { id: transferId, journalNo: journal.entryNo };
  });
}

async function createVoucher(input) {
  const voucherType = input.voucherType === 'payment' ? 'payment' : 'receipt';
  const amount = numberValue(input.amount, 'المبلغ');
  const cashboxId = Number(input.cashboxId), counterAccountId = Number(input.counterAccountId), currencyId = Number(input.currencyId);
  if (!cashboxId || !counterAccountId || !currencyId) throw new Error('اختر الصندوق والحساب المقابل والعملة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [cashboxAccounts] = await connection.execute('SELECT account_id FROM cashbox_accounts WHERE cashbox_id = ?', [cashboxId]);
    if (!cashboxAccounts[0]) throw new Error('الصندوق غير مرتبط بحساب محاسبي');
    const voucherNo = await nextNo(connection, 'vouchers');
    const [voucher] = await connection.execute('INSERT INTO vouchers (voucher_no, voucher_type, voucher_date, cashbox_id, counter_account_id, currency_id, amount, party_name, handler_name, reference_no, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [voucherNo, voucherType, input.voucherDate || new Date().toISOString().slice(0, 10), cashboxId, counterAccountId, currencyId, amount, input.partyName || null, input.handlerName || null, null, input.notes || null, 'draft', userId]);
    const cashAccountId = cashboxAccounts[0].account_id;
    const journal = await createBalancedJournal(connection, { amount, debitAccountId: voucherType === 'receipt' ? cashAccountId : counterAccountId, creditAccountId: voucherType === 'receipt' ? counterAccountId : cashAccountId, currencyId, entryDate: input.voucherDate, description: input.notes || `${voucherType === 'receipt' ? 'سند قبض' : 'سند صرف'} ${voucherNo}`, sourceType: 'voucher', sourceId: voucher.insertId, userId });
    await connection.execute('UPDATE vouchers SET journal_id = ?, status = ? WHERE id = ?', [journal.journalId, 'posted', voucher.insertId]);
    await audit(connection, userId, 'create_post', 'vouchers', voucher.insertId, { voucherNo, journalNo: journal.entryNo, amount });
    return { id: voucher.insertId, voucherNo, journalNo: journal.entryNo };
  });
}

async function cancelVoucher(input) {
  const voucherId = Number(input.voucherId);
  if (!Number.isInteger(voucherId) || voucherId <= 0) throw new Error('اختر السند المراد إلغاؤه');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [voucherRows] = await connection.execute('SELECT id, voucher_no, status, journal_id FROM vouchers WHERE id = ? FOR UPDATE', [voucherId]);
    const voucher = voucherRows[0];
    if (!voucher) throw new Error('السند غير موجود');
    if (voucher.status !== 'posted') throw new Error('لا يمكن إلغاء سند غير مرحل أو ملغى سابقًا');
    const [lines] = await connection.execute('SELECT account_id, currency_id, debit, credit FROM journal_lines WHERE journal_id = ? ORDER BY id', [voucher.journal_id]);
    const debitLine = lines.find((line) => Number(line.debit) > 0);
    const creditLine = lines.find((line) => Number(line.credit) > 0);
    if (!debitLine || !creditLine) throw new Error('تعذر العثور على قيد السند الأصلي');
    const journal = await createBalancedJournal(connection, { amount: debitLine.debit, debitAccountId: creditLine.account_id, creditAccountId: debitLine.account_id, currencyId: debitLine.currency_id, entryDate: input.cancelDate || new Date().toISOString().slice(0, 10), description: input.notes || `قيد عكسي لإلغاء سند ${voucher.voucher_no}`, sourceType: 'voucher_cancel', sourceId: voucherId, userId });
    await connection.execute("UPDATE vouchers SET status = 'cancelled' WHERE id = ?", [voucherId]);
    await audit(connection, userId, 'cancel_post', 'vouchers', voucherId, { voucherNo: voucher.voucher_no, journalNo: journal.entryNo, reason: input.notes || null });
    return { id: voucherId, journalNo: journal.entryNo };
  });
}

async function createSimpleEntry(input) {
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const journal = await createBalancedJournal(connection, { amount: input.amount, debitAccountId: input.debitAccountId, creditAccountId: input.creditAccountId, currencyId: input.currencyId, entryDate: input.entryDate, description: input.description || 'قيد بسيط', sourceType: 'simple_entry', userId });
    await audit(connection, userId, 'create_post', 'journal_entries', journal.journalId, { entryNo: journal.entryNo });
    return journal;
  });
}

async function createOpeningBalance(input) {
  const debit = Number(input.debit || 0), credit = Number(input.credit || 0);
  if ((!debit && !credit) || (debit && credit)) throw new Error('أدخل مبلغًا في المدين أو الدائن فقط');
  const accountId = Number(input.accountId), counterAccountId = Number(input.counterAccountId), currencyId = Number(input.currencyId);
  if (!accountId || !counterAccountId || !currencyId) throw new Error('اختر الحساب والحساب المقابل والعملة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const journal = await createBalancedJournal(connection, { amount: debit || credit, debitAccountId: debit ? accountId : counterAccountId, creditAccountId: debit ? counterAccountId : accountId, currencyId, entryDate: input.entryDate, description: input.description || 'رصيد افتتاحي', sourceType: 'opening_balance', userId });
    await audit(connection, userId, 'create_post', 'opening_balance', journal.journalId, { entryNo: journal.entryNo });
    return journal;
  });
}

async function createExchange(input) {
  const type = input.operationType === 'buy' ? 'buy' : 'sell';
  const amount = numberValue(input.amount, 'المبلغ بالعملة'), dealRate = numberValue(input.dealRate, 'سعر الصرف'), transferRate = dealRate;
  const handling = numberValue(input.handlingFee || 0, 'المناولة', true);
  const cashboxId = Number(input.cashboxId), counterAccountId = Number(input.counterAccountId), currencyId = Number(input.currencyId);
  if (!cashboxId || !counterAccountId || !currencyId) throw new Error('اختر الصندوق والحساب المقابل والعملة');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    await ensureCustomerAllowed(connection, Number(input.customerId || 0), amount);
    const [currencyRows] = await connection.execute('SELECT min_buy_rate, max_sell_rate FROM currencies WHERE id = ?', [currencyId]);
    const bounds = currencyRows[0];
    if (type === 'buy' && bounds?.min_buy_rate != null && dealRate < Number(bounds.min_buy_rate)) throw new Error(`سعر الشراء أقل من الحد المعتمد (${bounds.min_buy_rate})`);
    if (type === 'sell' && bounds?.max_sell_rate != null && dealRate > Number(bounds.max_sell_rate)) throw new Error(`سعر البيع أعلى من الحد المعتمد (${bounds.max_sell_rate})`);
    const [cashboxAccounts] = await connection.execute('SELECT account_id FROM cashbox_accounts WHERE cashbox_id = ?', [cashboxId]);
    if (!cashboxAccounts[0]) throw new Error('الصندوق غير مرتبط بحساب محاسبي');
    const localValue = amount * dealRate + handling, operationNo = await nextNo(connection, 'exchange_operations');
    const [operation] = await connection.execute('INSERT INTO exchange_operations (operation_no, operation_type, operation_date, customer_id, branch_account_id, cashbox_id, currency_id, amount, transfer_rate, deal_rate, local_value, handling_fee, payment_mode, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [operationNo, type, input.operationDate || new Date().toISOString().slice(0, 10), input.customerId || null, counterAccountId, cashboxId, currencyId, amount, transferRate, dealRate, localValue, handling, 'cash', 'draft', input.notes || null, userId]);
    const [base] = await connection.execute('SELECT id FROM currencies WHERE is_base = TRUE LIMIT 1');
    const journal = await createBalancedJournal(connection, { amount: localValue, debitAccountId: type === 'buy' ? cashboxAccounts[0].account_id : counterAccountId, creditAccountId: type === 'buy' ? counterAccountId : cashboxAccounts[0].account_id, currencyId: base[0].id, entryDate: input.operationDate, description: input.notes || `${type === 'buy' ? 'شراء' : 'بيع'} عملة ${operationNo}`, sourceType: 'exchange', sourceId: operation.insertId, userId });
    await connection.execute('UPDATE exchange_operations SET journal_id = ?, voucher_no = ?, status = ? WHERE id = ?', [journal.journalId, journal.entryNo, 'posted', operation.insertId]);
    await audit(connection, userId, 'create_post', 'exchange_operations', operation.insertId, { operationNo, journalNo: journal.entryNo, localValue });
    return { id: operation.insertId, operationNo, journalNo: journal.entryNo };
  });
}

async function createCashPurchase(input) {
  const amount = numberValue(input.amount, 'المبلغ'), purchaseRate = numberValue(input.purchaseRate, 'سعر الشراء');
  const cashboxId = Number(input.cashboxId), currencyId = Number(input.currencyId);
  if (!cashboxId || !currencyId) throw new Error('اختر الصندوق والعملة');
  return transaction(async (connection) => {
    const userId = await currentUserId(), purchaseNo = await nextNo(connection, 'cash_currency_purchases');
    const [purchase] = await connection.execute('INSERT INTO cash_currency_purchases (purchase_no, purchase_date, customer_name, cashbox_id, currency_id, amount, purchase_rate, local_value, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [purchaseNo, input.purchaseDate || new Date().toISOString().slice(0, 10), input.customerName || null, cashboxId, currencyId, amount, purchaseRate, amount * purchaseRate, 'unposted', input.notes || null, userId]);
    await audit(connection, userId, 'create', 'cash_currency_purchases', purchase.insertId, { purchaseNo });
    return { id: purchase.insertId, purchaseNo };
  });
}

async function postCashPurchaseTotals(input) {
  const cashboxId = Number(input.cashboxId), currencyId = Number(input.currencyId), counterAccountId = Number(input.counterAccountId);
  if (!cashboxId || !currencyId || !counterAccountId) throw new Error('اختر الصندوق والعملة والحساب المقابل');
  return transaction(async (connection) => {
    const userId = await currentUserId();
    const [cashboxAccounts] = await connection.execute('SELECT account_id FROM cashbox_accounts WHERE cashbox_id = ?', [cashboxId]);
    if (!cashboxAccounts[0]) throw new Error('الصندوق غير مرتبط بحساب محاسبي');
    const where = ['cashbox_id = ?', 'currency_id = ?', "status = 'unposted'"];
    const params = [cashboxId, currencyId];
    if (input.dateFrom) { where.push('purchase_date >= ?'); params.push(input.dateFrom); }
    if (input.dateTo) { where.push('purchase_date <= ?'); params.push(input.dateTo); }
    const [purchases] = await connection.execute(`SELECT id, amount, local_value FROM cash_currency_purchases WHERE ${where.join(' AND ')} FOR UPDATE`, params);
    if (!purchases.length) throw new Error('لا توجد مسودات شراء نقدي مطابقة للتجميع');
    const foreignTotal = purchases.reduce((sum, item) => sum + Number(item.amount), 0);
    const localTotal = purchases.reduce((sum, item) => sum + Number(item.local_value), 0);
    const totalNo = await nextNo(connection, 'cash_purchase_totals');
    const [total] = await connection.execute('INSERT INTO cash_purchase_totals (total_no, total_date, cashbox_id, currency_id, operation_count, foreign_total, local_total, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [totalNo, input.totalDate || new Date().toISOString().slice(0, 10), cashboxId, currencyId, purchases.length, foreignTotal, localTotal, 'draft', userId]);
    const [base] = await connection.execute('SELECT id FROM currencies WHERE is_base = TRUE LIMIT 1');
    const journal = await createBalancedJournal(connection, { amount: localTotal, debitAccountId: counterAccountId, creditAccountId: cashboxAccounts[0].account_id, currencyId: base[0].id, entryDate: input.totalDate, description: `تجميع شراء نقدي ${totalNo}`, sourceType: 'cash_purchase_total', sourceId: total.insertId, userId });
    await connection.execute('UPDATE cash_purchase_totals SET journal_id = ?, status = ? WHERE id = ?', [journal.journalId, 'posted', total.insertId]);
    await connection.execute(`UPDATE cash_currency_purchases SET status = 'aggregated' WHERE id IN (${purchases.map(() => '?').join(',')})`, purchases.map((item) => item.id));
    await audit(connection, userId, 'aggregate_post', 'cash_purchase_totals', total.insertId, { totalNo, operationCount: purchases.length, journalNo: journal.entryNo });
    return { id: total.insertId, totalNo, journalNo: journal.entryNo };
  });
}

const handlers = { login, getSession, logout, verifyAdministratorPassword, changeOwnPassword, requestManagerPasswordRecovery, completeManagerPasswordRecovery, bootstrap, getCoreDirectories, accountStatement, accountStatementSummary, trialBalance, generalJournal, quickEntryBalances, globalSearch, operationalAlerts, managementReports, incomeExpenseReport, financialDashboard, auditTrail, secretAuditArchive, recordBackupActivity, createCheque, setChequeStatus, createAccount, updateAccount, deleteAccount, createCurrency, updateCurrency, setCurrencyActive, createCustomer, createCustomerCashboxLink, updateCustomerProfile, createCashbox, updateCashbox, deleteCashbox, createCashboxCount, createUser, setUserActive, saveUserDevice, setUserDeviceRestriction, saveUserPermission, createEmployee, createUserGroup, saveGroupPermission, setAccountControl, setTransferLimit, setDatePostingPolicy, closeFinancialPeriod, reopenFinancialPeriod, createTransfer, payoutTransfer, cancelTransfer, createVoucher, cancelVoucher, createSimpleEntry, createOpeningBalance, createExchange, createCashPurchase, postCashPurchaseTotals };

async function execute(operation, input) {
  const handler = handlers[operation];
  if (!handler) throw new Error('عملية قاعدة البيانات غير مسموحة');
  const protectedOperations = {
    accountStatement: ['reports', 'view'], accountStatementSummary: ['reports', 'view'], trialBalance: ['reports', 'view'], generalJournal: ['reports', 'view'], globalSearch: ['reports', 'view'], operationalAlerts: ['reports', 'view'], managementReports: ['reports', 'view'], incomeExpenseReport: ['reports', 'view'], financialDashboard: ['reports', 'view'], auditTrail: ['audit', 'view'], secretAuditArchive: ['audit', 'view'],
    createAccount: ['accounts', 'add'], updateAccount: ['accounts', 'edit'], deleteAccount: ['accounts', 'delete'], createCurrency: ['exchange', 'add'], updateCurrency: ['exchange', 'edit'], setCurrencyActive: ['exchange', 'delete'], createCustomer: ['customers', 'add'], createCustomerCashboxLink: ['customers', 'add'], updateCustomerProfile: ['customers', 'edit'], createCashbox: ['cashboxes', 'add'], updateCashbox: ['cashboxes', 'edit'], deleteCashbox: ['cashboxes', 'delete'], createCashboxCount: ['cashboxes', 'post'], createEmployee: ['employees', 'add'], createCheque: ['cheques', 'add'], setChequeStatus: ['cheques', 'edit'],
    quickEntryBalances: ['vouchers', 'add'], createTransfer: ['transfers', 'add'], payoutTransfer: ['transfers', 'post'], cancelTransfer: ['transfers', 'delete'],
    createVoucher: ['vouchers', 'add'], cancelVoucher: ['vouchers', 'delete'], createSimpleEntry: ['accounts', 'post'], createOpeningBalance: ['accounts', 'post'],
    createExchange: ['exchange', 'add'], createCashPurchase: ['exchange', 'add'], postCashPurchaseTotals: ['exchange', 'post']
  };
  if (protectedOperations[operation]) {
    const [moduleKey, capability] = protectedOperations[operation];
    await requirePermission(await currentUserId(), moduleKey, capability);
  }
  return handler(input || {});
}

module.exports = { execute, _test: { verifyPassword, loadBootstrapData, auditReadLimit, buildAuditTrailReadQuery, buildSecretAuditArchiveReadQuery } };

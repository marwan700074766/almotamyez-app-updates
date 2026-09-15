CREATE DATABASE IF NOT EXISTS sarafa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sarafa;

CREATE TABLE currencies (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(10) NOT NULL UNIQUE, name_ar VARCHAR(100) NOT NULL, is_base BOOLEAN NOT NULL DEFAULT FALSE, buy_rate DECIMAL(18,6) NOT NULL DEFAULT 1, sell_rate DECIMAL(18,6) NOT NULL DEFAULT 1, transfer_rate DECIMAL(18,6) NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE accounts (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE, name_ar VARCHAR(150) NOT NULL, parent_id INT NULL, account_type ENUM('asset','liability','equity','income','expense') NOT NULL, statement_category VARCHAR(40) NOT NULL DEFAULT 'balance_sheet', display_rank INT NOT NULL DEFAULT 0, created_by INT NULL, created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, active BOOLEAN NOT NULL DEFAULT TRUE, FOREIGN KEY(parent_id) REFERENCES accounts(id));
CREATE TABLE branches (id INT AUTO_INCREMENT PRIMARY KEY, name_ar VARCHAR(150) NOT NULL, code VARCHAR(30) NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, display_name VARCHAR(150) NOT NULL, role_name VARCHAR(80) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, last_login DATETIME NULL);
CREATE TABLE cashboxes (id INT AUTO_INCREMENT PRIMARY KEY, branch_id INT NOT NULL, name_ar VARCHAR(120) NOT NULL, user_id INT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, FOREIGN KEY(branch_id) REFERENCES branches(id), FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, customer_no VARCHAR(40) NOT NULL UNIQUE, full_name VARCHAR(180) NOT NULL, phone VARCHAR(40), address_ar VARCHAR(220), customer_type ENUM('customer','agent','supplier') NOT NULL DEFAULT 'customer', identity_no VARCHAR(80) NULL, notes TEXT NULL, max_transaction_amount DECIMAL(20,6) NULL, is_blocked BOOLEAN NOT NULL DEFAULT FALSE, block_reason VARCHAR(255) NULL, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE transfers (id BIGINT AUTO_INCREMENT PRIMARY KEY, transfer_no VARCHAR(50) NOT NULL UNIQUE, transfer_type ENUM('outgoing','incoming') NOT NULL, sender_name VARCHAR(180) NOT NULL, sender_phone VARCHAR(40), beneficiary_name VARCHAR(180) NOT NULL, beneficiary_phone VARCHAR(40), amount DECIMAL(20,6) NOT NULL, currency_id INT NOT NULL, commission DECIMAL(20,6) NOT NULL DEFAULT 0, agent_id INT NULL, status ENUM('draft','pending','completed','cancelled') NOT NULL DEFAULT 'draft', notes TEXT, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(currency_id) REFERENCES currencies(id), FOREIGN KEY(agent_id) REFERENCES customers(id), FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE journal_entries (id BIGINT AUTO_INCREMENT PRIMARY KEY, entry_no VARCHAR(50) NOT NULL UNIQUE, entry_date DATE NOT NULL, description_ar VARCHAR(255), source_type VARCHAR(50), source_id BIGINT NULL, posted BOOLEAN NOT NULL DEFAULT FALSE, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE journal_lines (id BIGINT AUTO_INCREMENT PRIMARY KEY, journal_id BIGINT NOT NULL, account_id INT NOT NULL, currency_id INT NOT NULL, exchange_rate DECIMAL(20,6) NOT NULL DEFAULT 1, debit DECIMAL(20,6) NOT NULL DEFAULT 0, credit DECIMAL(20,6) NOT NULL DEFAULT 0, notes TEXT, FOREIGN KEY(journal_id) REFERENCES journal_entries(id), FOREIGN KEY(account_id) REFERENCES accounts(id), FOREIGN KEY(currency_id) REFERENCES currencies(id));
CREATE TABLE audit_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, action_name VARCHAR(80) NOT NULL, entity_name VARCHAR(80) NOT NULL, entity_id BIGINT NULL, details_json JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE secret_audit_archive (id BIGINT AUTO_INCREMENT PRIMARY KEY, audit_id BIGINT NOT NULL UNIQUE, user_id INT NULL, action_name VARCHAR(100) NOT NULL, entity_name VARCHAR(100) NOT NULL, entity_id BIGINT NULL, before_json JSON NULL, after_json JSON NULL, integrity_hash CHAR(64) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_secret_archive_created (created_at), INDEX idx_secret_archive_entity (entity_name, entity_id), FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE cheques (id BIGINT AUTO_INCREMENT PRIMARY KEY, cheque_no VARCHAR(80) NOT NULL UNIQUE, cheque_type ENUM('received','issued') NOT NULL, counterparty_name VARCHAR(180) NOT NULL, bank_name VARCHAR(180) NULL, amount DECIMAL(20,6) NOT NULL, currency_id INT NOT NULL, due_date DATE NULL, status ENUM('pending','collected','returned','cancelled') NOT NULL DEFAULT 'pending', notes TEXT NULL, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(currency_id) REFERENCES currencies(id), FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE vouchers (id BIGINT AUTO_INCREMENT PRIMARY KEY, voucher_no VARCHAR(50) NOT NULL UNIQUE, voucher_type ENUM('receipt','payment') NOT NULL, voucher_date DATE NOT NULL, cashbox_id INT NOT NULL, counter_account_id INT NOT NULL, currency_id INT NOT NULL, amount DECIMAL(20,6) NOT NULL, party_name VARCHAR(180) NULL, handler_name VARCHAR(180) NULL, reference_no VARCHAR(80) NULL, notes TEXT NULL, journal_id BIGINT NULL, status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft', created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id), FOREIGN KEY(counter_account_id) REFERENCES accounts(id), FOREIGN KEY(currency_id) REFERENCES currencies(id), FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE app_settings (setting_key VARCHAR(80) PRIMARY KEY, setting_value TEXT NOT NULL);

INSERT INTO currencies(code,name_ar,is_base,buy_rate,sell_rate,transfer_rate) VALUES ('YER','ريال يمني',TRUE,1,1,1),('USD','دولار أمريكي',FALSE,535,540,537),('SAR','ريال سعودي',FALSE,140,142,141);
INSERT INTO branches(name_ar,code) VALUES ('الفرع الرئيسي','MAIN');
INSERT INTO users(username,password_hash,display_name,role_name) VALUES ('admin','CHANGE_ME','مدير النظام','مدراء النظام');
INSERT INTO app_settings(setting_key,setting_value) VALUES ('base_currency','YER'),('fiscal_year','2026'),('company_name','مؤسسة الصرافة الحديثة');

DELIMITER $$
CREATE PROCEDURE post_journal_entry(IN p_journal_id BIGINT)
BEGIN
  DECLARE v_debit DECIMAL(30,6);
  DECLARE v_credit DECIMAL(30,6);
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO v_debit, v_credit FROM journal_lines WHERE journal_id = p_journal_id;
  IF v_debit <> v_credit THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'لا يمكن ترحيل القيد: مجموع المدين لا يساوي مجموع الدائن';
  END IF;
  UPDATE journal_entries SET posted = TRUE WHERE id = p_journal_id;
END$$
DELIMITER ;


-- عمليات بيع وشراء العملات وفق دورة الصرافة
CREATE TABLE IF NOT EXISTS exchange_operations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  operation_no VARCHAR(32) NOT NULL UNIQUE,
  operation_type ENUM('sell','buy') NOT NULL,
  operation_date DATE NOT NULL,
  customer_id INT NULL,
  branch_account_id INT NULL,
  cashbox_id INT NULL,
  currency_id INT NOT NULL,
  amount DECIMAL(20,6) NOT NULL,
  transfer_rate DECIMAL(20,6) NOT NULL,
  deal_rate DECIMAL(20,6) NOT NULL,
  local_value DECIMAL(20,6) NOT NULL,
  handling_fee DECIMAL(20,6) NOT NULL DEFAULT 0,
  payment_mode ENUM('cash','account') NOT NULL DEFAULT 'cash',
  voucher_no VARCHAR(32) NULL,
  journal_id BIGINT NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  notes TEXT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(currency_id) REFERENCES currencies(id),
  FOREIGN KEY(created_by) REFERENCES users(id),
  INDEX idx_exchange_date (operation_date),
  INDEX idx_exchange_status (status)
);

-- عمليات الشراء النقدي الصغيرة قبل إنشاء الإجمالي اليومي
CREATE TABLE IF NOT EXISTS cash_currency_purchases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  purchase_no VARCHAR(32) NOT NULL UNIQUE,
  purchase_date DATE NOT NULL,
  customer_name VARCHAR(180) NULL,
  cashbox_id INT NOT NULL,
  currency_id INT NOT NULL,
  amount DECIMAL(20,6) NOT NULL,
  purchase_rate DECIMAL(20,6) NOT NULL,
  local_value DECIMAL(20,6) NOT NULL,
  status ENUM('unposted','aggregated','cancelled') NOT NULL DEFAULT 'unposted',
  notes TEXT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id),
  FOREIGN KEY(currency_id) REFERENCES currencies(id),
  FOREIGN KEY(created_by) REFERENCES users(id),
  INDEX idx_cash_purchase_date (purchase_date),
  INDEX idx_cash_purchase_status (status)
);

CREATE TABLE IF NOT EXISTS cash_purchase_totals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  total_no VARCHAR(32) NOT NULL UNIQUE,
  total_date DATE NOT NULL,
  cashbox_id INT NOT NULL,
  currency_id INT NOT NULL,
  operation_count INT NOT NULL DEFAULT 0,
  foreign_total DECIMAL(20,6) NOT NULL DEFAULT 0,
  local_total DECIMAL(20,6) NOT NULL DEFAULT 0,
  journal_id BIGINT NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id),
  FOREIGN KEY(currency_id) REFERENCES currencies(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- صلاحيات تفصيلية لكل مستخدم على مستوى الشاشة والإجراء
CREATE TABLE IF NOT EXISTS user_permissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  can_add BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  can_post BOOLEAN NOT NULL DEFAULT FALSE,
  can_print BOOLEAN NOT NULL DEFAULT FALSE,
  can_view BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_user_module (user_id, module_key),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- حوكمة محلية: المجموعات والأجهزة والفترات المالية
CREATE TABLE IF NOT EXISTS user_groups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_name VARCHAR(80) NOT NULL UNIQUE,
  description_ar VARCHAR(255) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_permissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  can_add BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  can_post BOOLEAN NOT NULL DEFAULT FALSE,
  can_print BOOLEAN NOT NULL DEFAULT FALSE,
  can_view BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_group_module (group_id, module_key),
  FOREIGN KEY(group_id) REFERENCES user_groups(id)
);

CREATE TABLE IF NOT EXISTS user_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  device_name VARCHAR(150) NOT NULL,
  device_token VARCHAR(120) NULL,
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_device (user_id, device_name),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS financial_periods (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  period_name VARCHAR(120) NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_by INT NULL,
  closed_at DATETIME NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_period_dates (date_from, date_to),
  FOREIGN KEY(closed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transfer_payouts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payout_no VARCHAR(50) NOT NULL UNIQUE,
  transfer_id BIGINT NOT NULL,
  payout_date DATE NOT NULL,
  cashbox_id INT NOT NULL,
  amount DECIMAL(20,6) NOT NULL,
  receiver_name VARCHAR(180) NULL,
  receiver_id_no VARCHAR(80) NULL,
  notes TEXT NULL,
  journal_id BIGINT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transfer_payout (transfer_id),
  FOREIGN KEY(transfer_id) REFERENCES transfers(id),
  FOREIGN KEY(cashbox_id) REFERENCES cashboxes(id),
  FOREIGN KEY(journal_id) REFERENCES journal_entries(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

ALTER TABLE currencies ADD COLUMN IF NOT EXISTS min_buy_rate DECIMAL(18,6) NULL;
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS max_sell_rate DECIMAL(18,6) NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS freeze_reason VARCHAR(255) NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_transaction_amount DECIMAL(20,6) NULL;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS counter_account_id INT NULL;

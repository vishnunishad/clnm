require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./config/db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const employeeRoutes = require('./routes/employee');

const excelRoutes     = require('./routes/excel');
const aprRoutes       = require('./routes/apr');
const { debugResendEnvironment } = require('./utils/mailer');


const { loginLimiter, apiLimiter } = require('./middleware/rateLimit');
const scheduler = require('./utils/scheduler');

const app = express();

// Trust the reverse proxy on VPS/Nginx so req.ip and secure cookies behave correctly
app.set('trust proxy', 1);

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function getAllowedOrigins() {
  const localOrigins = [
    'http://localhost:5000',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080'
  ];

  const configuredOrigins = [process.env.ALLOWED_ORIGIN, process.env.FRONTEND_BASE_URL]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map(normalizeOrigin)
    .filter(Boolean);

  return [...new Set([...localOrigins, ...configuredOrigins])];
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (allowedOrigins.includes(origin)) return true;

  try {
    const hostname = new URL(origin).hostname;
    return hostname.endsWith('.netlify.app') || hostname.endsWith('.onrender.com');
  } catch {
    return false;
  }
}

// ── Middleware ──────────────────────────────────────────────────
const allowedOrigins = getAllowedOrigins();

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);

    if (isAllowedOrigin(origin, allowedOrigins)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Security Headers ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;");
  next();
});

// Serve uploaded documents
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Fallback to database-stored uploads if file is missing on local disk
app.get('/uploads/*', async (req, res, next) => {
  try {
    const dbFilePath = decodeURIComponent(req.path);
    const [rows] = await db.query(
      'SELECT file_name, file_data FROM documents WHERE file_path = ? LIMIT 1',
      [dbFilePath]
    );

    if (rows.length > 0 && rows[0].file_data) {
      const { file_name, file_data } = rows[0];
      const ext = path.extname(file_name).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.pdf') contentType = 'application/pdf';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webp') contentType = 'image/webp';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${file_name}"`);
      return res.send(file_data);
    }

    return res.status(404).send('Not Found');
  } catch (err) {
    console.error('Error serving fallback upload from database:', err.message);
    next(err);
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Apply rate limiting to API routes before handlers
app.use('/api/', apiLimiter);

// ── API Routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/employee', employeeRoutes);

app.use('/api/excel',      excelRoutes);
app.use('/api/apr',        aprRoutes);
app.use('/api/profile', require('./routes/profile'));
app.use('/uploads/profile_pics', express.static(path.join(__dirname, 'uploads', 'profile_pics')));
app.use('/uploads/kyc_docs', express.static(path.join(__dirname, 'uploads', 'kyc_docs')));

// ── SPA Fallback (serve login page for unknown routes) ──────────
app.get('*', (req, res) => {
  // Only for non-API and non-uploads routes
  if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  } else {
    res.status(404).send('Not Found');
  }
});

// ── Global Error Handler ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

// ── Start Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

async function ensureDefaultAdminAccount() {
  const adminEmail = 'dixitlendingsolution@gmail.com';
  const legacyAdminEmail = 'admin@cln.com';

  try {
    const [existingTarget] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [adminEmail]);
    if (existingTarget.length > 0) return;

    const [legacyAdmin] = await db.query('SELECT id FROM users WHERE email = ? AND role = ? LIMIT 1', [legacyAdminEmail, 'admin']);
    if (legacyAdmin.length === 0) return;

    await db.query('UPDATE users SET email = ? WHERE id = ?', [adminEmail, legacyAdmin[0].id]);
    console.log(`Updated admin login email from ${legacyAdminEmail} to ${adminEmail}`);
  } catch (err) {
    console.error('Failed to ensure default admin account:', err.message);
  }
}

async function ensurePasswordResetTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_password_reset_user_id (user_id),
      INDEX idx_password_reset_expires_at (expires_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;

  try {
    await db.query(sql);
  } catch (err) {
    console.error('Failed to ensure password reset table:', err.message);
  }
}

async function ensureDocumentsTable() {
  const allowedDocTypes = [
    'Aadhar',
    'PAN',
    'Passport',
    'Driving License',
    '3M Bank Statement',
    '3M Salary Slip',
    'Other'
  ];

  const enumValues = allowedDocTypes.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');

  try {
    await db.query(`ALTER TABLE documents MODIFY doc_type ENUM(${enumValues}) NOT NULL`);

    const [passwordColumn] = await db.query("SHOW COLUMNS FROM documents LIKE 'document_password'");
    if (passwordColumn.length === 0) {
      await db.query('ALTER TABLE documents ADD COLUMN document_password VARCHAR(255) NULL AFTER doc_type');
    }

    const [fileDataColumn] = await db.query("SHOW COLUMNS FROM documents LIKE 'file_data'");
    if (fileDataColumn.length === 0) {
      await db.query('ALTER TABLE documents ADD COLUMN file_data LONGBLOB NULL');
      console.log("Added 'file_data' column to 'documents' table successfully.");
    }
  } catch (err) {
    console.error('Failed to ensure documents table schema:', err.message);
  }
}

async function ensureLoansTable() {
  try {
    // 1. Modify status to VARCHAR(50)
    await db.query(`ALTER TABLE loans MODIFY status VARCHAR(50) NOT NULL DEFAULT 'Pending'`);
    console.log("Modified loans status column to VARCHAR(50).");

    // 2. Add login_date, system_upload_date, disbursement_date columns if not exists
    const [cols] = await db.query("SHOW COLUMNS FROM loans");
    const colNames = cols.map(c => c.Field);

    if (!colNames.includes('login_date')) {
      await db.query('ALTER TABLE loans ADD COLUMN login_date DATE NULL');
      // Set existing loans login_date to DATE(created_at)
      await db.query('UPDATE loans SET login_date = DATE(created_at) WHERE login_date IS NULL');
      console.log("Added column 'login_date' to loans.");
    }
    if (!colNames.includes('system_upload_date')) {
      await db.query('ALTER TABLE loans ADD COLUMN system_upload_date DATE NULL');
      // Set existing loans system_upload_date to DATE(created_at)
      await db.query('UPDATE loans SET system_upload_date = DATE(created_at) WHERE system_upload_date IS NULL');
      console.log("Added column 'system_upload_date' to loans.");
    }
    if (!colNames.includes('disbursement_date')) {
      await db.query('ALTER TABLE loans ADD COLUMN disbursement_date DATE NULL');
      // Set existing loans disbursement_date to DATE(created_at) if status is 'Loan Disbursed'
      await db.query("UPDATE loans SET disbursement_date = DATE(created_at) WHERE disbursement_date IS NULL AND status = 'Loan Disbursed'");
      console.log("Added column 'disbursement_date' to loans.");
    }
    if (!colNames.includes('disbursement_amount')) {
      await db.query('ALTER TABLE loans ADD COLUMN disbursement_amount DECIMAL(15,2) NULL');
      console.log("Added column 'disbursement_amount' to loans.");
    }

    // 3. Create loan_history table
    await db.query(`
      CREATE TABLE IF NOT EXISTS loan_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        loan_id INT NOT NULL,
        status VARCHAR(50) NOT NULL,
        remark TEXT NULL,
        updated_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("Ensured 'loan_history' table exists.");

    const [histCols] = await db.query("SHOW COLUMNS FROM loan_history");
    const histColNames = histCols.map(c => c.Field);
    if (!histColNames.includes('disbursement_date')) {
      await db.query('ALTER TABLE loan_history ADD COLUMN disbursement_date DATE NULL');
      console.log("Added column 'disbursement_date' to loan_history.");
    }
    if (!histColNames.includes('disbursement_amount')) {
      await db.query('ALTER TABLE loan_history ADD COLUMN disbursement_amount DECIMAL(15,2) NULL');
      console.log("Added column 'disbursement_amount' to loan_history.");
    }

    // 4. Populate initial loan_history for existing loans if empty
    const [historyRows] = await db.query('SELECT COUNT(*) AS count FROM loan_history');
    if (historyRows[0].count === 0) {
      const [existingLoans] = await db.query('SELECT id, status, notes, applied_by, created_at FROM loans');
      for (const loan of existingLoans) {
        await db.query(
          'INSERT INTO loan_history (loan_id, status, remark, updated_by, created_at) VALUES (?, ?, ?, ?, ?)',
          [loan.id, loan.status, loan.notes || 'Application created.', loan.applied_by, loan.created_at]
        );
      }
      console.log("Seeded initial loan_history from existing loans.");
    }
  } catch (err) {
    console.error('Failed to ensure loans table schema:', err.message);
  }
}

async function ensureWhatsAppTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_connections (
          id INT AUTO_INCREMENT PRIMARY KEY,
          status VARCHAR(50) NOT NULL DEFAULT 'Disconnected',
          device_name VARCHAR(100) NULL,
          device_phone VARCHAR(20) NULL,
          qr_code TEXT NULL,
          session_id VARCHAR(100) NULL,
          session_created_at TIMESTAMP NULL,
          last_connected_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to existing tables if upgrading
    const newColumns = [
      { col: 'session_id',         def: 'VARCHAR(100) NULL AFTER qr_code' },
      { col: 'session_created_at', def: 'TIMESTAMP NULL AFTER session_id' },
    ];
    for (const { col, def } of newColumns) {
      const [cols] = await db.query(`SHOW COLUMNS FROM whatsapp_connections LIKE '${col}'`);
      if (cols.length === 0) {
        await db.query(`ALTER TABLE whatsapp_connections ADD COLUMN ${col} ${def}`);
      }
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_templates (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(150) NOT NULL UNIQUE,
          category VARCHAR(100) NOT NULL,
          content TEXT NOT NULL,
          created_by INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          type VARCHAR(50) NOT NULL,
          template_id INT NOT NULL,
          audience_area VARCHAR(100) NULL,
          scheduled_at DATETIME NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'Draft',
          sent_count INT NOT NULL DEFAULT 0,
          delivered_count INT NOT NULL DEFAULT 0,
          read_count INT NOT NULL DEFAULT 0,
          failed_count INT NOT NULL DEFAULT 0,
          created_by INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_name VARCHAR(100) NOT NULL,
          phone VARCHAR(20) NOT NULL,
          content TEXT NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'Sent',
          direction VARCHAR(20) NOT NULL DEFAULT 'Outgoing',
          attachment_path VARCHAR(500) NULL,
          attachment_name VARCHAR(255) NULL,
          employee_id INT NULL,
          campaign_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (campaign_id) REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL
      )
    `);

    const [existing] = await db.query('SELECT id FROM whatsapp_templates LIMIT 1');
    if (existing.length === 0) {
      const defaultTemplates = [
        ['Welcome Message', 'Welcome Message', 'Hello {{customer_name}}, welcome to CLN Lending Suite! We are glad to serve you.'],
        ['Lead Follow-Up', 'Lead Follow-Up', 'Hi {{customer_name}}, we noticed you were interested in a loan. Let us know if you have any questions.'],
        ['Loan Approval', 'Loan Approval', 'Dear {{customer_name}}, your loan application for {{loan_amount}} (Loan No: {{loan_number}}) has been Approved! Contact your branch {{branch_name}}.'],
        ['Loan Rejection', 'Loan Rejection', 'Dear {{customer_name}}, we regret to inform you that your loan application (Loan No: {{loan_number}}) has been rejected. Thank you for your interest.'],
        ['Loan Disbursement', 'Loan Disbursement', 'Dear {{customer_name}}, your loan of {{loan_amount}} (Loan No: {{loan_number}}) has been disbursed successfully. Thank you!'],
        ['EMI Reminder', 'EMI Reminder', 'Dear {{customer_name}}, this is a friendly reminder that your EMI of {{emi_amount}} for Loan No: {{loan_number}} is due on {{due_date}}.'],
        ['Collection Reminder', 'Collection Reminder', 'URGENT: Dear {{customer_name}}, your EMI of {{emi_amount}} for Loan No: {{loan_number}} is overdue. Please pay immediately to avoid penalties.'],
        ['Customer Support', 'Customer Support', 'Hi {{customer_name}}, how can we help you today? Regards, CLN Lending.'],
        ['General Notification', 'General Notification', 'Hello {{customer_name}}, this is an update regarding your relationship with CLN Lending.']
      ];

      for (const [name, cat, content] of defaultTemplates) {
        await db.query(
          'INSERT IGNORE INTO whatsapp_templates (name, category, content) VALUES (?, ?, ?)',
          [name, cat, content]
        );
      }
      console.log('Seeded default WhatsApp templates successfully.');
    }

    const [conn] = await db.query('SELECT id FROM whatsapp_connections LIMIT 1');
    if (conn.length === 0) {
      await db.query(
        "INSERT INTO whatsapp_connections (status) VALUES ('Disconnected')"
      );
    }
  } catch (err) {
    console.error('Failed to initialize WhatsApp database tables:', err.message);
  }
}

async function ensureBreakTimeTables() {
  try {
    // 1. Add columns to users table if they don't exist
    const [cols] = await db.query("SHOW COLUMNS FROM users");
    const colNames = cols.map(c => c.Field);

    if (!colNames.includes('department')) {
      await db.query("ALTER TABLE users ADD COLUMN department VARCHAR(50) DEFAULT 'Operations'");
      console.log("Added 'department' column to 'users' table.");
    }
    if (!colNames.includes('current_status')) {
      await db.query("ALTER TABLE users ADD COLUMN current_status VARCHAR(20) DEFAULT 'Offline'");
      console.log("Added 'current_status' column to 'users' table.");
    }
    if (!colNames.includes('last_active_at')) {
      await db.query("ALTER TABLE users ADD COLUMN last_active_at TIMESTAMP NULL DEFAULT NULL");
      console.log("Added 'last_active_at' column to 'users' table.");
    }

    // 2. Create break_rules table
    await db.query(`
      CREATE TABLE IF NOT EXISTS break_rules (
        break_type VARCHAR(50) PRIMARY KEY,
        allowed_duration INT NOT NULL
      )
    `);

    // Seed default rules if empty
    const [existingRules] = await db.query('SELECT count(*) as count FROM break_rules');
    if (existingRules[0].count === 0) {
      const defaultRules = [
        ['Tea Break', 15],
        ['Lunch Break', 60],
        ['Personal Break', 15],
        ['Meeting Break', 30],
        ['Prayer Break', 15],
        ['Health Break', 30],
        ['Other', 30]
      ];
      for (const [type, duration] of defaultRules) {
        await db.query(
          'INSERT IGNORE INTO break_rules (break_type, allowed_duration) VALUES (?, ?)',
          [type, duration]
        );
      }
      console.log("Seeded default break rules.");
    }

    // 3. Create break_records table
    await db.query(`
      CREATE TABLE IF NOT EXISTS break_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        employee_name VARCHAR(100) NOT NULL,
        department VARCHAR(50) NOT NULL,
        break_type VARCHAR(50) NOT NULL,
        custom_reason TEXT NULL,
        start_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP NULL DEFAULT NULL,
        duration INT NULL DEFAULT NULL,
        status VARCHAR(20) DEFAULT 'On Break',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 4. Create attendance_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        employee_name VARCHAR(100) NOT NULL,
        login_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        logout_time TIMESTAMP NULL DEFAULT NULL,
        total_working_hours DECIMAL(10, 2) NULL DEFAULT NULL,
        session_status VARCHAR(20) DEFAULT 'Active Session',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log("Break Time and Attendance tables initialized successfully.");
  } catch (err) {
    console.error('Failed to initialize Break Time tables:', err.message);
  }
}

async function ensureProfileTables() {
  try {
    const [cols] = await db.query("SHOW COLUMNS FROM users");
    const colNames = cols.map(c => c.Field);

    const colsToAdd = [
      { name: 'username', def: 'VARCHAR(50) NULL UNIQUE' },
      { name: 'date_of_birth', def: 'DATE NULL' },
      { name: 'gender', def: 'VARCHAR(15) NULL' },
      { name: 'address', def: 'TEXT NULL' },
      { name: 'permanent_address', def: 'TEXT NULL' },
      { name: 'city', def: 'VARCHAR(50) NULL' },
      { name: 'state', def: 'VARCHAR(50) NULL' },
      { name: 'country', def: 'VARCHAR(50) NULL' },
      { name: 'postal_code', def: 'VARCHAR(15) NULL' },
      { name: 'profile_picture', def: 'VARCHAR(255) NULL' },
      { name: 'designation', def: 'VARCHAR(100) NULL' },
      { name: 'joining_date', def: 'DATE NULL' },
      { name: 'aadhaar_number', def: 'VARCHAR(20) NULL' },
      { name: 'aadhaar_front', def: 'VARCHAR(255) NULL' },
      { name: 'aadhaar_back', def: 'VARCHAR(255) NULL' },
      { name: 'pan_number', def: 'VARCHAR(20) NULL' },
      { name: 'pan_card', def: 'VARCHAR(255) NULL' },
      { name: 'verification_status', def: "VARCHAR(30) DEFAULT 'Pending'" },
      { name: 'verification_remarks', def: 'TEXT NULL' }
    ];

    for (const col of colsToAdd) {
      if (!colNames.includes(col.name)) {
        await db.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
        console.log(`Added column '${col.name}' to 'users' table.`);
      }
    }

    // 2. Create bank_details table
    await db.query(`
      CREATE TABLE IF NOT EXISTS bank_details (
        user_id INT PRIMARY KEY,
        account_holder_name VARCHAR(100) NULL,
        bank_name VARCHAR(100) NULL,
        account_number VARCHAR(50) NULL,
        ifsc_code VARCHAR(20) NULL,
        branch_name VARCHAR(100) NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 3. Create emergency_contacts table
    await db.query(`
      CREATE TABLE IF NOT EXISTS emergency_contacts (
        user_id INT PRIMARY KEY,
        contact_name VARCHAR(100) NULL,
        relationship VARCHAR(50) NULL,
        mobile_number VARCHAR(20) NULL,
        alternate_number VARCHAR(20) NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 4. Create notification_preferences table
    await db.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id INT PRIMARY KEY,
        email_notifications TINYINT(1) DEFAULT 1,
        whatsapp_notifications TINYINT(1) DEFAULT 1,
        loan_alerts TINYINT(1) DEFAULT 1,
        employee_activity_alerts TINYINT(1) DEFAULT 1,
        system_alerts TINYINT(1) DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 5. Create login_history table
    await db.query(`
      CREATE TABLE IF NOT EXISTS login_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(45) NULL,
        device VARCHAR(255) NULL,
        status VARCHAR(20) DEFAULT 'Success',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 6. Create user_activity_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        activity VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'Success',
        ip_address VARCHAR(45) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Seed default usernames, roles, and profiles for the seeded accounts
    // Admin: dixitlendingsolution@gmail.com -> username = admin, designation = Super Administrator, joining_date = 2026-05-16
    await db.query(`
      UPDATE users 
      SET username = 'admin', designation = 'Super Administrator', joining_date = '2026-05-16' 
      WHERE email = 'dixitlendingsolution@gmail.com' AND (username IS NULL OR username = '')
    `);

    // Employee: employee@cln.com -> username = employee, designation = Loan Executive, department = Sales, joining_date = 2026-05-16
    await db.query(`
      UPDATE users 
      SET username = 'employee', designation = 'Loan Executive', department = 'Sales', joining_date = '2026-05-16' 
      WHERE email = 'employee@cln.com' AND (username IS NULL OR username = '')
    `);

    // Seed blank preferences, bank, emergency contacts if not exists
    const [allUsers] = await db.query("SELECT id FROM users");
    for (const u of allUsers) {
      await db.query("INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)", [u.id]);
      await db.query("INSERT IGNORE INTO bank_details (user_id) VALUES (?)", [u.id]);
      await db.query("INSERT IGNORE INTO emergency_contacts (user_id) VALUES (?)", [u.id]);
    }

    console.log("Profile Management tables and seed data initialized successfully.");
  } catch (err) {
    console.error('Failed to initialize Profile tables:', err.message);
  }
}

async function ensureSettingsTables() {
  try {
    // 1. Create system_settings key-value store
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 2. Seed default working hours
    await db.query(`
      INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
        ('auto_activation_time', '07:00'),
        ('auto_deactivation_time', '20:00')
    `);

    // 3. Add auto-deactivation tracking columns to users table
    const [cols] = await db.query('SHOW COLUMNS FROM users');
    const colNames = cols.map(c => c.Field);

    const newCols = [
      { name: 'auto_deactivated',      def: 'TINYINT(1) DEFAULT 0' },
      { name: 'last_auto_activation',  def: 'TIMESTAMP NULL DEFAULT NULL' },
      { name: 'auto_deactivated_at',   def: 'TIMESTAMP NULL DEFAULT NULL' },
      { name: 'manual_override',       def: 'TINYINT(1) DEFAULT 0' },
      { name: 'manual_override_by',    def: 'INT NULL' },
      { name: 'manual_override_at',    def: 'DATETIME NULL' }
    ];
    for (const col of newCols) {
      if (!colNames.includes(col.name)) {
        await db.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
        console.log(`Added column '${col.name}' to 'users' table.`);
      }
    }

    console.log('Settings and auto-activation tables initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Settings tables:', err.message);
  }
}

async function ensureLoginHoursColumns() {
  try {
    const [cols] = await db.query("SHOW COLUMNS FROM attendance_logs");
    const colNames = cols.map(c => c.Field);

    const colsToAdd = [
      { name: 'ip_address', def: 'VARCHAR(45) NULL' },
      { name: 'device',     def: 'VARCHAR(150) NULL' },
      { name: 'browser',    def: 'VARCHAR(100) NULL' },
      { name: 'os',         def: 'VARCHAR(100) NULL' }
    ];

    for (const col of colsToAdd) {
      if (!colNames.includes(col.name)) {
        await db.query(`ALTER TABLE attendance_logs ADD COLUMN ${col.name} ${col.def}`);
        console.log(`Added column '${col.name}' to 'attendance_logs' table.`);
      }
    }
    console.log('Login Hours columns ensured on attendance_logs.');
  } catch (err) {
    console.error('Failed to ensure Login Hours columns:', err.message);
  }
}

async function ensureExcelModule() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS excel_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_name VARCHAR(500) NOT NULL,
        original_name VARCHAR(500) NOT NULL,
        uploaded_by INT NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) NOT NULL DEFAULT 'Assigned',
        total_records INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS excel_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        row_index INT NOT NULL,
        phone_number VARCHAR(30) NOT NULL,
        disposition VARCHAR(100) NULL,
        sub_disposition VARCHAR(200) NULL,
        updated_by INT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'Pending',
        updated_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES excel_files(id) ON DELETE CASCADE,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS excel_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        employee_id INT NOT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        assigned_by INT NOT NULL,
        completed_at TIMESTAMP NULL,
        progress INT NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'Assigned',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_file_employee (file_id, employee_id),
        FOREIGN KEY (file_id) REFERENCES excel_files(id) ON DELETE CASCADE,
        FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS excel_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        record_id INT NOT NULL,
        employee_id INT NOT NULL,
        phone_number VARCHAR(30) NOT NULL,
        old_disposition VARCHAR(100) NULL,
        new_disposition VARCHAR(100) NULL,
        old_sub_disposition VARCHAR(200) NULL,
        new_sub_disposition VARCHAR(200) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES excel_files(id) ON DELETE CASCADE,
        FOREIGN KEY (record_id) REFERENCES excel_records(id) ON DELETE CASCADE,
        FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('Excel module tables initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Excel module tables:', err.message);
  }
}

async function runMigrations() {
  try {
    await ensureDefaultAdminAccount();
    await ensurePasswordResetTable();
    await ensureDocumentsTable();
    await ensureLoansTable();

    await ensureProfileTables();
    await ensureSettingsTables();
    await ensureExcelModule();
    await ensureLoginHoursColumns();
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

runMigrations().finally(() => {
  app.listen(PORT, () => {
    console.log(`\nCLN Server running at http://localhost:${PORT}`);
    console.log(`Admin login: dixitlendingsolution@gmail.com / Utkarsh.3112`);
    console.log(`Employee login: employee@cln.com / Employee@123\n`);
    debugResendEnvironment();

    // Start auto activation/deactivation scheduler
    scheduler.startScheduler();
  });
});

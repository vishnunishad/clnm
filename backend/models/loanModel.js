const db = require('../config/db');

function formatToMySQLDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) {
    return dateStr.toISOString().slice(0, 10);
  }
  const str = String(dateStr).trim();
  if (!str) return null;

  // DD-MM-YYYY or D-M-YYYY
  const ddMmYyyyRegex = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
  const match = str.match(ddMmYyyyRegex);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  // DD/MM/YYYY or D/M/YYYY
  const ddMmYyyySlashRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const matchSlash = str.match(ddMmYyyySlashRegex);
  if (matchSlash) {
    const day = matchSlash[1].padStart(2, '0');
    const month = matchSlash[2].padStart(2, '0');
    const year = matchSlash[3];
    return `${year}-${month}-${day}`;
  }

  // If already YYYY-MM-DD
  const yyyyMmDdRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (yyyyMmDdRegex.test(str)) {
    return str;
  }

  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch (e) {}

  return str;
}

const LoanModel = {
  async create({ customer_id, amount, purpose, applied_by }) {
    const [result] = await db.query(
      `INSERT INTO loans (customer_id, amount, purpose, applied_by, login_date, system_upload_date) 
       VALUES (?, ?, ?, ?, CURDATE(), CURDATE())`,
      [customer_id, amount, purpose || null, applied_by]
    );
    const loanId = result.insertId;
    // Log initial history
    await db.query(
      'INSERT INTO loan_history (loan_id, status, remark, updated_by) VALUES (?, ?, ?, ?)',
      [loanId, 'Pending', 'Loan application created.', applied_by]
    );
    return loanId;
  },

  async findById(id) {
    const [rows] = await db.query(
      `SELECT l.*, c.name AS customer_name, c.area, c.phone AS customer_phone,
              u.name AS applied_by_name, a.name AS approved_by_name
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       LEFT JOIN users u ON l.applied_by = u.id
       LEFT JOIN users a ON l.approved_by = a.id
       WHERE l.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async getAll({ 
    status, 
    area, 
    period, 
    applied_by, 
    search, 
    customer_id, 
    startDate, 
    endDate,
    loginStartDate,
    loginEndDate,
    uploadStartDate,
    uploadEndDate,
    disbursementStartDate,
    disbursementEndDate,
    periodDateType
  } = {}) {
    let sql = `
      SELECT l.*, c.name AS customer_name, c.area, c.phone AS customer_phone,
             u.name AS applied_by_name
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      LEFT JOIN users u ON l.applied_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { sql += ' AND l.status = ?'; params.push(status); }
    if (area) { sql += ' AND c.area = ?'; params.push(area); }
    if (applied_by) { sql += ' AND l.applied_by = ?'; params.push(applied_by); }
    if (customer_id) { sql += ' AND l.customer_id = ?'; params.push(customer_id); }
    if (search) {
      sql += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Determine the column to use for time period interval filters
    let periodColumn = 'l.created_at';
    if (periodDateType === 'login_date') periodColumn = 'l.login_date';
    else if (periodDateType === 'system_upload_date') periodColumn = 'l.system_upload_date';
    else if (periodDateType === 'disbursement_date') periodColumn = 'l.disbursement_date';

    // Time period filter
    if (period === 'week') {
      sql += ` AND ${periodColumn} >= DATE_SUB(NOW(), INTERVAL 1 WEEK)`;
    } else if (period === 'month') {
      sql += ` AND ${periodColumn} >= DATE_SUB(NOW(), INTERVAL 1 MONTH)`;
    } else if (period === 'year') {
      sql += ` AND ${periodColumn} >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`;
    }

    // Specific Date Range Filters (respects periodDateType column)
    if (startDate) {
      sql += ` AND ${periodColumn} >= ?`;
      params.push(startDate.includes(' ') ? startDate : `${startDate} 00:00:00`);
    }
    if (endDate) {
      sql += ` AND ${periodColumn} <= ?`;
      params.push(endDate.includes(' ') ? endDate : `${endDate} 23:59:59`);
    }

    if (loginStartDate) {
      sql += ' AND l.login_date >= ?';
      params.push(loginStartDate);
    }
    if (loginEndDate) {
      sql += ' AND l.login_date <= ?';
      params.push(loginEndDate);
    }

    if (uploadStartDate) {
      sql += ' AND l.system_upload_date >= ?';
      params.push(uploadStartDate);
    }
    if (uploadEndDate) {
      sql += ' AND l.system_upload_date <= ?';
      params.push(uploadEndDate);
    }

    if (disbursementStartDate) {
      sql += ' AND l.disbursement_date >= ?';
      params.push(disbursementStartDate);
    }
    if (disbursementEndDate) {
      sql += ' AND l.disbursement_date <= ?';
      params.push(disbursementEndDate);
    }

    sql += ' ORDER BY l.created_at DESC';
    const [rows] = await db.query(sql, params);
    return rows;
  },

  async updateStatus(id, { status, notes, approved_by, login_date, system_upload_date, disbursement_date, disbursement_amount }) {
    // Get current loan status to check if it's changing
    const [loans] = await db.query('SELECT status, login_date, system_upload_date, disbursement_date, disbursement_amount FROM loans WHERE id = ?', [id]);
    if (loans.length === 0) return 0;
    const current = loans[0];
    
    // Auto populate disbursement date if status is set to 'Loan Disbursed' and currently not disbursed
    let finalDisbursementDate = disbursement_date;
    if (status === 'Loan Disbursed' && current.status !== 'Loan Disbursed' && !disbursement_date) {
      finalDisbursementDate = new Date().toISOString().slice(0, 10);
    }

    const formattedLoginDate = formatToMySQLDate(login_date);
    const formattedUploadDate = formatToMySQLDate(system_upload_date);
    const formattedDisbursementDate = formatToMySQLDate(finalDisbursementDate);

    // If status is not 'Loan Disbursed', disbursement_amount should be set to null
    const finalDisbursementAmount = status === 'Loan Disbursed' ? (disbursement_amount !== undefined ? disbursement_amount : current.disbursement_amount) : null;

    const [result] = await db.query(
      `UPDATE loans 
       SET status = ?, 
           notes = ?, 
           approved_by = ?,
           login_date = COALESCE(?, login_date),
           system_upload_date = COALESCE(?, system_upload_date),
           disbursement_date = ?,
           disbursement_amount = ?
       WHERE id = ?`,
      [
        status, 
        notes || null, 
        approved_by || null, 
        formattedLoginDate,
        formattedUploadDate,
        formattedDisbursementDate,
        finalDisbursementAmount,
        id
      ]
    );

    // Helper to format date as YYYY-MM-DD local
    const getYYYYMMDD = (dateVal) => {
      if (!dateVal) return null;
      const d = new Date(dateVal);
      if (isNaN(d.getTime())) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const currentDisbDate = getYYYYMMDD(current.disbursement_date);
    const newDisbDate = getYYYYMMDD(formattedDisbursementDate);

    const hasDisbursedDetailsChanged = status === 'Loan Disbursed' && (
      newDisbDate !== currentDisbDate ||
      Number(finalDisbursementAmount) !== Number(current.disbursement_amount)
    );

    // Write to history if status has changed, a remark is supplied, or disbursement details changed
    if (notes || status !== current.status || hasDisbursedDetailsChanged) {
      await db.query(
        'INSERT INTO loan_history (loan_id, status, remark, updated_by, disbursement_date, disbursement_amount) VALUES (?, ?, ?, ?, ?, ?)',
        [
          id,
          status,
          notes || (status === current.status ? 'Details updated.' : 'Status updated.'),
          approved_by,
          status === 'Loan Disbursed' ? formattedDisbursementDate : null,
          status === 'Loan Disbursed' ? finalDisbursementAmount : null
        ]
      );
    }
    return result.affectedRows;
  },

  async getHistory(loanId) {
    const [rows] = await db.query(
      `SELECT h.*, u.name AS updated_by_name 
       FROM loan_history h
       LEFT JOIN users u ON h.updated_by = u.id
       WHERE h.loan_id = ?
       ORDER BY h.created_at DESC`,
      [loanId]
    );
    return rows;
  },

  async getDashboardStats() {
    const [total] = await db.query('SELECT COUNT(*) AS total FROM loans');
    const [statusBreakdown] = await db.query(
      'SELECT status, COUNT(*) AS count FROM loans GROUP BY status'
    );
    const [totalAmount] = await db.query(
      "SELECT SUM(amount) AS total_amount FROM loans WHERE status = 'Approved'"
    );
    const [monthlyTrend] = await db.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
             COUNT(*) AS count,
             SUM(amount) AS total_amount
      FROM loans
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY month
      ORDER BY month ASC
    `);
    const [recentLoans] = await db.query(`
      SELECT l.id, l.amount, l.status, l.created_at,
             c.id AS customer_id, c.name AS customer_name, u.name AS applied_by_name
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      LEFT JOIN users u ON l.applied_by = u.id
      ORDER BY l.created_at DESC
      LIMIT 5
    `);

    return {
      total: total[0].total,
      statusBreakdown,
      totalApprovedAmount: totalAmount[0].total_amount || 0,
      monthlyTrend,
      recentLoans
    };
  },

  async delete(id) {
    const [result] = await db.query('DELETE FROM loans WHERE id = ?', [id]);
    return result.affectedRows;
  }
};

module.exports = LoanModel;

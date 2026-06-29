const bcrypt = require('bcryptjs');
const UserModel = require('../models/userModel');
const CustomerModel = require('../models/customerModel');
const LoanModel = require('../models/loanModel');
const DocumentModel = require('../models/documentModel');
const db = require('../config/db');

const adminController = {
  // ── Dashboard ───────────────────────────────────────────────
  async getDashboard(req, res) {
    try {
      const loanStats = await LoanModel.getDashboardStats();
      const [customers] = [await CustomerModel.getAll()];
      const employees = await UserModel.getAll('employee');

      return res.json({
        success: true,
        data: {
          totalCustomers: customers.length,
          totalEmployees: employees.length,
          loans: loanStats
        }
      });
    } catch (err) {
      console.error('[Admin] Dashboard error:', err);
      return res.status(500).json({ success: false, message: 'Failed to load dashboard data.' });
    }
  },

  // ── Employees ───────────────────────────────────────────────
  async getEmployees(req, res) {
    try {
      const employees = await UserModel.getAll('employee');
      // Remove password field from response
      const safeEmployees = employees.map(emp => {
        const { password, ...safe } = emp;
        return safe;
      });
      return res.json({ success: true, data: safeEmployees });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch employees.' });
    }
  },

  async addEmployee(req, res) {
    try {
      const { name, email, password, phone, department } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
      }

      const existing = await UserModel.findByEmail(email);
      if (existing) {
        return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const id = await UserModel.create({ name, email: email.toLowerCase(), password: hashedPassword, role: 'employee', phone, department });

      return res.status(201).json({ success: true, message: 'Employee created successfully.', id });
    } catch (err) {
      console.error('[Admin] Add employee error:', err);
      return res.status(500).json({ success: false, message: 'Failed to create employee.' });
    }
  },

  async deactivateEmployee(req, res) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id || null;

      // Close any active attendance sessions
      const [activeSessions] = await db.query(
        'SELECT id, login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL',
        [id]
      );
      for (const s of activeSessions) {
        const closeTime = new Date();
        const loginTime = new Date(s.login_time);
        const durationHours = Number((Math.max(0, closeTime - loginTime) / 3600000).toFixed(2));
        await db.query(
          'UPDATE attendance_logs SET logout_time = ?, total_working_hours = ?, session_status = "Logged Out" WHERE id = ?',
          [closeTime, durationHours, s.id]
        );
      }

      // Deactivate and clear all override/auto flags
      await db.query(
        `UPDATE users
         SET is_active = 0, auto_deactivated = 0, manual_override = 0,
             manual_override_by = NULL, manual_override_at = NULL
         WHERE id = ?`,
        [id]
      );

      // Audit log
      const [emp] = await db.query('SELECT name FROM users WHERE id = ?', [id]);
      if (emp[0]) {
        const [admin] = await db.query('SELECT name FROM users WHERE id = ?', [adminId]);
        const adminName = admin[0]?.name || 'Admin';
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [id, `Admin Action\n\nEmployee: ${emp[0].name}\n\nAction: Deactivated by Admin\n\nAdmin: ${adminName}`]
        );
      }

      return res.json({ success: true, message: 'Employee deactivated successfully.' });
    } catch (err) {
      console.error('[Admin] Deactivate employee error:', err);
      return res.status(500).json({ success: false, message: 'Failed to deactivate employee.' });
    }
  },

  async activateEmployee(req, res) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id || null;

      // Normal activate: clear all override and auto-deactivation flags
      await db.query(
        `UPDATE users
         SET is_active = 1, auto_deactivated = 0, manual_override = 0,
             manual_override_by = NULL, manual_override_at = NULL
         WHERE id = ?`,
        [id]
      );

      // Audit log
      const [emp] = await db.query('SELECT name FROM users WHERE id = ?', [id]);
      if (emp[0]) {
        const [admin] = await db.query('SELECT name FROM users WHERE id = ?', [adminId]);
        const adminName = admin[0]?.name || 'Admin';
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [id, `Admin Action\n\nEmployee: ${emp[0].name}\n\nAction: Activated by Admin\n\nAdmin: ${adminName}`]
        );
      }

      return res.json({ success: true, message: 'Employee activated.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to activate employee.' });
    }
  },

  async activateOverride(req, res) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id || null;

      // Set manual override — employee gets full access ignoring business hours
      await db.query(
        `UPDATE users
         SET is_active = 1, auto_deactivated = 0, manual_override = 1,
             manual_override_by = ?, manual_override_at = NOW()
         WHERE id = ?`,
        [adminId, id]
      );

      // Audit log
      const [emp] = await db.query('SELECT name FROM users WHERE id = ?', [id]);
      const [admin] = await db.query('SELECT name FROM users WHERE id = ?', [adminId]);
      if (emp[0]) {
        const adminName = admin[0]?.name || 'Admin';
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [id, `Admin Action\n\nEmployee: ${emp[0].name}\n\nAction: Manual Override Activated\n\nAdmin: ${adminName}\n\nReason: Emergency Access`]
        );
      }

      return res.json({ success: true, message: 'Manual override activated. Employee can now access the CRM outside business hours.' });
    } catch (err) {
      console.error('[Admin] Activate override error:', err);
      return res.status(500).json({ success: false, message: 'Failed to activate override.' });
    }
  },

  async removeOverride(req, res) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id || null;

      // Clear override and deactivate immediately
      const [activeSessions] = await db.query(
        'SELECT id, login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL',
        [id]
      );
      for (const s of activeSessions) {
        const closeTime = new Date();
        const loginTime = new Date(s.login_time);
        const durationHours = Number((Math.max(0, closeTime - loginTime) / 3600000).toFixed(2));
        await db.query(
          'UPDATE attendance_logs SET logout_time = ?, total_working_hours = ?, session_status = "Logged Out" WHERE id = ?',
          [closeTime, durationHours, s.id]
        );
      }

      await db.query(
        `UPDATE users
         SET is_active = 0, auto_deactivated = 1, manual_override = 0,
             manual_override_by = NULL, manual_override_at = NULL
         WHERE id = ?`,
        [id]
      );

      // Audit log
      const [emp] = await db.query('SELECT name FROM users WHERE id = ?', [id]);
      const [admin] = await db.query('SELECT name FROM users WHERE id = ?', [adminId]);
      if (emp[0]) {
        const adminName = admin[0]?.name || 'Admin';
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [id, `Admin Action\n\nEmployee: ${emp[0].name}\n\nAction: Manual Override Removed\n\nAdmin: ${adminName}`]
        );
      }

      return res.json({ success: true, message: 'Manual override removed. Employee has been deactivated.' });
    } catch (err) {
      console.error('[Admin] Remove override error:', err);
      return res.status(500).json({ success: false, message: 'Failed to remove override.' });
    }
  },

  async updateEmployeePassword(req, res) {
    try {
      const { id } = req.params;
      const { password } = req.body;

      if (!password || password.trim().length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await UserModel.updatePassword(id, hashedPassword);

      return res.json({ success: true, message: 'Employee password updated successfully.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to update employee password.' });
    }
  },

  // ── Customers ───────────────────────────────────────────────
  async getCustomers(req, res) {
    try {
      const { area, search, period, startDate, endDate } = req.query;
      const customers = await CustomerModel.getAll({ area, search, period, startDate, endDate });
      return res.json({ success: true, data: customers });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch customers.' });
    }
  },

  async exportCustomers(req, res) {
    try {
      const { area, search, period, startDate, endDate } = req.query;
      const customers = await CustomerModel.getAll({ area, search, period, startDate, endDate });

      // Fetch all loans to map them to customers
      const [allLoans] = await db.query('SELECT customer_id, amount, status FROM loans');
      const loanMap = {};
      allLoans.forEach(l => {
        if (!loanMap[l.customer_id]) loanMap[l.customer_id] = [];
        loanMap[l.customer_id].push(l);
      });

      // Helper function to extract fields from quick paste
      function extractField(text, labels) {
        if (!text) return '';
        const lines = text.split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          for (const label of labels) {
            const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*[:\\-—]?\\s*(.+)$', 'i');
            const m = line.match(re);
            if (m && m[1]) return m[1].trim();
          }
        }
        for (const label of labels) {
          const escapedLabel = label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
          const re = new RegExp(escapedLabel + '\\s*[:\\-—]\\s*([^\\n\\-\\-]+?)(?=\\s*(?:[A-Z][a-zA-Z\\s’\']+[:\\-—]|---|$))', 'i');
          const m = text.match(re);
          if (m && m[1]) return m[1].trim();
        }
        return '';
      }

      const headers = [
        'Customer ID', 'Customer Name', 'Mobile Number', 'Alternate Mobile Number', 'Address',
        'Aadhaar Number', 'PAN Number', 'Loan Amount', 'Loan Status', 'Employee Name',
        'Personal Gmail ID', 'Marital Status', 'Mother\'s Name', 'Spouse\'s Name', 'House Type',
        'Education', 'Company Name', 'Company Address', 'Official Email ID',
        'Current Work Experience', 'Total Work Experience', 'Net Monthly Income',
        'Net Salary', 'Total Obligation',
        'Created Date', 'Updated Date'
      ];

      const rows = customers.map(c => {
        const cLoans = loanMap[c.id] || [];
        const dbLoanAmount = cLoans.map(l => l.amount).join('; ');
        const dbLoanStatus = cLoans.map(l => l.status).join('; ');

        const rawDetails = c.address || '';
        const altPhone = extractField(rawDetails, ['Mobile Number', 'Phone Number', 'Mob no', 'Mobile']);
        const aadhaar = extractField(rawDetails, ['Aadhaar Number', 'Aadhar Number', 'Aadhar card', 'Aadhar Card', 'Aadhar']);
        const pan = extractField(rawDetails, ['PAN Number', 'PAN card', 'Pan card']);
        
        // Fallback for loan amount if not in DB
        const quickPasteLoanAmt = extractField(rawDetails, ['Required Loan Amount', 'Loan Amount', 'Amount']);
        const loanAmount = dbLoanAmount || quickPasteLoanAmt || '—';
        const loanStatus = dbLoanStatus || (quickPasteLoanAmt ? 'Pending' : 'Not Applied');

        const personalGmail = extractField(rawDetails, ['Personal Gmail ID', 'Personal gmail']);
        const marital = extractField(rawDetails, ['Marital Status']);
        const mother = extractField(rawDetails, ['Mother’s Name', "Mother's Name", 'Mother name']);
        const spouse = extractField(rawDetails, ['Spouse’s Name (if applicable)', "Spouse's Name", 'Spouse name']);
        const house = extractField(rawDetails, ['House Type', 'House - Owned/Rented', 'House']);
        const education = extractField(rawDetails, ['Highest Education Qualification', 'Education']);
        const company = extractField(rawDetails, ['Company Name']);
        const compAddress = extractField(rawDetails, ['Company Address']);
        const officeEmail = extractField(rawDetails, ['Official Email ID', 'Office email id', 'Office email']);
        const curExp = extractField(rawDetails, ['Current Work Experience', 'Experience']);
        const totExp = extractField(rawDetails, ['Total Work Experience', 'Total experience']);
        const income = extractField(rawDetails, ['Net Monthly Income (₹)', 'Net monthly income']);

        // Clean raw address (before the "--- Additional Customer Details ---" separator)
        const cleanAddress = rawDetails.split('--- Additional Customer Details ---')[0].trim();

        return [
          c.id,
          `"${c.name.replace(/"/g, '""')}"`,
          c.phone,
          altPhone ? `"${altPhone.replace(/"/g, '""')}"` : '—',
          `"${cleanAddress.replace(/"/g, '""')}"`,
          aadhaar ? `"${aadhaar.replace(/"/g, '""')}"` : '—',
          pan ? `"${pan.replace(/"/g, '""')}"` : '—',
          `"${loanAmount.replace(/"/g, '""')}"`,
          `"${loanStatus.replace(/"/g, '""')}"`,
          `"${c.added_by_name.replace(/"/g, '""')}"`,
          personalGmail ? `"${personalGmail.replace(/"/g, '""')}"` : '—',
          marital ? `"${marital.replace(/"/g, '""')}"` : '—',
          mother ? `"${mother.replace(/"/g, '""')}"` : '—',
          spouse ? `"${spouse.replace(/"/g, '""')}"` : '—',
          house ? `"${house.replace(/"/g, '""')}"` : '—',
          education ? `"${education.replace(/"/g, '""')}"` : '—',
          company ? `"${company.replace(/"/g, '""')}"` : '—',
          compAddress ? `"${compAddress.replace(/"/g, '""')}"` : '—',
          officeEmail ? `"${officeEmail.replace(/"/g, '""')}"` : '—',
          curExp ? `"${curExp.replace(/"/g, '""')}"` : '—',
          totExp ? `"${totExp.replace(/"/g, '""')}"` : '—',
          income ? `"${income.replace(/"/g, '""')}"` : '—',
          c.net_salary !== null ? c.net_salary : 0,
          c.total_obligation !== null ? c.total_obligation : 0,
          new Date(c.created_at).toLocaleDateString('en-IN'),
          new Date(c.updated_at).toLocaleDateString('en-IN')
        ];
      });

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="customers_export_${Date.now()}.csv"`);
      return res.send(csv);
    } catch (err) {
      console.error('[Admin] Export customers error:', err);
      return res.status(500).json({ success: false, message: 'Export failed.' });
    }
  },

  async getCustomerDetail(req, res) {
    try {
      const { id } = req.params;
      const customer = await CustomerModel.findById(id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

      const documents = await DocumentModel.getByCustomer(id);
      const loans = await LoanModel.getAll({ customer_id: id });

      return res.json({ success: true, data: { customer, documents, loans } });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch customer details.' });
    }
  },

  // ── Loans ───────────────────────────────────────────────────
  async getLoans(req, res) {
    try {
      const { 
        status, 
        area, 
        period,
        startDate,
        endDate,
        search,
        employee,
        loginStartDate,
        loginEndDate,
        uploadStartDate,
        uploadEndDate,
        disbursementStartDate,
        disbursementEndDate,
        periodDateType
      } = req.query;
      const loans = await LoanModel.getAll({ 
        status, 
        area, 
        period,
        startDate,
        endDate,
        search,
        applied_by: employee || undefined,
        loginStartDate,
        loginEndDate,
        uploadStartDate,
        uploadEndDate,
        disbursementStartDate,
        disbursementEndDate,
        periodDateType
      });
      return res.json({ success: true, data: loans });
    } catch (err) {
      console.error('[Admin] Fetch loans error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch loans.' });
    }
  },

  async getLoanDetail(req, res) {
    try {
      const { id } = req.params;
      const loan = await LoanModel.findById(id);
      if (!loan) {
        return res.status(404).json({ success: false, message: 'Loan record not found.' });
      }
      const history = await LoanModel.getHistory(id);
      return res.json({ success: true, data: { loan, history } });
    } catch (err) {
      console.error('[Admin] Fetch loan detail error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch loan details.' });
    }
  },

  async updateLoanStatus(req, res) {
    const { id } = req.params;
    const { status, notes, login_date, system_upload_date, disbursement_date, disbursement_amount } = req.body;
    console.log(`[Admin] Incoming status update request - Loan ID: ${id}, Admin ID: ${req?.user?.id}, Payload:`, req.body);

    try {
      const allowedStatuses = ['Pending', 'Under Review', 'Documents Pending', 'Approved', 'Rejected', 'Loan Disbursed', 'Cancelled', 'Hold', 'ABND', 'Other'];
      if (!allowedStatuses.includes(status)) {
        console.warn(`[Admin] Invalid status update attempt - Status: ${status}`);
        return res.status(400).json({ success: false, message: `Invalid status: ${status}. Allowed values are: ${allowedStatuses.join(', ')}` });
      }

      if (['Rejected', 'Hold', 'Cancelled'].includes(status) && (!notes || !notes.trim())) {
        console.warn(`[Admin] Missing remarks for status: ${status}`);
        return res.status(400).json({ success: false, message: 'Please enter remarks before updating this status.' });
      }

      if (status === 'Loan Disbursed') {
        if (!disbursement_date) {
          return res.status(400).json({ success: false, message: 'Please enter the disbursement date.' });
        }
        if (disbursement_amount === undefined || disbursement_amount === null || String(disbursement_amount).trim() === '') {
          return res.status(400).json({ success: false, message: 'Please enter the disbursement amount.' });
        }
        const parsedAmt = parseFloat(disbursement_amount);
        if (isNaN(parsedAmt) || parsedAmt < 0) {
          return res.status(400).json({ success: false, message: 'Please enter a valid disbursement amount.' });
        }
      }

      const loan = await LoanModel.findById(id);
      if (!loan) {
        console.warn(`[Admin] Loan record not found - Loan ID: ${id}`);
        return res.status(404).json({ success: false, message: 'Loan record not found.' });
      }

      const affectedRows = await LoanModel.updateStatus(id, { 
        status, 
        notes, 
        approved_by: req.user.id,
        login_date,
        system_upload_date,
        disbursement_date,
        disbursement_amount: status === 'Loan Disbursed' ? parseFloat(disbursement_amount) : null
      });

      console.log(`[Admin] Loan status updated successfully in DB - Loan ID: ${id}, Affected Rows: ${affectedRows}`);

      // WhatsApp workflow trigger: Loan Lifecycle updates
      let triggerCategory = null;
      if (status === 'Approved') triggerCategory = 'Loan Approval';
      else if (status === 'Rejected') triggerCategory = 'Loan Rejection';
      else if (status === 'Loan Disbursed') triggerCategory = 'Loan Disbursement';

      if (triggerCategory) {
        try {
          whatsappService.sendWorkflowMessage(triggerCategory, loan.customer_id, {
            loan_number: 'LN-' + id,
            loan_amount: loan.amount,
            employee_id: req.user.id
          });
          console.log(`[Admin] WhatsApp workflow message sent for Category: ${triggerCategory}, Customer ID: ${loan.customer_id}`);
        } catch (wsErr) {
          console.error('[Admin] WhatsApp notification trigger error:', wsErr);
        }
      }

      return res.json({ success: true, message: `Loan status updated to ${status}.` });
    } catch (err) {
      console.error(`[Admin] Error updating status for Loan ID ${id}:`, err.stack || err);
      let errMsg = 'Failed to update loan status.';
      if (err.code === 'ER_TRUNCATED_WRONG_VALUE' || err.sqlState === '22007') {
        errMsg = `Validation failed: ${err.sqlMessage || 'Incorrect format or value'}`;
      } else if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
        errMsg = 'Database connection failed.';
      } else if (err.message) {
        errMsg = err.message;
      }
      return res.status(500).json({ success: false, message: errMsg });
    }
  },

  async exportLoans(req, res) {
    try {
      const { 
        status, 
        area, 
        period, 
        search, 
        loginStartDate, 
        loginEndDate, 
        uploadStartDate, 
        uploadEndDate, 
        disbursementStartDate, 
        disbursementEndDate,
        periodDateType
      } = req.query;
      const loans = await LoanModel.getAll({ 
        status, 
        area, 
        period, 
        search, 
        loginStartDate, 
        loginEndDate, 
        uploadStartDate, 
        uploadEndDate, 
        disbursementStartDate, 
        disbursementEndDate,
        periodDateType
      });

      // Build CSV manually
      const headers = ['ID', 'Customer', 'Area', 'Phone', 'Amount', 'Purpose', 'Status', 'Applied By', 'Login Date', 'Upload Date', 'Disbursement Date', 'Disbursement Amount'];
      const rows = loans.map(l => [
        l.id,
        `"${l.customer_name}"`,
        `"${l.area}"`,
        l.customer_phone,
        l.amount,
        `"${l.purpose || ''}"`,
        l.status,
        `"${l.applied_by_name}"`,
        l.login_date ? new Date(l.login_date).toLocaleDateString('en-IN') : '',
        l.system_upload_date ? new Date(l.system_upload_date).toLocaleDateString('en-IN') : '',
        l.disbursement_date ? new Date(l.disbursement_date).toLocaleDateString('en-IN') : '',
        l.disbursement_amount ? `"${'₹' + Number(l.disbursement_amount).toLocaleString('en-IN')}"` : '""'
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="loans_export_${Date.now()}.csv"`);
      return res.send(csv);
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Export failed.' });
    }
  },

  async getAreas(req, res) {
    try {
      const areas = await CustomerModel.getAreas();
      return res.json({ success: true, data: areas });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch areas.' });
    }
  },

  // ── Loans Deletion ───────────────────────────────────────────
  async deleteLoan(req, res) {
    try {
      const { id } = req.params;
      const loan = await LoanModel.findById(id);
      if (!loan) {
        return res.status(404).json({ success: false, message: 'Loan record not found.' });
      }

      await LoanModel.delete(id);
      return res.json({ success: true, message: 'Loan record deleted successfully.' });
    } catch (err) {
      console.error('[Admin] Delete loan error:', err);
      return res.status(500).json({ success: false, message: 'Failed to delete loan record.' });
    }
  },

  async deleteLoansBulk(req, res) {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No loan IDs provided.' });
      }

      const results = [];
      for (const id of ids) {
        try {
          const loan = await LoanModel.findById(id);
          if (loan) {
            await LoanModel.delete(id);
            results.push({ id, success: true });
          } else {
            results.push({ id, success: false, reason: 'Not found' });
          }
        } catch (itemErr) {
          results.push({ id, success: false, reason: itemErr.message });
        }
      }

      return res.json({
        success: true,
        message: `Processed ${ids.length} loan deletions.`,
        results
      });
    } catch (err) {
      console.error('[Admin] Bulk delete loans error:', err);
      return res.status(500).json({ success: false, message: 'Bulk delete loans failed.' });
    }
  },

  async getWorkingHours(req, res) {
    try {
      const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ("auto_activation_time", "auto_deactivation_time")');
      const settings = {};
      rows.forEach(r => {
        settings[r.setting_key] = r.setting_value;
      });
      return res.json({
        success: true,
        data: {
          auto_activation_time: settings.auto_activation_time || '07:00',
          auto_deactivation_time: settings.auto_deactivation_time || '20:00'
        }
      });
    } catch (err) {
      console.error('[Admin] Get working hours error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch working hours.' });
    }
  },

  async updateWorkingHours(req, res) {
    try {
      const { auto_activation_time, auto_deactivation_time } = req.body;
      if (!auto_activation_time || !auto_deactivation_time) {
        return res.status(400).json({ success: false, message: 'Activation and deactivation times are required.' });
      }

      const timeRegex = /^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/;
      let startNormalized = auto_activation_time;
      let endNormalized = auto_deactivation_time;

      if (!timeRegex.test(startNormalized) || !timeRegex.test(endNormalized)) {
        return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:MM.' });
      }

      if (startNormalized.split(':')[0].length === 1) startNormalized = '0' + startNormalized;
      if (endNormalized.split(':')[0].length === 1) endNormalized = '0' + endNormalized;

      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES ("auto_activation_time", ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [startNormalized, startNormalized]
      );

      await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES ("auto_deactivation_time", ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [endNormalized, endNormalized]
      );

      // Trigger scheduler update immediately
      const scheduler = require('../utils/scheduler');
      scheduler.checkAndProcessSchedules();

      return res.json({
        success: true,
        message: 'Working hours updated successfully.'
      });
    } catch (err) {
      console.error('[Admin] Update working hours error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update working hours.' });
    }
  }
};

module.exports = adminController;

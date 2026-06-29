const CustomerModel = require('../models/customerModel');
const LoanModel = require('../models/loanModel');
const DocumentModel = require('../models/documentModel');
const path = require('path');
const fs = require('fs');
const whatsappService = require('../utils/whatsappService');

const employeeController = {
  // ── Dashboard ───────────────────────────────────────────────
  async getDashboard(req, res) {
    try {
      const employeeId = req.user.id;
      const customers = await CustomerModel.getAll({ added_by: employeeId });
      const loans = await LoanModel.getAll({ applied_by: employeeId });

      const pending = loans.filter(l => l.status === 'Pending').length;
      const approved = loans.filter(l => l.status === 'Approved').length;
      const rejected = loans.filter(l => l.status === 'Rejected').length;

      return res.json({
        success: true,
        data: {
          totalCustomers: customers.length,
          totalLoans: loans.length,
          pending,
          approved,
          rejected,
          recentLoans: loans.slice(0, 5),
          recentCustomers: customers.slice(0, 5)
        }
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
    }
  },

  // ── Customers ───────────────────────────────────────────────
  async getCustomers(req, res) {
    try {
      const { area, search } = req.query;
      const customers = await CustomerModel.getAll({ area, search, added_by: req.user.id });
      return res.json({ success: true, data: customers });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch customers.' });
    }
  },

  async addCustomer(req, res) {
    try {
      const { name, phone, email, address, area, net_salary, total_obligation } = req.body;
      if (!name || !phone || !email || !address || !area || net_salary === undefined) {
        return res.status(400).json({ success: false, message: 'All customer fields except Total Obligation are required.' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
      }

      const parsedNetSalary = parseFloat(net_salary);
      const parsedTotalObligation = total_obligation !== undefined && total_obligation !== null && total_obligation !== '' ? parseFloat(total_obligation) : 0;

      if (isNaN(parsedNetSalary) || parsedNetSalary < 0) {
        return res.status(400).json({ success: false, message: 'Net Salary must be a non-negative number.' });
      }
      if (isNaN(parsedTotalObligation) || parsedTotalObligation < 0) {
        return res.status(400).json({ success: false, message: 'Total Obligation must be a non-negative number.' });
      }

      const id = await CustomerModel.create({
        name,
        phone,
        email,
        address,
        area,
        net_salary: parsedNetSalary,
        total_obligation: parsedTotalObligation,
        added_by: req.user.id
      });
      const customer = await CustomerModel.findById(id);
      
      // WhatsApp workflow trigger: Lead Created (Welcome Message)
      whatsappService.sendWorkflowMessage('Welcome Message', id, { employee_id: req.user.id });

      return res.status(201).json({ success: true, message: 'Customer added successfully.', id, customer });
    } catch (err) {
      console.error('[Employee] Add customer error:', err);
      return res.status(500).json({ success: false, message: 'Failed to add customer.' });
    }
  },

  async getCustomerDetail(req, res) {
    try {
      const { id } = req.params;
      const customer = await CustomerModel.findById(id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

      const documents = await DocumentModel.getByCustomer(id);
      const loans = await LoanModel.getAll({ applied_by: req.user.id });
      const customerLoans = loans.filter(l => l.customer_id === parseInt(id));

      return res.json({ success: true, data: { customer, documents, loans: customerLoans } });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch customer details.' });
    }
  },

  async deleteCustomer(req, res) {
    try {
      const { id } = req.params;
      const customer = await CustomerModel.findById(id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

      // Check if customer has loans
      const loans = await LoanModel.getAll({ customer_id: parseInt(id) });
      if (loans.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete customer with existing loans.',
          loansCount: loans.length
        });
      }

      await CustomerModel.delete(id);
      return res.json({ success: true, message: 'Customer deleted successfully.' });
    } catch (err) {
      console.error('[Employee] Delete customer error:', err);
      return res.status(500).json({ success: false, message: 'Failed to delete customer.' });
    }
  },

  async deleteCustomersBulk(req, res) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No ids provided.' });
      }

      const results = [];
      for (const rawId of ids) {
        const id = parseInt(rawId);
        try {
          const customer = await CustomerModel.findById(id);
          if (!customer) {
            results.push({ id, success: false, reason: 'Not Found' });
            continue;
          }

          const loans = await LoanModel.getAll({ customer_id: id });
          if (loans.length > 0) {
            results.push({ id, success: false, reason: 'Has existing loans', loansCount: loans.length });
            continue;
          }

          const affected = await CustomerModel.delete(id);
          if (affected) results.push({ id, success: true });
          else results.push({ id, success: false, reason: 'Delete failed' });
        } catch (err) {
          results.push({ id, success: false, reason: err.message || 'Error' });
        }
      }

      return res.json({ success: true, results });
    } catch (err) {
      console.error('[Employee] Bulk delete error:', err);
      return res.status(500).json({ success: false, message: 'Bulk delete failed.' });
    }
  },


  // ── Documents ───────────────────────────────────────────────
  async uploadDocuments(req, res) {
    try {
      const { customerId } = req.params;
      const { doc_type, document_password } = req.body;

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
      }

      const customer = await CustomerModel.findById(customerId);
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
      }

      const uploadedDocuments = [];

      for (const file of files) {
        const filePath = `/uploads/customer_${customerId}/${file.filename}`;
        let fileData = null;
        try {
          if (file.path && fs.existsSync(file.path)) {
            fileData = fs.readFileSync(file.path);
          }
        } catch (readErr) {
          console.error('[Employee] Error reading file into buffer:', readErr.message);
        }

        const id = await DocumentModel.create({
          customer_id: customerId,
          doc_type: doc_type || 'Other',
          document_password: document_password || null,
          file_name: file.originalname,
          file_path: filePath,
          uploaded_by: req.user.id,
          file_data: fileData
        });
        const document = await DocumentModel.findById(id);
        uploadedDocuments.push({ id, file_path: filePath, document });
      }

      return res.status(201).json({
        success: true,
        message: 'Documents uploaded successfully.',
        ids: uploadedDocuments.map((item) => item.id),
        file_paths: uploadedDocuments.map((item) => item.file_path),
        documents: uploadedDocuments.map((item) => item.document)
      });
    } catch (err) {
      console.error('[Employee] Upload error:', err);
      return res.status(500).json({ success: false, message: 'Document upload failed.' });
    }
  },

  // ── Loans ───────────────────────────────────────────────────
  async getLoans(req, res) {
    try {
      const { 
        status, 
        period, 
        startDate, 
        endDate,
        loginStartDate,
        loginEndDate,
        uploadStartDate,
        uploadEndDate,
        disbursementStartDate,
        disbursementEndDate,
        periodDateType
      } = req.query;
      const loans = await LoanModel.getAll({ 
        applied_by: req.user.id, 
        status, 
        period, 
        startDate, 
        endDate,
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
      console.error('[Employee] Fetch loans error:', err);
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
      
      // Check authorization (employee can only view their own loan detail)
      if (loan.applied_by !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      const history = await LoanModel.getHistory(id);
      return res.json({ success: true, data: { loan, history } });
    } catch (err) {
      console.error('[Employee] Fetch loan detail error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch loan details.' });
    }
  },

  async createLoan(req, res) {
    try {
      const { customer_id, amount, purpose } = req.body;
      if (!customer_id || !amount) {
        return res.status(400).json({ success: false, message: 'Customer and amount are required.' });
      }

      const customer = await CustomerModel.findById(customer_id);
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
      }

      const id = await LoanModel.create({ customer_id, amount, purpose, applied_by: req.user.id });
      
      // WhatsApp workflow trigger: Application Submitted (Confirmation Message)
      whatsappService.sendWorkflowMessage('Application Submitted', customer_id, {
        loan_number: 'LN-' + id,
        loan_amount: amount,
        employee_id: req.user.id
      });

      return res.status(201).json({ success: true, message: 'Loan application created.', id });
    } catch (err) {
      console.error('[Employee] Create loan error:', err);
      return res.status(500).json({ success: false, message: 'Failed to create loan.' });
    }
  },

  async updateLoanStatus(req, res) {
    const { id } = req.params;
    const { status, notes, login_date, system_upload_date, disbursement_date, disbursement_amount } = req.body;
    console.log(`[Employee] Incoming status update request - Loan ID: ${id}, Employee ID: ${req?.user?.id}, Payload:`, req.body);

    try {
      const allowedStatuses = ['Pending', 'Under Review', 'Documents Pending', 'Approved', 'Rejected', 'Loan Disbursed', 'Cancelled', 'Hold', 'ABND', 'Other'];
      if (!allowedStatuses.includes(status)) {
        console.warn(`[Employee] Invalid status update attempt - Status: ${status}`);
        return res.status(400).json({ success: false, message: `Invalid status: ${status}. Allowed values are: ${allowedStatuses.join(', ')}` });
      }

      if (['Rejected', 'Hold', 'Cancelled'].includes(status) && (!notes || !notes.trim())) {
        console.warn(`[Employee] Missing remarks for status: ${status}`);
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
        console.warn(`[Employee] Loan record not found - Loan ID: ${id}`);
        return res.status(404).json({ success: false, message: 'Loan record not found.' });
      }

      // Check authorization
      if (loan.applied_by !== req.user.id) {
        console.warn(`[Employee] Access denied for user ${req.user.id} trying to update loan ${id} owned by ${loan.applied_by}`);
        return res.status(403).json({ success: false, message: 'Access denied.' });
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

      console.log(`[Employee] Loan status updated successfully in DB - Loan ID: ${id}, Affected Rows: ${affectedRows}`);

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
          console.log(`[Employee] WhatsApp workflow message sent for Category: ${triggerCategory}, Customer ID: ${loan.customer_id}`);
        } catch (wsErr) {
          console.error('[Employee] WhatsApp notification trigger error:', wsErr);
        }
      }

      return res.json({ success: true, message: `Loan status updated to ${status}.` });
    } catch (err) {
      console.error(`[Employee] Error updating status for Loan ID ${id}:`, err.stack || err);
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

  async deleteLoan(req, res) {
    try {
      const { id } = req.params;
      const loan = await LoanModel.findById(id);
      if (!loan) {
        return res.status(404).json({ success: false, message: 'Loan record not found.' });
      }

      // Check authorization
      if (loan.applied_by !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own loan applications.' });
      }

      await LoanModel.delete(id);
      return res.json({ success: true, message: 'Loan record deleted successfully.' });
    } catch (err) {
      console.error('[Employee] Delete loan error:', err);
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
            // Check authorization
            if (loan.applied_by !== req.user.id) {
              results.push({ id, success: false, reason: 'Access denied: Not applied by you' });
              continue;
            }
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
      console.error('[Employee] Bulk delete loans error:', err);
      return res.status(500).json({ success: false, message: 'Bulk delete loans failed.' });
    }
  },

  async deleteDocument(req, res) {
    try {
      const { id } = req.params;
      const document = await DocumentModel.findById(id);
      if (!document) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }

      // Try to delete physical file from disk
      if (document.file_path) {
        const fullDiskPath = path.join(__dirname, '..', document.file_path);
        try {
          if (fs.existsSync(fullDiskPath)) {
            fs.unlinkSync(fullDiskPath);
          }
        } catch (fileErr) {
          console.warn('[Employee] Warning: Failed to delete physical document file:', fileErr.message);
        }
      }

      // Delete from database
      await DocumentModel.delete(id);

      return res.json({ success: true, message: 'Document deleted successfully.' });
    } catch (err) {
      console.error('[Employee] Delete document error:', err);
      return res.status(500).json({ success: false, message: 'Failed to delete document.' });
    }
  },

  async getAreas(req, res) {
    try {
      const areas = await CustomerModel.getAreas();
      return res.json({ success: true, data: areas });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to fetch areas.' });
    }
  }
};

module.exports = employeeController;

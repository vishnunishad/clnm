const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const adminController = require('../controllers/adminController');

// All routes require admin JWT
router.use(requireAdmin);

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// Employees
router.get('/employees', adminController.getEmployees);
router.post('/employees', adminController.addEmployee);
router.patch('/employees/:id/deactivate', adminController.deactivateEmployee);
router.patch('/employees/:id/activate', adminController.activateEmployee);
router.post('/employees/:id/deactivate', adminController.deactivateEmployee);
router.post('/employees/:id/activate', adminController.activateEmployee);
router.post('/employees/:id/override', adminController.activateOverride);
router.post('/employees/:id/remove-override', adminController.removeOverride);
router.patch('/employees/:id/password', adminController.updateEmployeePassword);
router.post('/employees/:id/password', adminController.updateEmployeePassword);

// Customers
router.get('/customers', adminController.getCustomers);
router.get('/customers/export', adminController.exportCustomers);
router.get('/customers/:id', adminController.getCustomerDetail);

// Loans
router.get('/loans', adminController.getLoans);
router.get('/loans/:id', adminController.getLoanDetail);
router.patch('/loans/:id/status', adminController.updateLoanStatus);
router.delete('/loans/:id', adminController.deleteLoan);
router.post('/loans/delete', adminController.deleteLoansBulk);

// Working Hours
router.get('/working-hours', adminController.getWorkingHours);
router.put('/working-hours', adminController.updateWorkingHours);

// Utilities
router.get('/areas', adminController.getAreas);

// Export
router.get('/reports/export', adminController.exportLoans);

module.exports = router;

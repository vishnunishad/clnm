const express = require('express');
const router = express.Router();
const { requireEmployee } = require('../middleware/auth');
const employeeController = require('../controllers/employeeController');
const upload = require('../middleware/upload');

// All routes require employee JWT
router.use(requireEmployee);

// Dashboard
router.get('/dashboard', employeeController.getDashboard);

// Customers
router.get('/customers', employeeController.getCustomers);
router.post('/customers', employeeController.addCustomer);
router.post('/customers/delete', employeeController.deleteCustomersBulk);
router.get('/customers/:id', employeeController.getCustomerDetail);
router.delete('/customers/:id', employeeController.deleteCustomer);

// Documents
router.post('/documents/:customerId', upload.array('documents'), employeeController.uploadDocuments);
router.delete('/documents/:id', employeeController.deleteDocument);

// Loans
router.get('/loans', employeeController.getLoans);
router.get('/loans/:id', employeeController.getLoanDetail);
router.post('/loans', employeeController.createLoan);
router.patch('/loans/:id/status', employeeController.updateLoanStatus);
router.delete('/loans/:id', employeeController.deleteLoan);
router.post('/loans/delete', employeeController.deleteLoansBulk);

// Utilities
router.get('/areas', employeeController.getAreas);

module.exports = router;

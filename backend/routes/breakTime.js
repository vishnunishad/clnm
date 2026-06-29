const express = require('express');
const router = express.Router();
const breakTimeController = require('../controllers/breakTimeController');
const { requireAdmin, requireEmployee } = require('../middleware/auth');

// Heartbeat (updates status, accessible to logged-in users)
router.post('/heartbeat', breakTimeController.heartbeat);

// Employee-specific endpoints
router.get('/status', requireEmployee, breakTimeController.getStatus);
router.post('/start', requireEmployee, breakTimeController.startBreak);
router.post('/end', requireEmployee, breakTimeController.endBreak);
router.get('/history', requireEmployee, breakTimeController.getHistory);
router.get('/rules', breakTimeController.getRules); // Shared: employees need allowed durations for timer warnings

// Admin-specific monitoring and configuration endpoints
router.get('/admin/monitoring', requireAdmin, breakTimeController.getAdminMonitoring);
router.get('/admin/analytics', requireAdmin, breakTimeController.getAdminAnalytics);
router.get('/admin/violations', requireAdmin, breakTimeController.getAdminViolations);
router.get('/admin/rules', requireAdmin, breakTimeController.getRules);
router.post('/admin/rules', requireAdmin, breakTimeController.updateRules);
router.get('/admin/history', requireAdmin, breakTimeController.getAdminHistory);

// Deletions
router.delete('/admin/records/:id', requireAdmin, breakTimeController.deleteRecord);
router.post('/admin/records/delete-bulk', requireAdmin, breakTimeController.deleteRecordsBulk);
router.post('/admin/records/delete-all', requireAdmin, breakTimeController.deleteAllRecords);
router.post('/admin/records/delete-range', requireAdmin, breakTimeController.deleteRecordsRange);

// Attendance
router.get('/admin/attendance/monitoring', requireAdmin, breakTimeController.getAdminAttendanceMonitoring);
router.get('/admin/attendance/history', requireAdmin, breakTimeController.getAdminAttendanceHistory);
router.get('/admin/attendance/analytics', requireAdmin, breakTimeController.getAdminAttendanceAnalytics);

// Employee Login Hours
router.get('/admin/login-hours', requireAdmin, breakTimeController.getLoginHoursReport);
router.get('/admin/login-hours/summary', requireAdmin, breakTimeController.getLoginHoursSummary);
router.get('/admin/login-hours/analytics', requireAdmin, breakTimeController.getLoginHoursAnalytics);
router.get('/admin/login-hours/:id/detail', requireAdmin, breakTimeController.getLoginHoursEmployeeDetail);

module.exports = router;


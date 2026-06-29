const express = require('express');
const router = express.Router();
const aprController = require('../controllers/aprController');
const { requireAdmin, requireEmployee } = require('../middleware/auth');

// ── Admin APR Endpoints ──────────────────────────────────────────
router.get('/admin/dashboard', requireAdmin, aprController.getAdminDashboardStats);
router.get('/admin/live-attendance', requireAdmin, aprController.getLiveAttendance);
router.get('/admin/daily-report', requireAdmin, aprController.getDailyLoginReport);
router.get('/admin/login-history', requireAdmin, aprController.getLoginHistory);
router.get('/admin/analytics', requireAdmin, aprController.getAttendanceAnalytics);
router.get('/admin/performance', requireAdmin, aprController.getPerformanceReport);
router.get('/admin/break-analytics', requireAdmin, aprController.getBreakAnalytics);
router.get('/admin/working-hours', requireAdmin, aprController.getWorkingHours);
router.get('/admin/leaderboard', requireAdmin, aprController.getLeaderboard);
router.get('/admin/live-breaks', requireAdmin, aprController.getLiveBreaks);

// ── Employee APR Endpoints ───────────────────────────────────────
router.get('/employee/dashboard', requireEmployee, aprController.getEmployeeDashboard);
router.get('/employee/break/history', requireEmployee, aprController.getEmployeeBreakHistory);

module.exports = router;

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, forgotPasswordLimiter } = require('../middleware/rateLimit');

// Login endpoint
router.post('/login', loginLimiter, authController.login);

router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Get current user info
router.get('/me', requireAuth, authController.getMe);

// Logout endpoint
router.post('/logout', requireAuth, authController.logout);

module.exports = router;

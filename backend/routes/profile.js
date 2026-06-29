const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const profileController = require('../controllers/profileController');

// ── Upload directories ─────────────────────────────────────────────────────
const profilePicsDir = path.join(__dirname, '..', 'uploads', 'profile_pics');
const kycDocsDir     = path.join(__dirname, '..', 'uploads', 'kyc_docs');
if (!fs.existsSync(profilePicsDir)) fs.mkdirSync(profilePicsDir, { recursive: true });
if (!fs.existsSync(kycDocsDir))     fs.mkdirSync(kycDocsDir,     { recursive: true });

// ── Multer — avatar (images only) ────────────────────────────────────────
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profilePicsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  }
});
const avatarFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
  else cb(new Error('Only JPG, PNG, and WEBP files are allowed for avatars.'));
};
const uploadAvatar = multer({ storage: avatarStorage, fileFilter: avatarFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Multer — KYC documents (images + PDF) ─────────────────────────────────
const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, kycDocsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const type = req.body?.doc_type || 'doc';
    cb(null, `kyc_${req.user.id}_${type}_${Date.now()}${ext}`);
  }
});
const kycFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
  if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
  else cb(new Error('Only JPG, PNG, WEBP, and PDF files are allowed for documents.'));
};
const uploadKYC = multer({ storage: kycStorage, fileFilter: kycFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Error handler helper ───────────────────────────────────────────────────
function handleUploadError(err, req, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'File too large. Maximum 5MB allowed.' });
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err) return res.status(400).json({ success: false, message: err.message });
}

// ── Routes (all require auth) ──────────────────────────────────────────────
router.get('/',                            requireAuth, profileController.getProfile);
router.put('/personal-info',               requireAuth, profileController.updatePersonalInfo);
router.put('/account-settings',            requireAuth, profileController.updateAccountSettings);
router.put('/change-password',             requireAuth, profileController.changePassword);
router.put('/bank-details',                requireAuth, profileController.updateBankDetails);
router.put('/emergency-contact',           requireAuth, profileController.updateEmergencyContact);
router.put('/notification-preferences',   requireAuth, profileController.updateNotificationPreferences);
router.delete('/avatar',                   requireAuth, profileController.removeAvatar);

// Avatar upload
router.post('/upload-avatar', requireAuth, (req, res, next) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return handleUploadError(err, req, res);
    next();
  });
}, profileController.uploadAvatar);

// KYC doc upload
router.post('/upload-kyc', requireAuth, (req, res, next) => {
  uploadKYC.single('document')(req, res, (err) => {
    if (err) return handleUploadError(err, req, res);
    next();
  });
}, profileController.uploadKYCDoc);

// Admin-only employee view
router.get('/admin/employees/:id',          requireAdmin, profileController.adminGetEmployeeProfile);
router.put('/admin/employees/:id/verify',   requireAdmin, profileController.adminVerifyEmployeeKYC);

module.exports = router;

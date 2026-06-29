const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const whatsappController = require('../controllers/whatsappController');
const upload = require('../middleware/upload');

// All whatsapp endpoints require token authentication
router.use(requireAuth);

// Dashboard Overview metrics
router.get('/stats', whatsappController.getDashboardStats);

// ── Connection Management ────────────────────────────────────────────────────
// Read-only status (both admin and employee)
router.get('/connection', whatsappController.getConnectionStatus);

// SSE stream: browser subscribes to receive live QR + connection events (admin only)
router.get('/qr-stream', requireAdmin, whatsappController.qrStream);

// Initiate a new pairing session (admin only)
router.post('/connection/connect', requireAdmin, whatsappController.connectWhatsApp);

// Disconnect / logout (admin only)
router.post('/connection/disconnect', requireAdmin, whatsappController.disconnectWhatsApp);

// Force restart without clearing session (admin only)
router.post('/connection/reconnect', requireAdmin, whatsappController.reconnectWhatsApp);

// ── Templates (Read allowed for all, create/edit/delete restricted to Admin) ──
router.get('/templates', whatsappController.getTemplates);
router.post('/templates', requireAdmin, whatsappController.createTemplate);
router.patch('/templates/:id', requireAdmin, whatsappController.updateTemplate);
router.delete('/templates/:id', requireAdmin, whatsappController.deleteTemplate);
router.post('/templates/:id/duplicate', requireAdmin, whatsappController.duplicateTemplate);

// ── Campaigns ────────────────────────────────────────────────────────────────
router.get('/campaigns', whatsappController.getCampaigns);
router.post('/campaigns', whatsappController.createCampaign);
router.post('/campaigns/:id/action', whatsappController.campaignAction);

// ── Chat History & Direct Sender ─────────────────────────────────────────────
router.get('/messages', whatsappController.getMessages);
router.post('/messages', upload.single('attachment'), whatsappController.sendDirectMessage);

module.exports = router;

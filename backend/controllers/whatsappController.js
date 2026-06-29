const db               = require('../config/db');
const whatsappService  = require('../utils/whatsappService');
const baileysSession   = require('../utils/baileys-session');

const whatsappController = {

  // ── SSE QR Stream ──────────────────────────────────────────────────────────
  /**
   * GET /api/whatsapp/qr-stream
   * Admin-only Server-Sent Events endpoint.
   * The browser keeps this connection open and receives:
   *   event: qr         → { qr: "<base64 data URL>" }
   *   event: connected  → { status, phone, name, sessionId, connectedAt }
   *   event: disconnected → { status, reason? }
   *   event: heartbeat  → { ts } (every 20s to keep connection alive)
   */
  qrStream(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();

    // Register this response with the session manager
    baileysSession.registerSseClient(res);

    // Heartbeat to keep the connection alive through proxies / load balancers
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch (_) {}
    }, 20000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      baileysSession.unregisterSseClient(res);
    });
  },

  // ── Connection Manager ─────────────────────────────────────────────────────

  async getConnectionStatus(req, res) {
    try {
      const [rows] = await db.query('SELECT * FROM whatsapp_connections LIMIT 1');
      if (rows.length === 0) {
        return res.json({
          success: true,
          data: { status: 'Disconnected', device_name: null, device_phone: null, last_connected_at: null }
        });
      }
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async connectWhatsApp(req, res) {
    try {
      // Start the real Baileys session — QR events will stream via SSE
      baileysSession.startSession().catch((err) => {
        console.error('[WhatsApp] Session start error:', err.message);
      });

      // Immediately mark DB as Connecting so the UI shows the right state
      await db.query(
        "UPDATE whatsapp_connections SET status = 'Connecting', qr_code = NULL WHERE id = 1"
      );

      return res.json({
        success  : true,
        streaming: true,
        message  : 'Session starting — subscribe to /api/whatsapp/qr-stream for live QR.'
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async disconnectWhatsApp(req, res) {
    try {
      await baileysSession.logout();
      return res.json({ success: true, status: 'Disconnected' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async reconnectWhatsApp(req, res) {
    try {
      await baileysSession.restart();
      return res.json({ success: true, message: 'Session restarting…' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Templates CRUD ─────────────────────────────────────────────────────────

  async getTemplates(req, res) {
    try {
      const [rows] = await db.query(
        'SELECT t.*, u.name as creator_name FROM whatsapp_templates t LEFT JOIN users u ON t.created_by = u.id ORDER BY t.name ASC'
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async createTemplate(req, res) {
    try {
      const { name, category, content } = req.body;
      if (!name || !category || !content) {
        return res.status(400).json({ success: false, message: 'All template fields are required.' });
      }
      await db.query(
        'INSERT INTO whatsapp_templates (name, category, content, created_by) VALUES (?, ?, ?, ?)',
        [name, category, content, req.user.id]
      );
      return res.status(201).json({ success: true, message: 'Template created successfully.' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ success: false, message: 'Template name must be unique.' });
      }
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async updateTemplate(req, res) {
    try {
      const { id } = req.params;
      const { name, category, content } = req.body;
      if (!name || !category || !content) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
      }
      await db.query(
        'UPDATE whatsapp_templates SET name = ?, category = ?, content = ? WHERE id = ?',
        [name, category, content, id]
      );
      return res.json({ success: true, message: 'Template updated successfully.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteTemplate(req, res) {
    try {
      const { id } = req.params;
      await db.query('DELETE FROM whatsapp_templates WHERE id = ?', [id]);
      return res.json({ success: true, message: 'Template deleted successfully.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async duplicateTemplate(req, res) {
    try {
      const { id } = req.params;
      const [rows] = await db.query('SELECT * FROM whatsapp_templates WHERE id = ?', [id]);
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Template not found.' });
      }
      const original = rows[0];
      const dupName  = `${original.name} (Copy) - ${Date.now()}`;
      await db.query(
        'INSERT INTO whatsapp_templates (name, category, content, created_by) VALUES (?, ?, ?, ?)',
        [dupName, original.category, original.content, req.user.id]
      );
      return res.json({ success: true, message: 'Template duplicated successfully.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Campaigns Manager ──────────────────────────────────────────────────────

  async getCampaigns(req, res) {
    try {
      let query = `
        SELECT c.*, t.name as template_name, u.name as creator_name 
        FROM whatsapp_campaigns c 
        LEFT JOIN whatsapp_templates t ON c.template_id = t.id 
        LEFT JOIN users u ON c.created_by = u.id
      `;
      let params = [];

      if (req.user.role === 'employee') {
        query += ' WHERE c.created_by = ?';
        params.push(req.user.id);
      }

      query += ' ORDER BY c.created_at DESC';
      const [rows] = await db.query(query, params);
      return res.json({ success: true, data: rows });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async createCampaign(req, res) {
    try {
      const { name, type, templateId, audienceArea, scheduledAt, status, manualRecipients } = req.body;
      if (!name || !type || !templateId) {
        return res.status(400).json({ success: false, message: 'Required fields missing.' });
      }

      const [cRes] = await db.query(
        `INSERT INTO whatsapp_campaigns (name, type, template_id, audience_area, scheduled_at, status, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, type, templateId, audienceArea || null, scheduledAt || null, status || 'Draft', req.user.id]
      );
      const campaignId = cRes.insertId;

      if (status === 'Running') {
        whatsappController.executeSimulatedCampaign(campaignId, req.user.id, manualRecipients);
      }

      return res.status(201).json({ success: true, message: 'Campaign created successfully.', campaignId });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  async executeSimulatedCampaign(campaignId, employeeId, manualRecipients = null) {
    try {
      const [campRows] = await db.query('SELECT * FROM whatsapp_campaigns WHERE id = ?', [campaignId]);
      if (campRows.length === 0) return;
      const campaign = campRows[0];

      const [tempRows] = await db.query('SELECT content FROM whatsapp_templates WHERE id = ?', [campaign.template_id]);
      if (tempRows.length === 0) return;
      const contentTemplate = tempRows[0].content;

      let recipients = [];

      if (manualRecipients && manualRecipients.length > 0) {
        recipients = manualRecipients;
      } else {
        let q = 'SELECT name, phone FROM customers';
        let p = [];
        if (campaign.audience_area && campaign.audience_area !== 'All') {
          q += ' WHERE area = ?';
          p.push(campaign.audience_area);
        }
        const [custs] = await db.query(q, p);
        recipients = custs;
      }

      if (recipients.length === 0) {
        await db.query("UPDATE whatsapp_campaigns SET status = 'Completed' WHERE id = ?", [campaignId]);
        return;
      }

      let index = 0;
      const interval = setInterval(async () => {
        if (index >= recipients.length) {
          clearInterval(interval);
          await db.query("UPDATE whatsapp_campaigns SET status = 'Completed' WHERE id = ?", [campaignId]);
          return;
        }

        const r = recipients[index];
        const text = whatsappService.parseTemplate(contentTemplate, {
          customer_name: r.name,
          loan_number  : 'LN-' + Math.floor(100000 + Math.random() * 900000),
          loan_amount  : '5,00,000',
          branch_name  : 'Main Branch'
        });

        await whatsappService.sendMessage({
          customerName: r.name,
          phone       : r.phone,
          content     : text,
          employeeId,
          campaignId
        });

        // Also try real send via Baileys if session is active
        try {
          await baileysSession.sendWhatsAppMessage(r.phone, text);
        } catch (_) { /* session may not be active */ }

        index++;
      }, 1200);
    } catch (err) {
      console.error('[WhatsApp Campaign] Error:', err.message);
      await db.query("UPDATE whatsapp_campaigns SET status = 'Failed' WHERE id = ?", [campaignId]);
    }
  },

  async campaignAction(req, res) {
    try {
      const { id } = req.params;
      const { action } = req.body;

      let newStatus = 'Running';
      if (action === 'pause')  newStatus = 'Paused';
      else if (action === 'cancel') newStatus = 'Draft';
      else if (action === 'resume') newStatus = 'Running';

      await db.query('UPDATE whatsapp_campaigns SET status = ? WHERE id = ?', [newStatus, id]);

      if (action === 'resume') {
        const [rows] = await db.query('SELECT created_by FROM whatsapp_campaigns WHERE id = ?', [id]);
        if (rows.length > 0) {
          whatsappController.executeSimulatedCampaign(id, rows[0].created_by);
        }
      }

      return res.json({ success: true, message: `Campaign status updated to ${newStatus}.` });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Direct Sender ──────────────────────────────────────────────────────────

  async sendDirectMessage(req, res) {
    try {
      const { phone, customerName, templateId, customMessage } = req.body;
      if (!phone || !customerName) {
        return res.status(400).json({ success: false, message: 'Phone number and customer name are required.' });
      }

      let content = customMessage || '';

      if (templateId) {
        const [tempRows] = await db.query(
          'SELECT content FROM whatsapp_templates WHERE id = ? LIMIT 1', [templateId]
        );
        if (tempRows.length > 0) {
          content = whatsappService.parseTemplate(tempRows[0].content, {
            customer_name: customerName,
            loan_number  : 'N/A',
            loan_amount  : 'N/A',
            branch_name  : 'Main Branch'
          });
        }
      }

      let attachmentName = null;
      let attachmentPath = null;
      if (req.file) {
        attachmentName = req.file.originalname;
        attachmentPath = '/uploads/' + req.file.filename;
      }

      // 1. Log to DB first (always works, even if WhatsApp is offline)
      const result = await whatsappService.sendMessage({
        customerName,
        phone,
        content,
        employeeId    : req.user.id,
        attachmentName,
        attachmentPath
      });

      // 2. Attempt real WhatsApp delivery via Baileys
      let waDelivered = false;
      try {
        await baileysSession.sendWhatsAppMessage(phone, content);
        waDelivered = true;
        // Update message status to Delivered
        if (result?.messageId) {
          await db.query(
            "UPDATE whatsapp_messages SET status = 'Delivered' WHERE id = ?",
            [result.messageId]
          );
        }
      } catch (waErr) {
        console.warn('[WhatsApp] Real send failed (session may be inactive):', waErr.message);
        // Message is still logged in DB with 'Sent' status
      }

      if (result.success) {
        return res.json({
          success    : true,
          message    : waDelivered
            ? 'Message sent successfully via WhatsApp!'
            : 'Message logged. WhatsApp session is not active — connect first for real delivery.',
          waDelivered,
          data       : result
        });
      } else {
        return res.status(500).json({ success: false, message: 'Failed to log message.', error: result.error });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Message Logs ───────────────────────────────────────────────────────────

  async getMessages(req, res) {
    try {
      const { period, startDate, endDate, status, employeeId, search } = req.query;
      let query = `
        SELECT m.*, u.name as employee_name, c.name as campaign_name 
        FROM whatsapp_messages m 
        LEFT JOIN users u ON m.employee_id = u.id 
        LEFT JOIN whatsapp_campaigns c ON m.campaign_id = c.id
      `;
      let params     = [];
      let conditions = [];

      if (req.user.role === 'employee') {
        conditions.push('m.employee_id = ?');
        params.push(req.user.id);
      } else if (employeeId) {
        conditions.push('m.employee_id = ?');
        params.push(employeeId);
      }

      if (status)  { conditions.push('m.status = ?'); params.push(status); }

      if (search) {
        conditions.push('(m.phone LIKE ? OR m.customer_name LIKE ? OR m.content LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      if (period === 'custom' && startDate && endDate) {
        conditions.push('m.created_at >= ? AND m.created_at <= ?');
        params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
      } else if (period === 'week') {
        conditions.push('m.created_at >= DATE_SUB(NOW(), INTERVAL 1 WEEK)');
      } else if (period === 'month') {
        conditions.push('m.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)');
      } else if (period === 'year') {
        conditions.push('m.created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)');
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY m.created_at DESC';

      const [rows] = await db.query(query, params);
      return res.json({ success: true, data: rows });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Dashboard Stats ────────────────────────────────────────────────────────

  async getDashboardStats(req, res) {
    try {
      let isEmployee = req.user.role === 'employee';
      let userId     = req.user.id;

      let statsQuery = `
        SELECT 
          COUNT(*) as total_sent,
          SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN status = 'Read' THEN 1 ELSE 0 END) as read_count,
          SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as failed
        FROM whatsapp_messages
      `;
      let params = [];
      if (isEmployee) { statsQuery += ' WHERE employee_id = ?'; params.push(userId); }
      const [msgRows] = await db.query(statsQuery, params);
      const metrics   = msgRows[0] || { total_sent: 0, delivered: 0, read_count: 0, failed: 0 };

      let todayQuery  = "SELECT COUNT(*) as count FROM whatsapp_messages WHERE DATE(created_at) = CURDATE()";
      let todayParams = [];
      if (isEmployee) { todayQuery += " AND employee_id = ?"; todayParams.push(userId); }
      const [todayRows] = await db.query(todayQuery, todayParams);

      const [connRows] = await db.query('SELECT status FROM whatsapp_connections LIMIT 1');
      const connStatus = connRows.length > 0 ? connRows[0].status : 'Disconnected';

      let campQuery = `
        SELECT 
          SUM(CASE WHEN status = 'Running' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'Scheduled' THEN 1 ELSE 0 END) as scheduled
        FROM whatsapp_campaigns
      `;
      let campParams = [];
      if (isEmployee) { campQuery += ' WHERE created_by = ?'; campParams.push(userId); }
      const [campRows]  = await db.query(campQuery, campParams);
      const campCounts  = campRows[0] || { active: 0, scheduled: 0 };

      let dailyQuery = `
        SELECT DATE(created_at) as date, COUNT(*) as count 
        FROM whatsapp_messages 
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      `;
      let dailyParams = [];
      if (isEmployee) { dailyQuery += ' AND employee_id = ?'; dailyParams.push(userId); }
      dailyQuery += ' GROUP BY DATE(created_at) ORDER BY date ASC';
      const [dailyRows] = await db.query(dailyQuery, dailyParams);

      let monthlyQuery = `
        SELECT DATE_FORMAT(created_at, '%b %Y') as month, COUNT(*) as count 
        FROM whatsapp_messages 
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      `;
      let monthlyParams = [];
      if (isEmployee) { monthlyQuery += ' AND employee_id = ?'; monthlyParams.push(userId); }
      monthlyQuery += " GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b %Y') ORDER BY DATE_FORMAT(created_at, '%Y-%m') ASC";
      const [monthlyRows] = await db.query(monthlyQuery, monthlyParams);

      return res.json({
        success: true,
        summary: {
          sent              : metrics.total_sent,
          delivered         : metrics.delivered,
          read              : metrics.read_count,
          failed            : metrics.failed,
          today             : todayRows[0]?.count || 0,
          activeCampaigns   : campCounts.active || 0,
          scheduledCampaigns: campCounts.scheduled || 0,
          connectionStatus  : connStatus
        },
        dailyTrend  : dailyRows,
        monthlyTrend: monthlyRows
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
};

module.exports = whatsappController;

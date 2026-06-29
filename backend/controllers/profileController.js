const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');

// ── Helper: log user activity ──────────────────────────────────────────────
async function logActivity(userId, activity, req, status = 'Success') {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  await db.query(
    'INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, ?, ?)',
    [userId, activity, status, ip]
  ).catch(() => {});
}

const profileController = {

  // ── GET /api/profile ──────────────────────────────────────────────────────
  async getProfile(req, res) {
    try {
      const userId = req.user.id;

      const [userRows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
      if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found.' });

      const user = { ...userRows[0] };
      delete user.password; // Never expose password hash

      const [[bank]] = await db.query('SELECT * FROM bank_details WHERE user_id = ?', [userId]);
      const [[emergency]] = await db.query('SELECT * FROM emergency_contacts WHERE user_id = ?', [userId]);
      const [[notifications]] = await db.query('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
      const [loginHistory] = await db.query(
        'SELECT * FROM login_history WHERE user_id = ? ORDER BY login_time DESC LIMIT 10',
        [userId]
      );
      const [activityLogs] = await db.query(
        'SELECT * FROM user_activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
        [userId]
      );

      return res.json({
        success: true,
        data: {
          user,
          bank: bank || null,
          emergency: emergency || null,
          notifications: notifications || null,
          loginHistory,
          activityLogs
        }
      });
    } catch (err) {
      console.error('[Profile] getProfile error:', err);
      return res.status(500).json({ success: false, message: 'Failed to load profile.' });
    }
  },

  // ── PUT /api/profile/personal-info ────────────────────────────────────────
  async updatePersonalInfo(req, res) {
    try {
      const userId = req.user.id;
      const {
        date_of_birth, gender, address, permanent_address,
        city, state, country, postal_code
      } = req.body;

      await db.query(
        `UPDATE users SET date_of_birth=?, gender=?, address=?, permanent_address=?,
         city=?, state=?, country=?, postal_code=? WHERE id=?`,
        [date_of_birth || null, gender || null, address || null, permanent_address || null,
         city || null, state || null, country || null, postal_code || null, userId]
      );

      await logActivity(userId, 'Updated personal information', req);
      return res.json({ success: true, message: 'Personal information updated successfully.' });
    } catch (err) {
      console.error('[Profile] updatePersonalInfo error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update personal information.' });
    }
  },

  // ── PUT /api/profile/account-settings ────────────────────────────────────
  async updateAccountSettings(req, res) {
    try {
      const userId = req.user.id;
      const { name, username, email, phone } = req.body;

      if (!name || !email) {
        return res.status(400).json({ success: false, message: 'Name and email are required.' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Invalid email format.' });
      }

      // Check for duplicate email
      const [emailCheck] = await db.query(
        'SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]
      );
      if (emailCheck.length) {
        return res.status(400).json({ success: false, message: 'Email is already used by another account.' });
      }

      // Check for duplicate username (if provided)
      if (username) {
        const [usernameCheck] = await db.query(
          'SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]
        );
        if (usernameCheck.length) {
          return res.status(400).json({ success: false, message: 'Username is already taken.' });
        }
      }

      await db.query(
        'UPDATE users SET name=?, username=?, email=?, phone=? WHERE id=?',
        [name.trim(), username?.trim() || null, email.trim().toLowerCase(), phone?.trim() || null, userId]
      );

      await logActivity(userId, 'Updated account settings', req);
      return res.json({ success: true, message: 'Account settings updated successfully.' });
    } catch (err) {
      console.error('[Profile] updateAccountSettings error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update account settings.' });
    }
  },

  // ── PUT /api/profile/change-password ─────────────────────────────────────
  async changePassword(req, res) {
    try {
      const userId = req.user.id;
      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ success: false, message: 'All password fields are required.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'New passwords do not match.' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      }

      const [userRows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
      if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found.' });

      const valid = await bcrypt.compare(currentPassword, userRows[0].password);
      if (!valid) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
      }

      const hashed = await bcrypt.hash(newPassword, 10);
      await db.query('UPDATE users SET password=? WHERE id=?', [hashed, userId]);

      await logActivity(userId, 'Changed password', req);
      return res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
      console.error('[Profile] changePassword error:', err);
      return res.status(500).json({ success: false, message: 'Failed to change password.' });
    }
  },

  // ── POST /api/profile/upload-avatar ──────────────────────────────────────
  async uploadAvatar(req, res) {
    try {
      const userId = req.user.id;
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
      }

      // Delete old avatar if it exists
      const [userRows] = await db.query('SELECT profile_picture FROM users WHERE id = ?', [userId]);
      if (userRows[0]?.profile_picture) {
        const oldPath = path.join(__dirname, '..', userRows[0].profile_picture);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const relativePath = '/uploads/profile_pics/' + req.file.filename;
      await db.query('UPDATE users SET profile_picture=? WHERE id=?', [relativePath, userId]);

      await logActivity(userId, 'Updated profile picture', req);
      return res.json({ success: true, message: 'Avatar updated successfully.', profile_picture: relativePath });
    } catch (err) {
      console.error('[Profile] uploadAvatar error:', err);
      return res.status(500).json({ success: false, message: 'Failed to upload avatar.' });
    }
  },

  // ── POST /api/profile/upload-kyc ─────────────────────────────────────────
  async uploadKYCDoc(req, res) {
    try {
      const userId = req.user.id;
      const { doc_type, aadhaar_number, pan_number } = req.body;

      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
      }

      const relativePath = '/uploads/kyc_docs/' + req.file.filename;

      let updateField = null;
      let activity = '';

      if (doc_type === 'aadhaar_front') {
        const [old] = await db.query('SELECT aadhaar_front FROM users WHERE id=?', [userId]);
        if (old[0]?.aadhaar_front) { const op = path.join(__dirname, '..', old[0].aadhaar_front); if (fs.existsSync(op)) fs.unlinkSync(op); }
        await db.query('UPDATE users SET aadhaar_front=?, aadhaar_number=COALESCE(?, aadhaar_number) WHERE id=?', [relativePath, aadhaar_number || null, userId]);
        activity = 'Uploaded Aadhaar Front';
      } else if (doc_type === 'aadhaar_back') {
        const [old] = await db.query('SELECT aadhaar_back FROM users WHERE id=?', [userId]);
        if (old[0]?.aadhaar_back) { const op = path.join(__dirname, '..', old[0].aadhaar_back); if (fs.existsSync(op)) fs.unlinkSync(op); }
        await db.query('UPDATE users SET aadhaar_back=?, aadhaar_number=COALESCE(?, aadhaar_number) WHERE id=?', [relativePath, aadhaar_number || null, userId]);
        activity = 'Uploaded Aadhaar Back';
      } else if (doc_type === 'pan_card') {
        const [old] = await db.query('SELECT pan_card FROM users WHERE id=?', [userId]);
        if (old[0]?.pan_card) { const op = path.join(__dirname, '..', old[0].pan_card); if (fs.existsSync(op)) fs.unlinkSync(op); }
        await db.query('UPDATE users SET pan_card=?, pan_number=COALESCE(?, pan_number) WHERE id=?', [relativePath, pan_number || null, userId]);
        activity = 'Uploaded PAN Card';
      } else {
        return res.status(400).json({ success: false, message: 'Invalid document type. Use aadhaar_front, aadhaar_back, or pan_card.' });
      }

      // Update verification status to Pending since docs changed
      await db.query('UPDATE users SET verification_status=? WHERE id=?', ['Pending', userId]);

      await logActivity(userId, activity, req);
      return res.json({ success: true, message: `${activity} successfully.`, path: relativePath });
    } catch (err) {
      console.error('[Profile] uploadKYCDoc error:', err);
      return res.status(500).json({ success: false, message: 'Failed to upload document.' });
    }
  },

  // ── PUT /api/profile/bank-details ─────────────────────────────────────────
  async updateBankDetails(req, res) {
    try {
      const userId = req.user.id;
      const { account_holder_name, bank_name, account_number, ifsc_code, branch_name } = req.body;

      await db.query(
        `INSERT INTO bank_details (user_id, account_holder_name, bank_name, account_number, ifsc_code, branch_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           account_holder_name=VALUES(account_holder_name),
           bank_name=VALUES(bank_name),
           account_number=VALUES(account_number),
           ifsc_code=VALUES(ifsc_code),
           branch_name=VALUES(branch_name)`,
        [userId, account_holder_name||null, bank_name||null, account_number||null, ifsc_code||null, branch_name||null]
      );

      await logActivity(userId, 'Updated bank details', req);
      return res.json({ success: true, message: 'Bank details updated successfully.' });
    } catch (err) {
      console.error('[Profile] updateBankDetails error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update bank details.' });
    }
  },

  // ── PUT /api/profile/emergency-contact ────────────────────────────────────
  async updateEmergencyContact(req, res) {
    try {
      const userId = req.user.id;
      const { contact_name, relationship, mobile_number, alternate_number } = req.body;

      await db.query(
        `INSERT INTO emergency_contacts (user_id, contact_name, relationship, mobile_number, alternate_number)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           contact_name=VALUES(contact_name),
           relationship=VALUES(relationship),
           mobile_number=VALUES(mobile_number),
           alternate_number=VALUES(alternate_number)`,
        [userId, contact_name||null, relationship||null, mobile_number||null, alternate_number||null]
      );

      await logActivity(userId, 'Updated emergency contact', req);
      return res.json({ success: true, message: 'Emergency contact updated successfully.' });
    } catch (err) {
      console.error('[Profile] updateEmergencyContact error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update emergency contact.' });
    }
  },

  // ── PUT /api/profile/notification-preferences ─────────────────────────────
  async updateNotificationPreferences(req, res) {
    try {
      const userId = req.user.id;
      const {
        email_notifications, whatsapp_notifications,
        loan_alerts, employee_activity_alerts, system_alerts
      } = req.body;

      await db.query(
        `INSERT INTO notification_preferences
           (user_id, email_notifications, whatsapp_notifications, loan_alerts, employee_activity_alerts, system_alerts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           email_notifications=VALUES(email_notifications),
           whatsapp_notifications=VALUES(whatsapp_notifications),
           loan_alerts=VALUES(loan_alerts),
           employee_activity_alerts=VALUES(employee_activity_alerts),
           system_alerts=VALUES(system_alerts)`,
        [userId,
          email_notifications ? 1 : 0,
          whatsapp_notifications ? 1 : 0,
          loan_alerts ? 1 : 0,
          employee_activity_alerts ? 1 : 0,
          system_alerts ? 1 : 0
        ]
      );

      await logActivity(userId, 'Updated notification preferences', req);
      return res.json({ success: true, message: 'Notification preferences saved.' });
    } catch (err) {
      console.error('[Profile] updateNotificationPreferences error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update preferences.' });
    }
  },

  // ── GET /api/profile/admin/employees/:id ─────────────────────────────────
  async adminGetEmployeeProfile(req, res) {
    try {
      const employeeId = parseInt(req.params.id, 10);
      if (!employeeId) return res.status(400).json({ success: false, message: 'Invalid employee ID.' });

      const [userRows] = await db.query('SELECT * FROM users WHERE id = ? AND role = ?', [employeeId, 'employee']);
      if (!userRows.length) return res.status(404).json({ success: false, message: 'Employee not found.' });

      const user = { ...userRows[0] };
      delete user.password;

      const [[bank]] = await db.query('SELECT * FROM bank_details WHERE user_id = ?', [employeeId]);
      const [[emergency]] = await db.query('SELECT * FROM emergency_contacts WHERE user_id = ?', [employeeId]);
      const [activityLogs] = await db.query(
        'SELECT * FROM user_activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 15',
        [employeeId]
      );
      const [loginHistory] = await db.query(
        'SELECT * FROM login_history WHERE user_id = ? ORDER BY login_time DESC LIMIT 10',
        [employeeId]
      );

      return res.json({
        success: true,
        data: { user, bank: bank || null, emergency: emergency || null, activityLogs, loginHistory }
      });
    } catch (err) {
      console.error('[Profile] adminGetEmployeeProfile error:', err);
      return res.status(500).json({ success: false, message: 'Failed to load employee profile.' });
    }
  },

  // ── PUT /api/profile/admin/employees/:id/verify ───────────────────────────
  async adminVerifyEmployeeKYC(req, res) {
    try {
      const adminId = req.user.id;
      const employeeId = parseInt(req.params.id, 10);
      const { verification_status, verification_remarks } = req.body;

      const allowed = ['Pending', 'Approved', 'Rejected'];
      if (!allowed.includes(verification_status)) {
        return res.status(400).json({ success: false, message: 'Invalid verification status.' });
      }

      await db.query(
        'UPDATE users SET verification_status=?, verification_remarks=? WHERE id=?',
        [verification_status, verification_remarks || null, employeeId]
      );

      await logActivity(adminId, `KYC ${verification_status} for employee ID ${employeeId}`, req);
      return res.json({ success: true, message: `Employee KYC ${verification_status} successfully.` });
    } catch (err) {
      console.error('[Profile] adminVerifyEmployeeKYC error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update verification status.' });
    }
  },

  // ── DELETE /api/profile/avatar ─────────────────────────────────────────────
  async removeAvatar(req, res) {
    try {
      const userId = req.user.id;
      const [userRows] = await db.query('SELECT profile_picture FROM users WHERE id = ?', [userId]);
      if (userRows[0]?.profile_picture) {
        const oldPath = path.join(__dirname, '..', userRows[0].profile_picture);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      await db.query('UPDATE users SET profile_picture=NULL WHERE id=?', [userId]);
      await logActivity(userId, 'Removed profile picture', req);
      return res.json({ success: true, message: 'Profile picture removed.' });
    } catch (err) {
      console.error('[Profile] removeAvatar error:', err);
      return res.status(500).json({ success: false, message: 'Failed to remove avatar.' });
    }
  }
};

module.exports = profileController;

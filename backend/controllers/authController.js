const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const UserModel = require('../models/userModel');
const PasswordResetModel = require('../models/passwordResetModel');
const { sendPasswordResetEmail } = require('../utils/mailer');
const db = require('../config/db');

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Parse a User-Agent string into device, browser, and OS fields.
 * @param {string|null} ua - The User-Agent header value
 * @returns {{ device: string, browser: string, os: string }}
 */
function parseUA(ua) {
  if (!ua) return { device: 'Unknown', browser: 'Unknown', os: 'Unknown' };

  // Detect OS
  let os = 'Unknown';
  if (/windows nt/i.test(ua))        os = 'Windows';
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua))      os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/linux/i.test(ua))        os = 'Linux';
  else if (/cros/i.test(ua))         os = 'ChromeOS';

  // Detect Browser
  let browser = 'Unknown';
  if (/edg\//i.test(ua))             browser = 'Edge';
  else if (/opr\//i.test(ua))        browser = 'Opera';
  else if (/chrome/i.test(ua))       browser = 'Chrome';
  else if (/firefox/i.test(ua))      browser = 'Firefox';
  else if (/safari/i.test(ua))       browser = 'Safari';
  else if (/msie|trident/i.test(ua)) browser = 'Internet Explorer';

  // Detect Device type
  let device = 'Desktop';
  if (/mobile/i.test(ua))            device = 'Mobile';
  else if (/tablet|ipad/i.test(ua))  device = 'Tablet';

  return { device, browser, os };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getFrontendBaseUrl(req) {
  const configuredBase = process.env.FRONTEND_BASE_URL || process.env.ALLOWED_ORIGIN || '';
  const fallbackBase = `${req.protocol}://${req.get('host')}`;
  return String(configuredBase || fallbackBase).replace(/\/$/, '');
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function formatTimeToAMPM(timeStr) {
  const [hourStr, minStr] = timeStr.split(':');
  const hour = parseInt(hourStr, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const formattedHour = hour % 12 || 12;
  const paddedHour = String(formattedHour).padStart(2, '0');
  return `${paddedHour}:${minStr} ${ampm}`;
}

const authController = {
  /**
   * POST /api/auth/login
   * IP restriction for employees is applied via middleware before this
   */
  async login(req, res) {
    try {
      const { email, password, role } = req.body;

      if (!email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Email, password, and role are required.' });
      }

      const normalized = normalizeEmail(email);
      const user = await UserModel.findByEmail(normalized);

      if (!user) {
        // Don't reveal if email exists or not (prevents user enumeration)
        return res.status(401).json({ success: false, message: 'Authentication failed. Please check your credentials.' });
      }

      if (user.role === 'employee') {
        // Manual override = full access regardless of business hours
        if (user.manual_override === 1 && user.is_active === 1) {
          // Override is active — skip all business hours checks, fall through to password check
        } else {
          // Hard-deactivated by admin
          if (!user.is_active && user.auto_deactivated === 0) {
            return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact admin.' });
          }

          const [settings] = await db.query('SELECT * FROM system_settings');
          const settingsMap = {};
          settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);

          const startTime = settingsMap['auto_activation_time'] || '07:00';
          const endTime = settingsMap['auto_deactivation_time'] || '20:00';

          const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
          const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date());
          const hour = parts.find(p => p.type === 'hour')?.value;
          const minute = parts.find(p => p.type === 'minute')?.value;
          const currentTime = `${hour}:${minute}`;

          const isOutsideWorkingHours = currentTime < startTime || currentTime >= endTime;

          if (user.auto_deactivated === 1 || !user.is_active || isOutsideWorkingHours) {
            const startAMPM = formatTimeToAMPM(startTime);
            const endAMPM = formatTimeToAMPM(endTime);
            return res.status(403).json({
              success: false,
              message: `Your account has been automatically deactivated as business hours have ended.\nWorking hours: ${startAMPM} - ${endAMPM}.`
            });
          }
        }
      } else {
        if (!user.is_active) {
          return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact admin.' });
        }
      }

      if (user.role !== role) {
        return res.status(403).json({ success: false, message: `This account is not registered as ${role}.` });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ success: false, message: 'Authentication failed. Please check your credentials.' });
      }

      const token = jwt.sign(
        { id: user.id, name: user.name, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || null;
      const device = req.headers['user-agent'] || null;

      // Attendance logs tracking for employees
      if (user.role === 'employee') {
        const [activeSessions] = await db.query(
          'SELECT id, login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL',
          [user.id]
        );
        for (const s of activeSessions) {
          const closeTime = user.last_active_at ? new Date(user.last_active_at) : new Date();
          const loginTime = new Date(s.login_time);
          const durationSec = Math.max(0, Math.floor((closeTime.getTime() - loginTime.getTime()) / 1000));
          const durationHours = Number((durationSec / 3600).toFixed(2));
          await db.query(
            'UPDATE attendance_logs SET logout_time = ?, total_working_hours = ?, session_status = "Logged Out" WHERE id = ?',
            [closeTime, durationHours, s.id]
          );
        }

        const uaInfo = parseUA(device);
        // Create new active session record
        await db.query(
          'INSERT INTO attendance_logs (employee_id, employee_name, login_time, session_status, ip_address, device, browser, os) VALUES (?, ?, NOW(), "Active Session", ?, ?, ?, ?)',
          [user.id, user.name, ip, uaInfo.device, uaInfo.browser, uaInfo.os]
        );

        // Update user status in DB
        await db.query(
          "UPDATE users SET current_status = 'Available', last_active_at = NOW() WHERE id = ?",
          [user.id]
        );
      }

      // Log login event in login_history (for all roles)
      await db.query(
        'INSERT INTO login_history (user_id, login_time, ip_address, device, status) VALUES (?, NOW(), ?, ?, ?)',
        [user.id, ip, device, 'Success']
      ).catch(() => {}); // Non-blocking
      await db.query(
        'INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, ?, ?)',
        [user.id, 'Logged in', 'Success', ip]
      ).catch(() => {}); // Non-blocking

      // Seed notification/bank/emergency preferences row if not exists
      await db.query('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [user.id]).catch(() => {});
      await db.query('INSERT IGNORE INTO bank_details (user_id) VALUES (?)', [user.id]).catch(() => {});
      await db.query('INSERT IGNORE INTO emergency_contacts (user_id) VALUES (?)', [user.id]).catch(() => {});

      return res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          profile_picture: user.profile_picture || null
        }
      });
    } catch (err) {
      console.error('[Auth] Login error:', err);
      return res.status(500).json({ success: false, message: 'Server error during login.' });
    }
  },

  /**
   * GET /api/auth/me
   * Return current user info from token
   */
  async getMe(req, res) {
    try {
      const user = await UserModel.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }
      return res.json({ success: true, user });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  },

  /**
   * POST /api/auth/forgot-password
   * Sends an email with a reset link for the admin account.
   */
  async forgotPassword(req, res) {
    try {
      const email = normalizeEmail(req.body.email);

      if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
      }

      const user = await UserModel.findByEmail(email);

      // Keep the response generic to avoid user enumeration.
      if (!user || user.role !== 'admin') {
        return res.json({
          success: true,
          message: 'If the email is registered as an admin account, a reset link will be sent.'
        });
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      const resetUrl = `${getFrontendBaseUrl(req)}/reset-password.html?token=${rawToken}`;

      await PasswordResetModel.deleteForUser(user.id);
      await PasswordResetModel.create({ userId: user.id, tokenHash, expiresAt });
      await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });

      return res.json({
        success: true,
        message: 'If the email is registered as an admin account, a reset link will be sent.'
      });
    } catch (err) {
      console.error('[Auth] Forgot password error:', err);
      const message = err && err.message ? err.message : 'Unable to send reset email right now.';
      return res.status(500).json({ success: false, message });
    }
  },

  /**
   * POST /api/auth/reset-password
   * Updates the password using a valid reset token.
   */
  async resetPassword(req, res) {
    try {
      const { token, password, confirmPassword } = req.body;

      if (!token || !password || !confirmPassword) {
        return res.status(400).json({ success: false, message: 'Token, password, and confirm password are required.' });
      }

      if (password !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Passwords do not match.' });
      }

      if (password.trim().length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
      }

      const tokenHash = hashResetToken(token);
      const resetEntry = await PasswordResetModel.findValidByTokenHash(tokenHash);

      if (!resetEntry) {
        return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await UserModel.updatePassword(resetEntry.user_id, hashedPassword);
      await PasswordResetModel.markUsed(resetEntry.id);
      await PasswordResetModel.deleteForUser(resetEntry.user_id);

      return res.json({ success: true, message: 'Password has been reset successfully.' });
    } catch (err) {
      console.error('[Auth] Reset password error:', err);
      return res.status(500).json({ success: false, message: 'Unable to reset password right now.' });
    }
  },

  /**
   * POST /api/auth/logout
   */
  async logout(req, res) {
    try {
      const employeeId = req.user.id;
      const role = req.user.role;

      if (role === 'employee') {
        // Find active open session
        const [activeSessions] = await db.query(
          'SELECT id, login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL ORDER BY login_time DESC LIMIT 1',
          [employeeId]
        );

        if (activeSessions.length > 0) {
          const sessionId = activeSessions[0].id;
          const loginTime = new Date(activeSessions[0].login_time).getTime();
          const logoutTime = new Date();
          const durationSec = Math.max(0, Math.floor((logoutTime.getTime() - loginTime) / 1000));
          const durationHours = Number((durationSec / 3600).toFixed(2));

          await db.query(
            'UPDATE attendance_logs SET logout_time = NOW(), total_working_hours = ?, session_status = "Logged Out" WHERE id = ?',
            [durationHours, sessionId]
          );
        }

        // Set status to Offline
        await db.query(
          "UPDATE users SET current_status = 'Offline', last_active_at = NOW() WHERE id = ?",
          [employeeId]
        );
      }

      return res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
      console.error('[Auth] Logout error:', err);
      return res.status(500).json({ success: false, message: 'Logout failed.' });
    }
  }
};

module.exports = authController;

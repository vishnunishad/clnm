const db = require('../config/db');
const mailer = require('./mailer');

function formatAuditTimestamp(date) {
  const options = {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(date);

  const day = parts.find(p => p.type === 'day')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const year = parts.find(p => p.type === 'year')?.value;
  const hour = parts.find(p => p.type === 'hour')?.value;
  const minute = parts.find(p => p.type === 'minute')?.value;
  const dayPeriod = parts.find(p => p.type === 'dayPeriod')?.value || 'AM';

  return `${day}-${month}-${year} ${hour}:${minute} ${dayPeriod.toUpperCase()}`;
}

async function closeActiveSessions(employeeId) {
  const [activeSessions] = await db.query(
    'SELECT id, login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL',
    [employeeId]
  );
  for (const s of activeSessions) {
    const closeTime = new Date();
    const loginTime = new Date(s.login_time);
    const durationSec = Math.max(0, Math.floor((closeTime.getTime() - loginTime.getTime()) / 1000));
    const durationHours = Number((durationSec / 3600).toFixed(2));
    await db.query(
      'UPDATE attendance_logs SET logout_time = ?, total_working_hours = ?, session_status = "Logged Out" WHERE id = ?',
      [closeTime, durationHours, s.id]
    );
  }
}

async function checkAndProcessSchedules() {
  try {
    // 1. Fetch current settings
    const [settings] = await db.query('SELECT * FROM system_settings');
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);

    const startTime = settingsMap['auto_activation_time'] || '07:00';
    const endTime = settingsMap['auto_deactivation_time'] || '20:00';

    // 2. Get current time in Asia/Kolkata
    const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date());
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    const currentTime = `${hour}:${minute}`;

    const isInsideWorkingHours = currentTime >= startTime && currentTime < endTime;

    if (isInsideWorkingHours) {
      // ── AUTO ACTIVATION ──────────────────────────────────────────────────────
      // Activate employees that are flagged as auto_deactivated
      // Also reset any manual_override flags so the fresh business day starts clean
      const [deactivatedEmployees] = await db.query(
        "SELECT id, name, email FROM users WHERE role = 'employee' AND auto_deactivated = 1"
      );

      for (const employee of deactivatedEmployees) {
        const timestampStr = formatAuditTimestamp(new Date());

        // Activate and reset ALL override/deactivation flags for the new day
        await db.query(
          `UPDATE users
           SET is_active = 1,
               auto_deactivated = 0,
               last_auto_activation = NOW(),
               manual_override = 0,
               manual_override_by = NULL,
               manual_override_at = NULL
           WHERE id = ?`,
          [employee.id]
        );

        // Audit Log
        const auditLogStr = `System Action\n\nEmployee: ${employee.name}\n\nAction: Auto Activated\n\nReason: Business Hours Started\n\nTimestamp: ${timestampStr}`;
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [employee.id, auditLogStr]
        );

        // Email Notification
        await mailer.sendSystemNotificationEmail({
          to: employee.email,
          name: employee.name,
          subject: 'Account Activated — Business Hours Started',
          message: 'Your account has been automatically activated. You may now access the CRM.'
        }).catch(err => {
          console.error(`[Scheduler] Failed to send activation email to ${employee.email}:`, err.message);
        });

        console.log(`[Scheduler] Auto Activated employee: ${employee.name}`);
      }
    } else {
      // ── AUTO DEACTIVATION ────────────────────────────────────────────────────
      // Only deactivate employees who DON'T have an active manual override
      const [activeEmployees] = await db.query(
        "SELECT id, name, email FROM users WHERE role = 'employee' AND is_active = 1 AND manual_override = 0"
      );

      for (const employee of activeEmployees) {
        const timestampStr = formatAuditTimestamp(new Date());

        // Deactivate employee
        await db.query(
          `UPDATE users
           SET is_active = 0,
               auto_deactivated = 1,
               auto_deactivated_at = NOW(),
               current_status = 'Offline'
           WHERE id = ?`,
          [employee.id]
        );

        // Close active attendance sessions
        await closeActiveSessions(employee.id);

        // Audit Log
        const auditLogStr = `System Action\n\nEmployee: ${employee.name}\n\nAction: Auto Deactivated\n\nReason: Business Hours Ended\n\nTimestamp: ${timestampStr}`;
        await db.query(
          "INSERT INTO user_activity_logs (user_id, activity, status, ip_address) VALUES (?, ?, 'Success', '127.0.0.1')",
          [employee.id, auditLogStr]
        );

        // Email Notification
        await mailer.sendSystemNotificationEmail({
          to: employee.email,
          name: employee.name,
          subject: 'Account Deactivated — Business Hours Ended',
          message: 'Your account has been automatically deactivated as business hours have ended.'
        }).catch(err => {
          console.error(`[Scheduler] Failed to send deactivation email to ${employee.email}:`, err.message);
        });

        console.log(`[Scheduler] Auto Deactivated employee: ${employee.name}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error in scheduler execution:', err);
  }
}

function startScheduler() {
  console.log('[Scheduler] Starting auto-activation/deactivation background scheduler...');
  // Run immediately on startup for reconciliation
  checkAndProcessSchedules();
  // Poll every 30 seconds
  setInterval(checkAndProcessSchedules, 30000);
}

module.exports = {
  startScheduler,
  checkAndProcessSchedules
};

const db = require('../config/db');

const breakTimeController = {
  // ── Heartbeat (updates active status) ──────────────────────────
  async heartbeat(req, res) {
    try {
      const employeeId = req.user.id;
      const { status } = req.body;
      
      const [user] = await db.query('SELECT current_status FROM users WHERE id = ?', [employeeId]);
      if (user.length > 0) {
        let newStatus = user[0].current_status;
        // Don't overwrite On Break or Offline with heartbeat Available/Idle status
        if (user[0].current_status !== 'On Break' && user[0].current_status !== 'Offline') {
          newStatus = status || 'Available';
        }
        await db.query(
          'UPDATE users SET last_active_at = NOW(), current_status = ? WHERE id = ?',
          [newStatus, employeeId]
        );
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('[Heartbeat Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Heartbeat failed.' });
    }
  },

  // ── Get status & today's summary (Employee Side) ───────────────
  async getStatus(req, res) {
    try {
      const employeeId = req.user.id;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Get active break record if any
      const [activeRow] = await db.query(
        'SELECT * FROM break_records WHERE employee_id = ? AND end_time IS NULL LIMIT 1',
        [employeeId]
      );

      // Get all breaks taken today
      const [todayBreaks] = await db.query(
        'SELECT * FROM break_records WHERE employee_id = ? AND start_time >= ?',
        [employeeId, todayStart]
      );

      const totalBreaksTaken = todayBreaks.length;
      let totalBreakDurationSec = 0;
      let lastBreakTime = '—';

      todayBreaks.forEach(b => {
        if (b.end_time) {
          totalBreakDurationSec += b.duration || 0;
        } else {
          const elapsed = Math.floor((Date.now() - new Date(b.start_time).getTime()) / 1000);
          totalBreakDurationSec += Math.max(0, elapsed);
        }
      });

      if (todayBreaks.length > 0) {
        const last = todayBreaks[todayBreaks.length - 1];
        const startStr = new Date(last.start_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
        const endStr = last.end_time
          ? new Date(last.end_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
          : 'In Progress';
        lastBreakTime = `${startStr} - ${endStr}`;
      }

      const currentBreakStatus = activeRow.length > 0
        ? 'On Break'
        : (todayBreaks.length > 0 ? 'Break Completed' : 'Working');

      // Fetch active session info for employee side display
      const [activeSession] = await db.query(
        'SELECT login_time FROM attendance_logs WHERE employee_id = ? AND session_status = "Active Session" AND logout_time IS NULL LIMIT 1',
        [employeeId]
      );
      const loginTimeInfo = activeSession.length > 0 ? activeSession[0].login_time : null;

      return res.json({
        success: true,
        data: {
          totalBreaksTaken,
          totalBreakTime: Math.round(totalBreakDurationSec / 60), // in minutes
          currentBreakStatus,
          lastBreakTime,
          loginTimeInfo,
          activeBreak: activeRow.length > 0 ? {
            ...activeRow[0],
            server_time: new Date()
          } : null
        }
      });
    } catch (err) {
      console.error('[GetStatus Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load break status.' });
    }
  },

  // ── Start Break (Employee Side) ───────────────────────────────
  async startBreak(req, res) {
    try {
      const employeeId = req.user.id;
      const { break_type, custom_reason } = req.body;

      if (!break_type) {
        return res.status(400).json({ success: false, message: 'Break type is required.' });
      }

      // Check if already on break
      const [active] = await db.query(
        'SELECT id FROM break_records WHERE employee_id = ? AND end_time IS NULL LIMIT 1',
        [employeeId]
      );
      if (active.length > 0) {
        return res.status(400).json({ success: false, message: 'You are already on an active break.' });
      }

      // Fetch employee info
      const [emp] = await db.query('SELECT name, department FROM users WHERE id = ?', [employeeId]);
      if (emp.length === 0) {
        return res.status(404).json({ success: false, message: 'Employee not found.' });
      }

      // Insert record (omitting department features, save blank/default)
      await db.query(
        'INSERT INTO break_records (employee_id, employee_name, department, break_type, custom_reason, status) VALUES (?, ?, "Operations", ?, ?, ?)',
        [employeeId, emp[0].name, break_type, custom_reason || null, 'On Break']
      );

      // Update employee status
      await db.query(
        "UPDATE users SET current_status = 'On Break', last_active_at = NOW() WHERE id = ?",
        [employeeId]
      );

      return res.json({ success: true, message: 'Break started.' });
    } catch (err) {
      console.error('[StartBreak Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to start break.' });
    }
  },

  // ── End Break (Employee Side) ─────────────────────────────────
  async endBreak(req, res) {
    try {
      const employeeId = req.user.id;

      // Find active break
      const [active] = await db.query(
        'SELECT * FROM break_records WHERE employee_id = ? AND end_time IS NULL LIMIT 1',
        [employeeId]
      );
      if (active.length === 0) {
        return res.status(400).json({ success: false, message: 'No active break found to end.' });
      }

      const breakRecordId = active[0].id;
      const startTime = new Date(active[0].start_time).getTime();
      const endTime = new Date();
      const durationSec = Math.max(0, Math.floor((endTime.getTime() - startTime) / 1000));

      // Update break record
      await db.query(
        'UPDATE break_records SET end_time = NOW(), duration = ?, status = ? WHERE id = ?',
        [durationSec, 'Completed', breakRecordId]
      );

      // Update employee status back to Available
      await db.query(
        "UPDATE users SET current_status = 'Available', last_active_at = NOW() WHERE id = ?",
        [employeeId]
      );

      return res.json({ success: true, message: 'Break ended successfully.', duration: durationSec });
    } catch (err) {
      console.error('[EndBreak Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to end break.' });
    }
  },

  // ── Get History (Employee Side) ────────────────────────────────
  async getHistory(req, res) {
    try {
      const employeeId = req.user.id;
      const { break_type, startDate, endDate, page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;

      let sql = 'SELECT * FROM break_records WHERE employee_id = ?';
      const params = [employeeId];

      if (break_type) {
        sql += ' AND break_type = ?';
        params.push(break_type);
      }
      if (startDate) {
        sql += ' AND start_time >= ?';
        params.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        sql += ' AND start_time <= ?';
        params.push(endDate + ' 23:59:59');
      }

      sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const [rows] = await db.query(sql, params);

      // Total count
      let countSql = 'SELECT COUNT(*) as total FROM break_records WHERE employee_id = ?';
      const countParams = [employeeId];
      if (break_type) {
        countSql += ' AND break_type = ?';
        countParams.push(break_type);
      }
      if (startDate) {
        countSql += ' AND start_time >= ?';
        countParams.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        countSql += ' AND start_time <= ?';
        countParams.push(endDate + ' 23:59:59');
      }
      const [countResult] = await db.query(countSql, countParams);

      return res.json({
        success: true,
        data: rows,
        pagination: {
          total: countResult[0].total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult[0].total / limit)
        }
      });
    } catch (err) {
      console.error('[GetHistory Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to retrieve history.' });
    }
  },

  // ── Get Rules (Shared) ─────────────────────────────────────────
  async getRules(req, res) {
    try {
      const [rows] = await db.query('SELECT * FROM break_rules');
      const rules = {};
      rows.forEach(r => {
        rules[r.break_type] = r.allowed_duration;
      });
      return res.json({ success: true, rules });
    } catch (err) {
      console.error('[GetRules Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to retrieve rules.' });
    }
  },

  // ── Update Rules (Admin Side) ──────────────────────────────────
  async updateRules(req, res) {
    try {
      const { rules } = req.body;
      if (!rules || typeof rules !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid rules object.' });
      }

      for (const [type, val] of Object.entries(rules)) {
        await db.query(
          'INSERT INTO break_rules (break_type, allowed_duration) VALUES (?, ?) ON DUPLICATE KEY UPDATE allowed_duration = ?',
          [type, parseInt(val), parseInt(val)]
        );
      }
      return res.json({ success: true, message: 'Break rules updated successfully.' });
    } catch (err) {
      console.error('[UpdateRules Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to update break rules.' });
    }
  },

  // ── Get Admin Monitoring Status Board ──────────────────────────
  async getAdminMonitoring(req, res) {
    try {
      // Get all active employee accounts (Omit department field)
      const [employees] = await db.query(
        'SELECT id, name, email, current_status, last_active_at FROM users WHERE role = "employee" AND is_active = 1'
      );

      // Get rules
      const [rulesRows] = await db.query('SELECT * FROM break_rules');
      const rules = {};
      rulesRows.forEach(r => { rules[r.break_type] = r.allowed_duration; });

      // Get active break records
      const [activeBreaks] = await db.query(
        'SELECT * FROM break_records WHERE end_time IS NULL'
      );
      const activeMap = {};
      activeBreaks.forEach(b => { activeMap[b.employee_id] = b; });

      const now = Date.now();
      const list = employees.map(emp => {
        const activeBreak = activeMap[emp.id] || null;
        let status = emp.current_status;

        // If status is On Break, they are On Break.
        // Otherwise, if they haven't sent a heartbeat for 2 minutes, they are Offline.
        if (status !== 'On Break') {
          if (!emp.last_active_at || (now - new Date(emp.last_active_at).getTime() > 120 * 1000)) {
            status = 'Offline';
          }
        }

        let currentDuration = 0;
        let allowedDuration = 0;
        let remainingTime = 0;

        if (activeBreak) {
          const elapsedSec = Math.floor((now - new Date(activeBreak.start_time).getTime()) / 1000);
          currentDuration = Math.max(0, elapsedSec);
          allowedDuration = (rules[activeBreak.break_type] || 0) * 60; // in seconds
          remainingTime = Math.max(0, allowedDuration - currentDuration);
        }

        return {
          employee_id: emp.id,
          employee_name: emp.name,
          status,
          break_type: activeBreak ? activeBreak.break_type : null,
          start_time: activeBreak ? activeBreak.start_time : null,
          current_duration: currentDuration, // in seconds
          allowed_duration: allowedDuration, // in seconds
          remaining_time: remainingTime, // in seconds
          activeBreak
        };
      });

      return res.json({
        success: true,
        data: list,
        server_time: new Date()
      });
    } catch (err) {
      console.error('[AdminMonitoring Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load monitoring board.' });
    }
  },

  // ── Get Admin Analytics Data ───────────────────────────────────
  async getAdminAnalytics(req, res) {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Total employees
      const [empCount] = await db.query('SELECT count(*) as count FROM users WHERE role = "employee" AND is_active = 1');
      const totalEmployees = empCount[0].count;

      // Current real-time states
      const [employees] = await db.query('SELECT id, current_status, last_active_at FROM users WHERE role = "employee" AND is_active = 1');
      let workingCount = 0;
      let onBreakCount = 0;
      let offlineCount = 0;
      let idleCount = 0;
      const now = Date.now();

      employees.forEach(emp => {
        let status = emp.current_status;
        if (status !== 'On Break') {
          if (!emp.last_active_at || (now - new Date(emp.last_active_at).getTime() > 120 * 1000)) {
            status = 'Offline';
          }
        }
        if (status === 'Available') workingCount++;
        else if (status === 'On Break') onBreakCount++;
        else if (status === 'Idle') { workingCount++; idleCount++; }
        else if (status === 'Offline') offlineCount++;
      });

      // Today's breaks
      const [todayBreaks] = await db.query(
        'SELECT * FROM break_records WHERE start_time >= ?',
        [todayStart]
      );

      // Rules
      const [rulesRows] = await db.query('SELECT * FROM break_rules');
      const rules = {};
      rulesRows.forEach(r => { rules[r.break_type] = r.allowed_duration; });

      let totalBreakDurationSec = 0;
      let completedBreaksCount = 0;
      let violationsCount = 0;

      todayBreaks.forEach(b => {
        const allowedSec = (rules[b.break_type] || 0) * 60;
        let actualSec = 0;
        if (b.end_time) {
          actualSec = b.duration || 0;
          completedBreaksCount++;
        } else {
          actualSec = Math.max(0, Math.floor((now - new Date(b.start_time).getTime()) / 1000));
        }
        totalBreakDurationSec += actualSec;

        if (actualSec > allowedSec) {
          violationsCount++;
        }
      });

      const avgBreakDurationMin = completedBreaksCount > 0
        ? Math.round((totalBreakDurationSec / completedBreaksCount) / 60)
        : 0;

      const todayTotalBreakHours = Number((totalBreakDurationSec / 3600).toFixed(2));

      return res.json({
        success: true,
        data: {
          summary: {
            totalEmployees,
            employeesWorking: workingCount,
            employeesOnBreak: onBreakCount,
            averageBreakDuration: avgBreakDurationMin,
            todayTotalBreakHours,
            breakViolations: violationsCount
          }
        }
      });
    } catch (err) {
      console.error('[AdminAnalytics Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load analytics.' });
    }
  },

  // ── Get Admin Violations list ──────────────────────────────────
  async getAdminViolations(req, res) {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [records] = await db.query(
        'SELECT * FROM break_records WHERE start_time >= ? ORDER BY start_time DESC',
        [todayStart]
      );

      const [rulesRows] = await db.query('SELECT * FROM break_rules');
      const rules = {};
      rulesRows.forEach(r => { rules[r.break_type] = r.allowed_duration; });

      const now = Date.now();
      const violationsList = [];

      records.forEach(r => {
        const allowedMin = rules[r.break_type] || 0;
        const allowedSec = allowedMin * 60;
        let actualSec = 0;
        if (r.end_time) {
          actualSec = r.duration || 0;
        } else {
          actualSec = Math.max(0, Math.floor((now - new Date(r.start_time).getTime()) / 1000));
        }

        if (actualSec > allowedSec) {
          const extraSec = actualSec - allowedSec;
          violationsList.push({
            id: r.id,
            employee_name: r.employee_name,
            break_type: r.break_type,
            allowed_duration: allowedMin,
            actual_duration: Math.round(actualSec / 60),
            extra_time: Math.round(extraSec / 60),
            status: r.end_time ? 'Completed' : 'On Break'
          });
        }
      });

      return res.json({ success: true, data: violationsList });
    } catch (err) {
      console.error('[AdminViolations Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load violations.' });
    }
  },

  // ── Get Admin Break History logs ───────────────────────────────
  async getAdminHistory(req, res) {
    try {
      const { search, break_type, startDate, endDate, page = 1, limit = 15 } = req.query;
      const offset = (page - 1) * limit;

      let sql = 'SELECT * FROM break_records WHERE 1=1';
      const params = [];

      if (search) {
        sql += ' AND (employee_name LIKE ? OR CAST(employee_id AS CHAR) LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
      if (break_type) {
        sql += ' AND break_type = ?';
        params.push(break_type);
      }
      if (startDate) {
        sql += ' AND start_time >= ?';
        params.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        sql += ' AND start_time <= ?';
        params.push(endDate + ' 23:59:59');
      }

      sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const [rows] = await db.query(sql, params);

      // Total count
      let countSql = 'SELECT COUNT(*) as total FROM break_records WHERE 1=1';
      const countParams = [];
      if (search) {
        countSql += ' AND (employee_name LIKE ? OR CAST(employee_id AS CHAR) LIKE ?)';
        countParams.push(`%${search}%`, `%${search}%`);
      }
      if (break_type) {
        countSql += ' AND break_type = ?';
        countParams.push(break_type);
      }
      if (startDate) {
        countSql += ' AND start_time >= ?';
        countParams.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        countSql += ' AND start_time <= ?';
        countParams.push(endDate + ' 23:59:59');
      }
      const [countResult] = await db.query(countSql, countParams);

      return res.json({
        success: true,
        data: rows,
        pagination: {
          total: countResult[0].total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult[0].total / limit)
        }
      });
    } catch (err) {
      console.error('[AdminHistory Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load history logs.' });
    }
  },

  // ── DELETE Single Break Record ────────────────────────────────
  async deleteRecord(req, res) {
    try {
      const { id } = req.params;
      const [result] = await db.query('DELETE FROM break_records WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Record not found.' });
      }
      return res.json({ success: true, message: 'Break record deleted successfully.' });
    } catch (err) {
      console.error('[DeleteRecord Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to delete record.' });
    }
  },

  // ── DELETE Selected Break Records (Bulk) ───────────────────────
  async deleteRecordsBulk(req, res) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No records selected.' });
      }
      await db.query('DELETE FROM break_records WHERE id IN (?)', [ids]);
      return res.json({ success: true, message: 'Selected records deleted successfully.' });
    } catch (err) {
      console.error('[DeleteBulk Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to delete records.' });
    }
  },

  // ── DELETE All Break Records ──────────────────────────────────
  async deleteAllRecords(req, res) {
    try {
      await db.query('DELETE FROM break_records');
      return res.json({ success: true, message: 'All break records deleted successfully.' });
    } catch (err) {
      console.error('[DeleteAll Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to delete all records.' });
    }
  },

  // ── DELETE Break Records by Date Range ─────────────────────────
  async deleteRecordsRange(req, res) {
    try {
      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: 'Start date and end date are required.' });
      }
      await db.query(
        'DELETE FROM break_records WHERE start_time >= ? AND start_time <= ?',
        [startDate + ' 00:00:00', endDate + ' 23:59:59']
      );
      return res.json({ success: true, message: 'Records in specified date range deleted.' });
    } catch (err) {
      console.error('[DeleteRange Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to delete records in range.' });
    }
  },

  // ── GET Admin Attendance Monitoring ────────────────────────────
  async getAdminAttendanceMonitoring(req, res) {
    try {
      const [loggedIn] = await db.query(
        'SELECT id, employee_id, employee_name, login_time FROM attendance_logs WHERE session_status = "Active Session" AND logout_time IS NULL ORDER BY login_time DESC'
      );
      
      const [loggedOut] = await db.query(
        'SELECT id, employee_id, employee_name, login_time, logout_time, total_working_hours FROM attendance_logs WHERE session_status = "Logged Out" AND logout_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY logout_time DESC'
      );

      const list = loggedIn.map(s => ({
        ...s,
        current_duration: Math.max(0, Math.floor((Date.now() - new Date(s.login_time).getTime()) / 1000))
      }));

      // Fetch employees currently on break
      const [onBreakEmployees] = await db.query(
        'SELECT u.id as employee_id, u.name as employee_name, b.break_type, b.start_time FROM users u JOIN break_records b ON u.id = b.employee_id WHERE u.current_status = "On Break" AND b.end_time IS NULL'
      );
      
      const onBreakList = onBreakEmployees.map(b => ({
        ...b,
        current_duration: Math.max(0, Math.floor((Date.now() - new Date(b.start_time).getTime()) / 1000))
      }));

      return res.json({
        success: true,
        data: {
          loggedIn: list,
          loggedOut,
          onBreak: onBreakList
        },
        server_time: new Date()
      });
    } catch (err) {
      console.error('[AttendanceMonitoring Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load attendance monitoring.' });
    }
  },

  // ── GET Admin Attendance History Logs ──────────────────────────
  async getAdminAttendanceHistory(req, res) {
    try {
      const { search, startDate, endDate, page = 1, limit = 15 } = req.query;
      const offset = (page - 1) * limit;

      let sql = 'SELECT * FROM attendance_logs WHERE 1=1';
      const params = [];

      if (search) {
        sql += ' AND (employee_name LIKE ? OR CAST(employee_id AS CHAR) LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
      if (startDate) {
        sql += ' AND login_time >= ?';
        params.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        sql += ' AND login_time <= ?';
        params.push(endDate + ' 23:59:59');
      }

      sql += ' ORDER BY login_time DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const [rows] = await db.query(sql, params);

      // Total count
      let countSql = 'SELECT COUNT(*) as total FROM attendance_logs WHERE 1=1';
      const countParams = [];
      if (search) {
        countSql += ' AND (employee_name LIKE ? OR CAST(employee_id AS CHAR) LIKE ?)';
        countParams.push(`%${search}%`, `%${search}%`);
      }
      if (startDate) {
        countSql += ' AND login_time >= ?';
        countParams.push(startDate + ' 00:00:00');
      }
      if (endDate) {
        countSql += ' AND login_time <= ?';
        countParams.push(endDate + ' 23:59:59');
      }
      const [countResult] = await db.query(countSql, countParams);

      return res.json({
        success: true,
        data: rows,
        pagination: {
          total: countResult[0].total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult[0].total / limit)
        }
      });
    } catch (err) {
      console.error('[AttendanceHistory Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load attendance history.' });
    }
  },

  // ── GET Admin Attendance Analytics Summary Cards ───────────────
  async getAdminAttendanceAnalytics(req, res) {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Total Employees
      const [empCount] = await db.query('SELECT count(*) as count FROM users WHERE role = "employee" AND is_active = 1');
      const totalEmployees = empCount[0].count;

      // Logged In Today (distinct employees)
      const [loggedInToday] = await db.query(
        'SELECT count(distinct employee_id) as count FROM attendance_logs WHERE login_time >= ?',
        [todayStart]
      );

      // Logged Out Today (distinct employees)
      const [loggedOutToday] = await db.query(
        'SELECT count(distinct employee_id) as count FROM attendance_logs WHERE logout_time >= ?',
        [todayStart]
      );

      // Currently Active (currently logged in)
      const [currentlyActive] = await db.query(
        'SELECT count(*) as count FROM attendance_logs WHERE session_status = "Active Session" AND logout_time IS NULL'
      );

      // Currently On Break
      const [currentlyOnBreak] = await db.query(
        'SELECT count(*) as count FROM users WHERE role = "employee" AND current_status = "On Break" AND is_active = 1'
      );

      return res.json({
        success: true,
        data: {
          totalEmployees,
          loggedInToday: loggedInToday[0].count,
          loggedOutToday: loggedOutToday[0].count,
          currentlyActive: currentlyActive[0].count,
          currentlyOnBreak: currentlyOnBreak[0].count
        }
      });
    } catch (err) {
      console.error('[AttendanceAnalytics Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load attendance analytics.' });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ── EMPLOYEE LOGIN HOURS MODULE ─────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  // ── Main paginated report ─────────────────────────────────────
  async getLoginHoursReport(req, res) {
    try {
      const {
        page = 1, limit = 20, search = '',
        dateRange = 'today', startDate, endDate,
        status = '', attendanceStatus = '', department = '',
        sortBy = 'first_login', sortDir = 'asc'
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      const OFFICE_START_HOUR = 9; // 09:00 AM threshold for "Late"
      const OFFICE_END_HOUR   = 18; // 06:00 PM threshold for "Early Logout"
      const STANDARD_HOURS    = 8; // Hours/day for overtime calc

      // ── Resolve date range ──
      let dateFrom, dateTo;
      const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const pad = n => String(n).padStart(2, '0');
      const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

      if (dateRange === 'custom' && startDate && endDate) {
        dateFrom = startDate; dateTo = endDate;
      } else if (dateRange === 'yesterday') {
        const y = new Date(todayIST); y.setDate(y.getDate()-1);
        dateFrom = dateTo = fmtDate(y);
      } else if (dateRange === 'last7') {
        const s = new Date(todayIST); s.setDate(s.getDate()-6);
        dateFrom = fmtDate(s); dateTo = fmtDate(todayIST);
      } else if (dateRange === 'last30') {
        const s = new Date(todayIST); s.setDate(s.getDate()-29);
        dateFrom = fmtDate(s); dateTo = fmtDate(todayIST);
      } else if (dateRange === 'thisMonth') {
        const s = new Date(todayIST.getFullYear(), todayIST.getMonth(), 1);
        dateFrom = fmtDate(s); dateTo = fmtDate(todayIST);
      } else {
        // today (default)
        dateFrom = dateTo = fmtDate(todayIST);
      }

      // ── Build WHERE clauses ──
      const conditions = [`DATE(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) BETWEEN ? AND ?`];
      const params = [dateFrom, dateTo];

      if (search) {
        conditions.push(`(u.name LIKE ? OR u.username LIKE ? OR CAST(u.id AS CHAR) LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      if (department) {
        conditions.push(`u.department = ?`);
        params.push(department);
      }

      const whereClause = conditions.join(' AND ');

      // ── Main aggregation query ──
      const dataQuery = `
        SELECT
          u.id AS employee_id,
          u.name AS employee_name,
          u.username AS emp_code,
          u.designation AS role,
          u.department,
          u.current_status,
          DATE(CONVERT_TZ(MIN(al.login_time), '+00:00', '+05:30')) AS work_date,
          MIN(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) AS first_login,
          MAX(CASE WHEN al.logout_time IS NOT NULL THEN CONVERT_TZ(al.logout_time, '+00:00', '+05:30') END) AS last_logout,
          COUNT(al.id) AS total_sessions,
          ROUND(SUM(CASE
            WHEN al.logout_time IS NOT NULL
            THEN TIMESTAMPDIFF(SECOND, al.login_time, al.logout_time) / 3600.0
            ELSE TIMESTAMPDIFF(SECOND, al.login_time, NOW()) / 3600.0
          END), 2) AS total_working_hours,
          (SELECT ROUND(SUM(br.duration)/3600.0, 2)
           FROM break_records br
           WHERE br.employee_id = u.id
             AND DATE(CONVERT_TZ(br.start_time, '+00:00', '+05:30')) BETWEEN ? AND ?
             AND br.duration IS NOT NULL
          ) AS break_duration_hours,
          MAX(al.ip_address) AS ip_address,
          MAX(al.device) AS device,
          MAX(al.browser) AS browser,
          MAX(al.os) AS os,
          MAX(CONVERT_TZ(u.last_active_at, '+00:00', '+05:30')) AS last_activity
        FROM attendance_logs al
        JOIN users u ON u.id = al.employee_id
        WHERE ${whereClause}
        GROUP BY u.id, DATE(CONVERT_TZ(al.login_time, '+00:00', '+05:30'))
      `;

      // We need to insert break-duration params before the where params
      const dataParams = [dateFrom, dateTo, ...params];

      const [rows] = await db.query(dataQuery, dataParams);

      // ── Post-process: calculate attendance status, overtime ──
      let processed = rows.map(r => {
        const firstLogin = r.first_login ? new Date(r.first_login) : null;
        const loginHour  = firstLogin ? firstLogin.getHours() + firstLogin.getMinutes()/60 : null;
        const lastLogout = r.last_logout ? new Date(r.last_logout) : null;
        const logoutHour = lastLogout ? lastLogout.getHours() + lastLogout.getMinutes()/60 : null;

        let attStatus = 'Present';
        if (!firstLogin) {
          attStatus = 'Absent';
        } else if (loginHour !== null && loginHour > OFFICE_START_HOUR) {
          attStatus = 'Late';
        }

        const workingHrs = parseFloat(r.total_working_hours) || 0;
        const overtimeHrs = Math.max(0, workingHrs - STANDARD_HOURS).toFixed(2);
        const breakHrs    = parseFloat(r.break_duration_hours) || 0;
        const activeHrs   = Math.max(0, workingHrs - breakHrs);
        const earlyLogout = Boolean(lastLogout && logoutHour !== null && logoutHour < OFFICE_END_HOUR);

        const currentOnline = r.current_status === 'Available' || r.current_status === 'Idle' || r.current_status === 'On Break';

        return {
          ...r,
          attendance_status: attStatus,
          overtime_hours: parseFloat(overtimeHrs),
          break_duration_hours: breakHrs,
          active_time_hours: Number(activeHrs.toFixed(2)),
          idle_time_hours: 0,
          early_logout: earlyLogout,
          current_online: currentOnline
        };
      });

      // ── Attendance status filter ──
      if (attendanceStatus) {
        processed = processed.filter(r => r.attendance_status === attendanceStatus);
      }
      if (status === 'online') {
        processed = processed.filter(r => r.current_online);
      } else if (status === 'offline') {
        processed = processed.filter(r => !r.current_online);
      }

      // ── Sorting ──
      const sortMap = {
        first_login: 'first_login', last_logout: 'last_logout',
        total_working_hours: 'total_working_hours', employee_name: 'employee_name',
        total_sessions: 'total_sessions', overtime_hours: 'overtime_hours',
        break_duration_hours: 'break_duration_hours'
      };
      const sortKey = sortMap[sortBy] || 'first_login';
      const dir = sortDir === 'desc' ? -1 : 1;
      processed.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1; if (bv == null) return -1;
        return av < bv ? -dir : av > bv ? dir : 0;
      });

      const total = processed.length;
      const paginated = processed.slice(offset, offset + parseInt(limit));

      return res.json({
        success: true,
        data: paginated,
        pagination: {
          total, page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        },
        meta: { dateFrom, dateTo }
      });
    } catch (err) {
      console.error('[LoginHoursReport Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load login hours report.' });
    }
  },

  // ── Summary KPI cards ─────────────────────────────────────────
  async getLoginHoursSummary(req, res) {
    try {
      const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const pad = n => String(n).padStart(2, '0');
      const todayStr = `${todayIST.getFullYear()}-${pad(todayIST.getMonth()+1)}-${pad(todayIST.getDate())}`;
      const OFFICE_START_HOUR = 9;
      const OFFICE_END_HOUR   = 18;
      const STANDARD_HOURS    = 8;

      const [[totEmp]]       = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'employee' AND is_active = 1`);
      const [[loggedInToday]] = await db.query(`
        SELECT COUNT(DISTINCT employee_id) AS cnt FROM attendance_logs
        WHERE DATE(CONVERT_TZ(login_time, '+00:00', '+05:30')) = ?`, [todayStr]);
      const [[loggedOutToday]] = await db.query(`
        SELECT COUNT(DISTINCT employee_id) AS cnt FROM attendance_logs
        WHERE logout_time IS NOT NULL
          AND DATE(CONVERT_TZ(logout_time, '+00:00', '+05:30')) = ?`, [todayStr]);
      const [[online]]       = await db.query(`
        SELECT COUNT(*) AS cnt FROM users
        WHERE role = 'employee' AND is_active = 1
          AND current_status IN ('Available','Idle','On Break')`);
      const [[offline]]      = await db.query(`
        SELECT COUNT(*) AS cnt FROM users
        WHERE role = 'employee' AND is_active = 1
          AND (current_status = 'Offline' OR current_status IS NULL)`);
      const [[onBreak]]      = await db.query(`
        SELECT COUNT(*) AS cnt FROM users
        WHERE role = 'employee' AND is_active = 1 AND current_status = 'On Break'`);

      // Today's sessions aggregated
      const [todaySessions] = await db.query(`
        SELECT
          u.id,
          MIN(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) AS first_login,
          MAX(CASE WHEN al.logout_time IS NOT NULL THEN CONVERT_TZ(al.logout_time, '+00:00', '+05:30') END) AS last_logout,
          ROUND(SUM(CASE
            WHEN al.logout_time IS NOT NULL
            THEN TIMESTAMPDIFF(SECOND, al.login_time, al.logout_time)/3600.0
            ELSE TIMESTAMPDIFF(SECOND, al.login_time, NOW())/3600.0
          END), 2) AS working_hours
        FROM attendance_logs al
        JOIN users u ON u.id = al.employee_id
        WHERE DATE(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) = ?
        GROUP BY u.id`, [todayStr]);

      const [[breakTotal]] = await db.query(`
        SELECT COALESCE(SUM(CASE
          WHEN end_time IS NOT NULL THEN duration
          ELSE TIMESTAMPDIFF(SECOND, start_time, NOW())
        END), 0) AS total_seconds
        FROM break_records
        WHERE DATE(CONVERT_TZ(start_time, '+00:00', '+05:30')) = ?`, [todayStr]);

      let present = 0, absent = 0, lateCount = 0, earlyLogoutCount = 0, overtimeEmployees = 0;
      let totalWorkingHrsToday = 0, loginTimes = [], logoutTimes = [];

      todaySessions.forEach(s => {
        present++;
        const workingHours = parseFloat(s.working_hours) || 0;
        totalWorkingHrsToday += workingHours;
        if (workingHours > STANDARD_HOURS) overtimeEmployees++;
        if (s.first_login) {
          const d = new Date(s.first_login);
          const hr = d.getHours() + d.getMinutes()/60;
          loginTimes.push(hr);
          if (hr > OFFICE_START_HOUR) lateCount++;
        }
        if (s.last_logout) {
          const d = new Date(s.last_logout);
          const hr = d.getHours() + d.getMinutes()/60;
          logoutTimes.push(hr);
          if (hr < OFFICE_END_HOUR) earlyLogoutCount++;
        }
      });

      const totalEmp = parseInt(totEmp.cnt);
      absent = Math.max(0, totalEmp - present);

      const avgLoginHr  = loginTimes.length ? loginTimes.reduce((a,b)=>a+b,0)/loginTimes.length : null;
      const avgLogoutHr = logoutTimes.length ? logoutTimes.reduce((a,b)=>a+b,0)/logoutTimes.length : null;
      const avgWorkHrs  = present > 0 ? (totalWorkingHrsToday / present).toFixed(2) : '0.00';
      const totalBreakHoursToday = Number(((parseInt(breakTotal.total_seconds, 10) || 0) / 3600).toFixed(2));

      const hrToStr = h => {
        if (h === null) return '—';
        const hh = Math.floor(h), mm = Math.round((h - hh)*60);
        const ampm = hh < 12 ? 'AM' : 'PM';
        return `${String(hh%12||12).padStart(2,'0')}:${String(mm).padStart(2,'0')} ${ampm}`;
      };

      return res.json({
        success: true,
        data: {
          totalEmployees:      totalEmp,
          loggedInToday:       parseInt(loggedInToday.cnt),
          loggedOutToday:      parseInt(loggedOutToday.cnt),
          currentlyWorking:    Math.max(0, parseInt(online.cnt) - parseInt(onBreak.cnt)),
          currentlyOnline:     parseInt(online.cnt),
          currentlyOffline:    parseInt(offline.cnt),
          currentlyOnBreak:    parseInt(onBreak.cnt),
          presentToday:        present,
          absentToday:         absent,
          lateToday:           lateCount,
          earlyLogoutToday:    earlyLogoutCount,
          avgLoginTime:        hrToStr(avgLoginHr),
          avgLogoutTime:       hrToStr(avgLogoutHr),
          avgWorkingHours:     avgWorkHrs,
          totalWorkingHrsToday: totalWorkingHrsToday.toFixed(2),
          totalBreakHoursToday,
          overtimeEmployees
        }
      });
    } catch (err) {
      console.error('[LoginHoursSummary Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load login hours summary.' });
    }
  },

  // ── Employee detail (timeline) ────────────────────────────────
  async getLoginHoursEmployeeDetail(req, res) {
    try {
      const { id } = req.params;
      const { date } = req.query;

      const pad = n => String(n).padStart(2, '0');
      const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const targetDate = date || `${todayIST.getFullYear()}-${pad(todayIST.getMonth()+1)}-${pad(todayIST.getDate())}`;

      // Employee info
      const [[emp]] = await db.query(
        `SELECT id, name, username AS emp_code, designation, department, current_status
         FROM users WHERE id = ? LIMIT 1`, [id]);
      if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });

      // Sessions for the day
      const [sessions] = await db.query(`
        SELECT
          id,
          CONVERT_TZ(login_time, '+00:00', '+05:30') AS login_time,
          CASE WHEN logout_time IS NOT NULL
               THEN CONVERT_TZ(logout_time, '+00:00', '+05:30')
               ELSE NULL END AS logout_time,
          total_working_hours,
          session_status,
          ip_address, device, browser, os
        FROM attendance_logs
        WHERE employee_id = ?
          AND DATE(CONVERT_TZ(login_time, '+00:00', '+05:30')) = ?
        ORDER BY login_time ASC`, [id, targetDate]);

      // Break records for the day
      const [breaks] = await db.query(`
        SELECT
          break_type, custom_reason,
          CONVERT_TZ(start_time, '+00:00', '+05:30') AS start_time,
          CASE WHEN end_time IS NOT NULL
               THEN CONVERT_TZ(end_time, '+00:00', '+05:30')
               ELSE NULL END AS end_time,
          duration, status
        FROM break_records
        WHERE employee_id = ?
          AND DATE(CONVERT_TZ(start_time, '+00:00', '+05:30')) = ?
        ORDER BY start_time ASC`, [id, targetDate]);

      // Compute totals
      let totalWorking = 0, totalBreak = 0;
      sessions.forEach(s => {
        if (s.logout_time) {
          totalWorking += (new Date(s.logout_time) - new Date(s.login_time)) / 3600000;
        } else {
          totalWorking += (Date.now() - new Date(s.login_time)) / 3600000;
        }
      });
      breaks.forEach(b => { if (b.duration) totalBreak += b.duration / 3600; });

      return res.json({
        success: true,
        employee: emp,
        sessions,
        breaks,
        summary: {
          totalSessions:     sessions.length,
          totalWorkingHours: Math.max(0, totalWorking).toFixed(2),
          breakDuration:     totalBreak.toFixed(2),
          activeTime:        Math.max(0, totalWorking - totalBreak).toFixed(2),
          idleTime:          '0.00',
          date:              targetDate
        }
      });
    } catch (err) {
      console.error('[LoginHoursDetail Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load employee detail.' });
    }
  },

  // ── Analytics / chart data ────────────────────────────────────
  async getLoginHoursAnalytics(req, res) {
    try {
      const pad = n => String(n).padStart(2, '0');
      const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const todayStr = `${todayIST.getFullYear()}-${pad(todayIST.getMonth()+1)}-${pad(todayIST.getDate())}`;

      // Build the list of the last 7 date strings (IST)
      const days = 7;
      const labels = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(todayIST);
        d.setDate(d.getDate() - i);
        labels.push(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
      }
      const startDateStr = labels[0]; // oldest date

      // ── Single query for 7-day trend (replaces 7 sequential DB calls) ──
      const [trendRows] = await db.query(`
        SELECT
          DATE(CONVERT_TZ(login_time, '+00:00', '+05:30')) AS day,
          COUNT(DISTINCT employee_id)                       AS cnt,
          ROUND(AVG(CASE
            WHEN logout_time IS NOT NULL
            THEN TIMESTAMPDIFF(SECOND, login_time, logout_time) / 3600.0
            ELSE NULL
          END), 2) AS avg_hrs
        FROM attendance_logs
        WHERE DATE(CONVERT_TZ(login_time, '+00:00', '+05:30')) BETWEEN ? AND ?
        GROUP BY day`, [startDateStr, todayStr]);

      // Map results by date string so missing days default to 0
      const trendMap = {};
      trendRows.forEach(r => { trendMap[String(r.day)] = r; });
      const loginCounts  = labels.map(d => parseInt(trendMap[d]?.cnt) || 0);
      const workingHrAvg = labels.map(d => parseFloat(trendMap[d]?.avg_hrs) || 0);

      // ── Run remaining queries in parallel (no sequential awaits) ──
      const OFFICE_START_HOUR = 9;
      const [[totEmp], [todayPresent], [lateCount], topEmp] = await Promise.all([
        db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role='employee' AND is_active=1`)
          .then(([r]) => r),
        db.query(
          `SELECT COUNT(DISTINCT employee_id) AS cnt FROM attendance_logs
           WHERE DATE(CONVERT_TZ(login_time, '+00:00', '+05:30')) = ?`,
          [todayStr]
        ).then(([r]) => r),
        db.query(
          `SELECT COUNT(DISTINCT al.employee_id) AS cnt FROM attendance_logs al
           WHERE DATE(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) = ?
             AND HOUR(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) >= ?
             AND al.id = (SELECT MIN(al2.id) FROM attendance_logs al2
                          WHERE al2.employee_id = al.employee_id
                            AND DATE(CONVERT_TZ(al2.login_time, '+00:00', '+05:30')) = ?)`,
          [todayStr, OFFICE_START_HOUR, todayStr]
        ).then(([r]) => r),
        db.query(
          `SELECT u.name AS employee_name,
             ROUND(SUM(CASE
               WHEN al.logout_time IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, al.login_time, al.logout_time) / 3600.0
               ELSE TIMESTAMPDIFF(SECOND, al.login_time, NOW()) / 3600.0
             END), 2) AS total_hours
           FROM attendance_logs al
           JOIN users u ON u.id = al.employee_id
           WHERE DATE(CONVERT_TZ(al.login_time, '+00:00', '+05:30')) = ?
           GROUP BY al.employee_id
           ORDER BY total_hours DESC
           LIMIT 5`,
          [todayStr]
        ).then(([r]) => r)
      ]);

      const totalEmp = parseInt(totEmp.cnt) || 0;
      const present  = parseInt(todayPresent.cnt) || 0;
      const absent   = Math.max(0, totalEmp - present);
      const late     = parseInt(lateCount.cnt) || 0;
      const onTime   = Math.max(0, present - late);

      return res.json({
        success: true,
        trend: { labels, loginCounts, workingHrAvg },
        distribution: { present: onTime, late, absent },
        topPerformers: topEmp
      });
    } catch (err) {
      console.error('[LoginHoursAnalytics Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to load analytics.' });
    }
  }
};

module.exports = breakTimeController;

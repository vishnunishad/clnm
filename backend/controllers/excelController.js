const db     = require('../config/db');
const multer = require('multer');
const path   = require('path');
const XLSX   = require('xlsx');

// ── Multer (memory storage) ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return cb(null, true);
    cb(new Error('Only .xlsx and .xls files are allowed'));
  }
});

exports.uploadMiddleware = upload.single('excelFile');

// ── Column alias map: handles typos, case, common variants ───────────────
const COL_ALIASES = {
  'phone number':    ['phone number','phone no','phone','mobile','mobile number','mobile no','contact','contact number','mob','mob no','phonenumber','mobilenumber'],
  'disposition':     ['disposition','desposition','disp','dispo','call disposition','call status'],
  'sub disposition': ['sub disposition','sub desposition','sub disp','sub dispo','sub-disposition','sub-desposition','subdisposition','subdesposition','sub call status','sub status']
};

function resolveColumns(headerRow) {
  // Returns { 'phone number': colIdx, 'disposition': colIdx, 'sub disposition': colIdx }
  const result = {};
  headerRow.forEach((h, idx) => {
    const hl = String(h).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    for (const [canon, aliases] of Object.entries(COL_ALIASES)) {
      if (aliases.includes(hl) && !(canon in result)) {
        result[canon] = idx;
      }
    }
  });
  return result;
}

// ── Helper ─────────────────────────────────────────────────────────────────
function fmtPhone(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// ── Admin: Upload Excel File ───────────────────────────────────────────────
exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const originalName = req.file.originalname;
    const ext          = path.extname(originalName).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return res.status(400).json({ success: false, message: 'Only .xlsx and .xls files are allowed.' });
    }

    // Parse workbook
    const wb      = XLSX.read(req.file.buffer, { type: 'buffer' });
    const wsName  = wb.SheetNames[0];
    if (!wsName) return res.status(400).json({ success: false, message: 'Excel file is empty or has no sheets.' });
    const ws      = wb.Sheets[wsName];
    const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Parse header row and resolve columns by alias
    const colMap  = resolveColumns(rows[0]);
    const phoneIdx = colMap['phone number'];
    const dispIdx  = colMap['disposition'];
    const subIdx   = colMap['sub disposition'];

    if (phoneIdx === undefined) {
      return res.status(400).json({ success: false, message: 'Could not find a Phone Number column in the uploaded file.' });
    }

    const dataRows = rows.slice(1).filter(r => fmtPhone(r[phoneIdx]) !== '');
    if (dataRows.length === 0) {
      return res.status(400).json({ success: false, message: 'No phone number rows found in the file.' });
    }

    const fileName = `${Date.now()}_${originalName}`;

    const [fileResult] = await db.query(
      `INSERT INTO excel_files (file_name, original_name, uploaded_by, status, total_records)
       VALUES (?, ?, ?, 'Assigned', ?)`,
      [fileName, originalName, req.user.id, dataRows.length]
    );
    const fileId = fileResult.insertId;

    // Bulk insert records — capture disposition & sub-disposition if already in the file
    const values = dataRows.map((r, idx) => [
      fileId,
      idx + 1,
      fmtPhone(r[phoneIdx]),
      dispIdx !== undefined ? String(r[dispIdx] || '').trim() : '',
      subIdx  !== undefined ? String(r[subIdx]  || '').trim() : ''
    ]);
    await db.query(
      'INSERT INTO excel_records (file_id, row_index, phone_number, disposition, sub_disposition) VALUES ?',
      [values]
    );

    const [[file]] = await db.query(
      `SELECT ef.*, u.name as uploaded_by_name
       FROM excel_files ef
       JOIN users u ON u.id = ef.uploaded_by
       WHERE ef.id = ?`,
      [fileId]
    );

    res.json({ success: true, message: 'File uploaded successfully.', file });
  } catch (err) {
    console.error('[Excel] uploadFile:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Upload failed.' });
  }
};

// ── Admin: List All Files ──────────────────────────────────────────────────
exports.getFiles = async (req, res) => {
  try {
    const [files] = await db.query(
      `SELECT ef.*, u.name as uploaded_by_name,
        (SELECT COUNT(*) FROM excel_assignments ea WHERE ea.file_id = ef.id) as assignment_count,
        (SELECT COUNT(*) FROM excel_records er WHERE er.file_id = ef.id AND er.status = 'Completed') as completed_count
       FROM excel_files ef
       JOIN users u ON u.id = ef.uploaded_by
       ORDER BY ef.created_at DESC`
    );

    for (const f of files) {
      const [empRows] = await db.query(
        `SELECT u.name FROM excel_assignments ea
         JOIN users u ON u.id = ea.employee_id
         WHERE ea.file_id = ?`,
        [f.id]
      );
      f.assigned_employees = empRows.map(e => e.name);
      f.pending_count      = f.total_records - f.completed_count;
      f.completion_pct     = f.total_records > 0
        ? Math.round((f.completed_count / f.total_records) * 100) : 0;
    }

    res.json({ success: true, files });
  } catch (err) {
    console.error('[Excel] getFiles:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch files.' });
  }
};

// ── Admin: Single File Detail ──────────────────────────────────────────────
exports.getFile = async (req, res) => {
  try {
    const { id } = req.params;
    const [[file]] = await db.query(
      `SELECT ef.*, u.name as uploaded_by_name
       FROM excel_files ef JOIN users u ON u.id = ef.uploaded_by
       WHERE ef.id = ?`,
      [id]
    );
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });

    const [assignments] = await db.query(
      `SELECT ea.*, u.name as employee_name, u.email as employee_email,
        (SELECT COUNT(*) FROM excel_records er
         WHERE er.file_id = ea.file_id AND er.updated_by = ea.employee_id AND er.status = 'Completed') as completed
       FROM excel_assignments ea
       JOIN users u ON u.id = ea.employee_id
       WHERE ea.file_id = ?`,
      [id]
    );

    const [countRow] = await db.query(
      `SELECT COUNT(*) as completed FROM excel_records WHERE file_id = ? AND status = 'Completed'`,
      [id]
    );
    const completedCount  = countRow[0].completed;
    const pendingCount    = file.total_records - completedCount;
    const completionPct   = file.total_records > 0
      ? Math.round((completedCount / file.total_records) * 100) : 0;

    res.json({
      success: true,
      file: { ...file, completed_count: completedCount, pending_count: pendingCount, completion_pct: completionPct },
      assignments
    });
  } catch (err) {
    console.error('[Excel] getFile:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch file.' });
  }
};

// ── Admin: Assign Employees ────────────────────────────────────────────────
exports.assignEmployees = async (req, res) => {
  try {
    const { id }           = req.params;
    const { employee_ids } = req.body;

    if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'employee_ids must be a non-empty array.' });
    }

    const [[file]] = await db.query('SELECT id FROM excel_files WHERE id = ?', [id]);
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });

    // Remove old assignments first
    await db.query('DELETE FROM excel_assignments WHERE file_id = ?', [id]);

    // Insert new
    const vals = employee_ids.map(eid => [id, eid, req.user.id]);
    await db.query(
      'INSERT INTO excel_assignments (file_id, employee_id, assigned_by) VALUES ?',
      [vals]
    );

    await db.query(`UPDATE excel_files SET status = 'Assigned', updated_at = NOW() WHERE id = ?`, [id]);

    res.json({ success: true, message: `File assigned to ${employee_ids.length} employee(s).` });
  } catch (err) {
    console.error('[Excel] assignEmployees:', err.message);
    res.status(500).json({ success: false, message: 'Assignment failed.' });
  }
};

// ── Admin: Get File Records ────────────────────────────────────────────────
exports.getFileRecords = async (req, res) => {
  try {
    const { id }     = req.params;
    const { search, filter, page = 1, limit = 100 } = req.query;
    const offset     = (parseInt(page) - 1) * parseInt(limit);

    let where  = 'er.file_id = ?';
    const args = [id];

    if (search) {
      where += ' AND (er.phone_number LIKE ? OR er.disposition LIKE ? OR er.sub_disposition LIKE ?)';
      const like = `%${search}%`;
      args.push(like, like, like);
    }
    if (filter === 'completed') { where += " AND er.status = 'Completed'"; }
    if (filter === 'pending')   { where += " AND er.status = 'Pending'"; }

    const [records] = await db.query(
      `SELECT er.*, u.name as employee_name
       FROM excel_records er
       LEFT JOIN users u ON u.id = er.updated_by
       WHERE ${where}
       ORDER BY er.row_index
       LIMIT ? OFFSET ?`,
      [...args, parseInt(limit), offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM excel_records er WHERE ${where}`,
      args
    );

    res.json({ success: true, records, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[Excel] getFileRecords:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch records.' });
  }
};

// ── Admin: Update File Status ──────────────────────────────────────────────
exports.updateFileStatus = async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;
    const allowed    = ['Assigned', 'In Progress', 'Completed', 'Closed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    await db.query('UPDATE excel_files SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
    if (status === 'Closed') {
      await db.query("UPDATE excel_assignments SET status = 'Closed' WHERE file_id = ?", [id]);
    }
    res.json({ success: true, message: `Status updated to ${status}.` });
  } catch (err) {
    console.error('[Excel] updateFileStatus:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
};

// ── Admin: Delete File ─────────────────────────────────────────────────────
exports.deleteFile = async (req, res) => {
  try {
    const { id } = req.params;
    const [[file]] = await db.query('SELECT id FROM excel_files WHERE id = ?', [id]);
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });

    await db.query('DELETE FROM excel_audit       WHERE file_id = ?', [id]);
    await db.query('DELETE FROM excel_records     WHERE file_id = ?', [id]);
    await db.query('DELETE FROM excel_assignments WHERE file_id = ?', [id]);
    await db.query('DELETE FROM excel_files       WHERE id = ?',      [id]);

    res.json({ success: true, message: 'File deleted successfully.' });
  } catch (err) {
    console.error('[Excel] deleteFile:', err.message);
    res.status(500).json({ success: false, message: 'Delete failed.' });
  }
};

// ── Admin: Export File as CSV ──────────────────────────────────────────────
exports.exportFile = async (req, res) => {
  try {
    const { id } = req.params;
    const [[file]] = await db.query('SELECT * FROM excel_files WHERE id = ?', [id]);
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });

    const [records] = await db.query(
      `SELECT er.phone_number, er.disposition, er.sub_disposition,
              u.name as employee_name, er.status, er.updated_at
       FROM excel_records er
       LEFT JOIN users u ON u.id = er.updated_by
       WHERE er.file_id = ?
       ORDER BY er.row_index`,
      [id]
    );

    const { format = 'csv' } = req.query;

    if (format === 'xlsx') {
      // Export as XLSX
      const sheetData = [['Phone Number', 'Disposition', 'Sub Disposition', 'Employee', 'Status', 'Updated At']];
      for (const r of records) {
        sheetData.push([
          r.phone_number, r.disposition || '', r.sub_disposition || '',
          r.employee_name || '', r.status,
          r.updated_at ? new Date(r.updated_at).toLocaleString('en-IN') : ''
        ]);
      }
      const ws  = XLSX.utils.aoa_to_sheet(sheetData);
      const wb  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Export');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const safeName = file.original_name.replace(/[^a-z0-9._-]/gi, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="export_${safeName}"`);
      return res.send(buf);
    }

    // Default CSV
    let csv = 'Phone Number,Disposition,Sub Disposition,Employee,Status,Updated At\n';
    for (const r of records) {
      const row = [
        r.phone_number,
        r.disposition    || '',
        r.sub_disposition || '',
        r.employee_name  || '',
        r.status,
        r.updated_at ? new Date(r.updated_at).toLocaleString('en-IN') : ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
      csv += row + '\n';
    }

    const safeName = file.original_name.replace(/[^a-z0-9._-]/gi, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="export_${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[Excel] exportFile:', err.message);
    res.status(500).json({ success: false, message: 'Export failed.' });
  }
};

// ── Admin: Employees List for Assignment Dropdown ──────────────────────────
// Include employees who are active OR auto-deactivated (outside business hours).
// Exclude only hard-deactivated employees (is_active=0 AND auto_deactivated=0).
exports.getEmployeesList = async (req, res) => {
  try {
    const [employees] = await db.query(
      `SELECT id, name, email, is_active, auto_deactivated
       FROM users
       WHERE role = 'employee'
         AND NOT (is_active = 0 AND auto_deactivated = 0 AND manual_override = 0)
       ORDER BY name`
    );
    res.json({ success: true, employees });
  } catch (err) {
    console.error('[Excel] getEmployeesList:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch employees.' });
  }
};

// ── Admin: Audit Trail ─────────────────────────────────────────────────────
exports.getAudit = async (req, res) => {
  try {
    const { file_id, employee_id, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where  = '1=1';
    const args = [];
    if (file_id)     { where += ' AND ea.file_id = ?';     args.push(file_id); }
    if (employee_id) { where += ' AND ea.employee_id = ?'; args.push(employee_id); }

    const [rows] = await db.query(
      `SELECT ea.*, u.name as employee_name, ef.original_name as file_name
       FROM excel_audit ea
       JOIN users u       ON u.id  = ea.employee_id
       JOIN excel_files ef ON ef.id = ea.file_id
       WHERE ${where}
       ORDER BY ea.created_at DESC
       LIMIT ? OFFSET ?`,
      [...args, parseInt(limit), offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM excel_audit ea WHERE ${where}`,
      args
    );

    res.json({ success: true, audit: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[Excel] getAudit:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch audit trail.' });
  }
};

// ── Employee: My Assignments ───────────────────────────────────────────────
exports.getMyAssignments = async (req, res) => {
  try {
    const empId = req.user.id;
    const [rows] = await db.query(
      `SELECT ea.*, ef.original_name, ef.total_records, ef.status as file_status,
              ef.uploaded_at, ef.updated_at as file_updated_at,
              u.name as assigned_by_name,
        (SELECT COUNT(*) FROM excel_records er
         WHERE er.file_id = ef.id AND er.updated_by = ? AND er.status = 'Completed') as completed
       FROM excel_assignments ea
       JOIN excel_files ef ON ea.file_id = ef.id
       JOIN users u        ON u.id = ea.assigned_by
       WHERE ea.employee_id = ? AND ea.status != 'Closed'
       ORDER BY ea.assigned_at DESC`,
      [empId, empId]
    );

    const assignments = rows.map(r => ({
      ...r,
      pending:         r.total_records - r.completed,
      completion_pct:  r.total_records > 0
        ? Math.round((r.completed / r.total_records) * 100) : 0
    }));

    res.json({ success: true, assignments });
  } catch (err) {
    console.error('[Excel] getMyAssignments:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch assignments.' });
  }
};

// ── Employee: Get Assignment Records ──────────────────────────────────────
exports.getAssignmentRecords = async (req, res) => {
  try {
    const empId        = req.user.id;
    const { assignmentId } = req.params;
    const { search, filter, page = 1, limit = 100 } = req.query;
    const offset       = (parseInt(page) - 1) * parseInt(limit);

    // Verify ownership
    const [[asgn]] = await db.query(
      'SELECT * FROM excel_assignments WHERE id = ? AND employee_id = ?',
      [assignmentId, empId]
    );
    if (!asgn) return res.status(403).json({ success: false, message: 'Assignment not found or access denied.' });

    const [[file]] = await db.query('SELECT * FROM excel_files WHERE id = ?', [asgn.file_id]);

    let where  = 'er.file_id = ?';
    const args = [asgn.file_id];

    if (search) {
      where += ' AND (er.phone_number LIKE ? OR er.disposition LIKE ? OR er.sub_disposition LIKE ?)';
      const like = `%${search}%`;
      args.push(like, like, like);
    }
    if (filter === 'completed') { where += " AND er.status = 'Completed'"; }
    if (filter === 'pending')   { where += " AND er.status = 'Pending'"; }

    const [records] = await db.query(
      `SELECT er.* FROM excel_records er
       WHERE ${where}
       ORDER BY er.row_index
       LIMIT ? OFFSET ?`,
      [...args, parseInt(limit), offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM excel_records er WHERE ${where}`,
      args
    );

    res.json({
      success: true,
      assignment: asgn,
      file,
      records,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('[Excel] getAssignmentRecords:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch records.' });
  }
};

// ── Shared: Update a Record (Employee must be assigned to the file) ─────────
exports.updateRecord = async (req, res) => {
  try {
    const userId   = req.user.id;
    const { recordId } = req.params;
    const { disposition, sub_disposition } = req.body;

    // Fetch current record
    const [[record]] = await db.query('SELECT * FROM excel_records WHERE id = ?', [recordId]);
    if (!record) return res.status(404).json({ success: false, message: 'Record not found.' });

    // Verify assignment (admin can always update)
    if (req.user.role !== 'admin') {
      const [[asgn]] = await db.query(
        'SELECT id FROM excel_assignments WHERE file_id = ? AND employee_id = ? AND status != ?',
        [record.file_id, userId, 'Closed']
      );
      if (!asgn) return res.status(403).json({ success: false, message: 'Access denied: not assigned to this file.' });
    }

    // Save old values for audit
    const oldDisp    = record.disposition;
    const oldSubDisp = record.sub_disposition;

    // Determine new status
    const newDisp    = disposition    !== undefined ? disposition    : oldDisp;
    const newSubDisp = sub_disposition !== undefined ? sub_disposition : oldSubDisp;
    const newStatus  = (newDisp && newSubDisp) ? 'Completed' : 'Pending';

    await db.query(
      `UPDATE excel_records
       SET disposition = ?, sub_disposition = ?, updated_by = ?, status = ?, updated_at = NOW()
       WHERE id = ?`,
      [newDisp, newSubDisp, userId, newStatus, recordId]
    );

    // Audit log
    await db.query(
      `INSERT INTO excel_audit
         (file_id, record_id, employee_id, phone_number,
          old_disposition, new_disposition, old_sub_disposition, new_sub_disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.file_id, recordId, userId, record.phone_number,
       oldDisp, newDisp, oldSubDisp, newSubDisp]
    );

    // Update assignment progress
    const [[prog]] = await db.query(
      `SELECT COUNT(*) as completed FROM excel_records
       WHERE file_id = ? AND updated_by = ? AND status = 'Completed'`,
      [record.file_id, userId]
    );
    await db.query(
      `UPDATE excel_assignments SET progress = ?, status = 'In Progress', updated_at = NOW()
       WHERE file_id = ? AND employee_id = ?`,
      [prog.completed, record.file_id, userId]
    );

    // Update file status to In Progress if still Assigned
    await db.query(
      `UPDATE excel_files SET status = 'In Progress', updated_at = NOW()
       WHERE id = ? AND status = 'Assigned'`,
      [record.file_id]
    );

    const [[updated]] = await db.query('SELECT * FROM excel_records WHERE id = ?', [recordId]);
    res.json({ success: true, record: updated });
  } catch (err) {
    console.error('[Excel] updateRecord:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update record.' });
  }
};

// ── Employee: Submit Assignment ────────────────────────────────────────────
exports.submitAssignment = async (req, res) => {
  try {
    const empId        = req.user.id;
    const { assignmentId } = req.params;

    const [[asgn]] = await db.query(
      'SELECT * FROM excel_assignments WHERE id = ? AND employee_id = ?',
      [assignmentId, empId]
    );
    if (!asgn) return res.status(403).json({ success: false, message: 'Assignment not found or access denied.' });

    // Check all records are complete
    const [incomplete] = await db.query(
      `SELECT phone_number FROM excel_records
       WHERE file_id = ? AND (disposition IS NULL OR disposition = '' OR sub_disposition IS NULL OR sub_disposition = '')`,
      [asgn.file_id]
    );

    if (incomplete.length > 0) {
      return res.status(400).json({
        success: false,
        message: `${incomplete.length} record(s) are incomplete. Fill Disposition and Sub Disposition for all rows before submitting.`,
        incomplete_phones: incomplete.map(r => r.phone_number)
      });
    }

    await db.query(
      `UPDATE excel_assignments SET status = 'Completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [assignmentId]
    );

    // Check if ALL assignments for this file are completed
    const [[{ pending }]] = await db.query(
      `SELECT COUNT(*) as pending FROM excel_assignments
       WHERE file_id = ? AND status != 'Completed'`,
      [asgn.file_id]
    );
    if (pending === 0) {
      await db.query(
        `UPDATE excel_files SET status = 'Completed', updated_at = NOW() WHERE id = ?`,
        [asgn.file_id]
      );
    }

    res.json({ success: true, message: 'Assignment submitted successfully. Sheet is now locked.' });
  } catch (err) {
    console.error('[Excel] submitAssignment:', err.message);
    res.status(500).json({ success: false, message: 'Submission failed.' });
  }
};

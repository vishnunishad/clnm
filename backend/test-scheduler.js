require('dotenv').config();
const db = require('./config/db');
const scheduler = require('./utils/scheduler');

async function testScheduler() {
  console.log('--- STARTING SCHEDULER VERIFICATION TEST ---');

  // Let's find our test employee: employee@cln.com
  const [users] = await db.query("SELECT * FROM users WHERE email = 'employee@cln.com'");
  const employee = users[0];

  if (!employee) {
    console.error('Error: employee@cln.com not found in the database. Please seed the database first.');
    process.exit(1);
  }
  
  console.log(`Found test employee: ${employee.name} (ID: ${employee.id}, Role: ${employee.role})`);

  // Backup current working hours settings
  const [originalSettings] = await db.query('SELECT * FROM system_settings');
  console.log('Original settings backed up:', originalSettings);

  try {
    // ----------------------------------------------------
    // TEST 1: Force INSIDE Working Hours
    // ----------------------------------------------------
    console.log('\n--- TEST 1: Inside Working Hours (Auto Activation) ---');
    
    // Set hours from 00:00 to 23:59 (always inside)
    await db.query('UPDATE system_settings SET setting_value = "00:00" WHERE setting_key = "auto_activation_time"');
    await db.query('UPDATE system_settings SET setting_value = "23:59" WHERE setting_key = "auto_deactivation_time"');

    // Force user to be auto_deactivated = 1, is_active = 0
    await db.query('UPDATE users SET is_active = 0, auto_deactivated = 1 WHERE id = ?', [employee.id]);
    console.log('Prepared user state: is_active = 0, auto_deactivated = 1');

    // Run scheduler
    console.log('Running scheduler.checkAndProcessSchedules()...');
    await scheduler.checkAndProcessSchedules();

    // Verify user is now activated: is_active = 1, auto_deactivated = 0
    const [updatedUsers1] = await db.query('SELECT is_active, auto_deactivated, last_auto_activation FROM users WHERE id = ?', [employee.id]);
    const user1 = updatedUsers1[0];
    console.log('After activation user state:', user1);
    
    if (user1.is_active === 1 && user1.auto_deactivated === 0 && user1.last_auto_activation !== null) {
      console.log('✅ TEST 1 PASSED: Employee successfully activated!');
    } else {
      console.error('❌ TEST 1 FAILED: Employee was not activated correctly.');
    }

    // ----------------------------------------------------
    // TEST 2: Force OUTSIDE Working Hours
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Outside Working Hours (Auto Deactivation & Session Close) ---');
    
    // Set hours from 00:00 to 00:01 (always outside)
    await db.query('UPDATE system_settings SET setting_value = "00:00" WHERE setting_key = "auto_activation_time"');
    await db.query('UPDATE system_settings SET setting_value = "00:01" WHERE setting_key = "auto_deactivation_time"');

    // Force user to be active, and create an active attendance session
    await db.query('UPDATE users SET is_active = 1, auto_deactivated = 0 WHERE id = ?', [employee.id]);
    
    // Close existing sessions if any
    await db.query('UPDATE attendance_logs SET session_status = "Logged Out", logout_time = NOW() WHERE employee_id = ? AND session_status = "Active Session"', [employee.id]);
    
    // Insert fresh active session
    await db.query(
      'INSERT INTO attendance_logs (employee_id, employee_name, login_time, session_status) VALUES (?, ?, NOW() - INTERVAL 1 HOUR, "Active Session")',
      [employee.id, employee.name]
    );
    console.log('Prepared user state: is_active = 1, active attendance session created.');

    // Run scheduler
    console.log('Running scheduler.checkAndProcessSchedules()...');
    await scheduler.checkAndProcessSchedules();

    // Verify user is now deactivated: is_active = 0, auto_deactivated = 1
    const [updatedUsers2] = await db.query('SELECT is_active, auto_deactivated, auto_deactivated_at FROM users WHERE id = ?', [employee.id]);
    const user2 = updatedUsers2[0];
    console.log('After deactivation user state:', user2);

    // Verify attendance session closed
    const [closedSessions] = await db.query(
      'SELECT session_status, logout_time, total_working_hours FROM attendance_logs WHERE employee_id = ? ORDER BY id DESC LIMIT 1',
      [employee.id]
    );
    const session = closedSessions[0];
    console.log('Latest attendance session status:', session);

    if (user2.is_active === 0 && user2.auto_deactivated === 1 && user2.auto_deactivated_at !== null && session.session_status === 'Logged Out' && session.logout_time !== null) {
      console.log('✅ TEST 2 PASSED: Employee successfully deactivated and attendance session closed!');
    } else {
      console.error('❌ TEST 2 FAILED: Employee deactivation or session closure failed.');
    }

    // ----------------------------------------------------
    // TEST 3: Activity Log Verification
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Activity Log Verification ---');
    const [logs] = await db.query('SELECT activity FROM user_activity_logs WHERE user_id = ? ORDER BY id DESC LIMIT 2', [employee.id]);
    console.log('Recent activity logs:');
    logs.forEach((log, index) => {
      console.log(`[Log ${index + 1}]:\n${log.activity}\n-----------------------------`);
    });

    if (logs.length >= 2 && logs[0].activity.includes('Auto Deactivated') && logs[1].activity.includes('Auto Activated')) {
      console.log('✅ TEST 3 PASSED: Audit activity logs created in exact expected format!');
    } else {
      console.error('❌ TEST 3 FAILED: Activity logs not generated or formatted incorrectly.');
    }

  } catch (err) {
    console.error('An error occurred during verification tests:', err);
  } finally {
    // Restore original settings
    console.log('\nRestoring original settings...');
    for (const setting of originalSettings) {
      await db.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [setting.setting_value, setting.setting_key]);
    }
    // Set employee back to active and reset auto_deactivated flag
    await db.query('UPDATE users SET is_active = 1, auto_deactivated = 0 WHERE id = ?', [employee.id]);
    console.log('Database restored.');
    console.log('\n--- SCHEDULER VERIFICATION TEST COMPLETE ---');
    process.exit(0);
  }
}

testScheduler();

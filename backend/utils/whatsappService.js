const db = require('../config/db');

function parseTemplate(templateText, variables = {}) {
  let text = templateText;
  for (const [key, val] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    text = text.replace(regex, val !== null && val !== undefined ? val : '');
  }
  return text;
}

async function sendMessage({ customerName, phone, content, employeeId = null, campaignId = null, attachmentName = null, attachmentPath = null }) {
  try {
    // Check connectivity status
    const [connRows] = await db.query('SELECT status FROM whatsapp_connections LIMIT 1');
    const isConnected = connRows.length > 0 && connRows[0].status === 'Connected';
    const initialStatus = isConnected ? 'Sent' : 'Failed';

    // Save to database
    const [res] = await db.query(
      `INSERT INTO whatsapp_messages (customer_name, phone, content, status, direction, attachment_name, attachment_path, employee_id, campaign_id)
       VALUES (?, ?, ?, ?, 'Outgoing', ?, ?, ?, ?)`,
      [customerName, phone, content, initialStatus, attachmentName, attachmentPath, employeeId, campaignId]
    );
    const messageId = res.insertId;

    // Simulate delivery status transitions asynchronously
    if (initialStatus === 'Sent') {
      if (campaignId) {
        await db.query(
          "UPDATE whatsapp_campaigns SET sent_count = sent_count + 1 WHERE id = ?",
          [campaignId]
        );
      }

      setTimeout(async () => {
        try {
          await db.query("UPDATE whatsapp_messages SET status = 'Delivered' WHERE id = ?", [messageId]);
          
          if (campaignId) {
            await db.query(
              "UPDATE whatsapp_campaigns SET delivered_count = delivered_count + 1 WHERE id = ?",
              [campaignId]
            );
          }

          setTimeout(async () => {
            try {
              await db.query("UPDATE whatsapp_messages SET status = 'Read' WHERE id = ?", [messageId]);
              if (campaignId) {
                await db.query(
                  "UPDATE whatsapp_campaigns SET read_count = read_count + 1 WHERE id = ?",
                  [campaignId]
                );
              }
            } catch (e) {}
          }, 3000);
        } catch (e) {}
      }, 2000);
    } else {
      if (campaignId) {
        await db.query(
          "UPDATE whatsapp_campaigns SET failed_count = failed_count + 1 WHERE id = ?",
          [campaignId]
        );
      }
    }

    return { success: true, messageId, status: initialStatus };
  } catch (err) {
    console.error('[WhatsApp Service] Send message error:', err);
    return { success: false, error: err.message };
  }
}

async function sendWorkflowMessage(category, customerId, extraVariables = {}) {
  try {
    // 1. Fetch customer
    const [custRows] = await db.query('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (custRows.length === 0) return;
    const customer = custRows[0];

    // 2. Fetch template
    const [tempRows] = await db.query('SELECT content FROM whatsapp_templates WHERE category = ? LIMIT 1', [category]);
    if (tempRows.length === 0) return;
    const templateContent = tempRows[0].content;

    // 3. Compile variables
    const variables = {
      customer_name: customer.name,
      loan_number: extraVariables.loan_number || 'N/A',
      loan_amount: extraVariables.loan_amount || 'N/A',
      emi_amount: extraVariables.emi_amount || 'N/A',
      due_date: extraVariables.due_date || 'N/A',
      branch_name: extraVariables.branch_name || 'Main Branch',
      employee_name: extraVariables.employee_name || 'Relationship Manager'
    };

    const content = parseTemplate(templateContent, variables);

    // 4. Send Message
    await sendMessage({
      customerName: customer.name,
      phone: customer.phone,
      content,
      employeeId: extraVariables.employee_id || customer.added_by
    });
  } catch (err) {
    console.error('[WhatsApp Service] Send workflow message error:', err);
  }
}

module.exports = {
  parseTemplate,
  sendMessage,
  sendWorkflowMessage
};

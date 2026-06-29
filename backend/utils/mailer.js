const nodemailer = require('nodemailer');

async function sendViaSMTP({ to, subject, html, text }) {
  const secure = process.env.SMTP_SECURE === 'true';
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: to,
    subject: subject,
    html: html,
    text: text
  };

  return transporter.sendMail(mailOptions);
}

function normalizeResendConfig() {
  const apiKey = cleanEnvValue(process.env.RESEND_API_KEY || '');
  const from = normalizeResendFrom(process.env.RESEND_FROM || '');

  logResendEnvPresence(apiKey, from);

  if (!apiKey || !from) {
    throw new Error('Resend is not configured. Set RESEND_API_KEY and RESEND_FROM.');
  }

  return { apiKey, from };
}

function normalizeResendFrom(value) {
  const rawValue = cleanEnvValue(value || '');

  if (!rawValue) return '';

  const mailtoMatch = rawValue.match(/mailto:([^\]\)\s>]+)/i);
  if (mailtoMatch && mailtoMatch[1]) {
    return mailtoMatch[1].trim();
  }

  const angleMatch = rawValue.match(/<([^>]+)>/);
  if (angleMatch && angleMatch[1]) {
    return angleMatch[1].trim();
  }

  const markdownMailtoMatch = rawValue.match(/\[([^\]]+)\]\(mailto:([^\)]+)\)/i);
  if (markdownMailtoMatch && markdownMailtoMatch[2]) {
    return markdownMailtoMatch[2].trim();
  }

  return rawValue;
}

function cleanEnvValue(value) {
  const rawValue = String(value || '').trim();

  if (!rawValue) return '';

  const hasWrappingQuotes = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
  return hasWrappingQuotes ? rawValue.slice(1, -1).trim() : rawValue;
}

function logResendEnvPresence(apiKey, from) {
  const debugEnabled = String(process.env.RESEND_DEBUG || '').trim().toLowerCase() === 'true';

  if (!debugEnabled) {
    return;
  }

  console.info('[Mailer] Resend env presence:', {
    apiKeyPresent: Boolean(apiKey),
    apiKeyLength: apiKey ? apiKey.length : 0,
    fromPresent: Boolean(from),
    fromLength: from ? from.length : 0
  });
}

function debugMailerEnvironment() {
  const smtpHost = process.env.SMTP_HOST;
  const resendKey = process.env.RESEND_API_KEY;

  if (smtpHost) {
    console.info(`[Mailer] Configured to use SMTP: ${smtpHost}:${process.env.SMTP_PORT || 587}, User: ${process.env.SMTP_USER}`);
  } else if (resendKey) {
    console.info(`[Mailer] Configured to use Resend API, From: ${process.env.RESEND_FROM}`);
  } else {
    console.warn('[Mailer] WARNING: No mailer transport (SMTP or Resend) is configured!');
  }
}

function buildResetEmail({ name, resetUrl }) {
  const subject = 'Reset your CLN password';
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
      <h2 style="margin-bottom: 16px;">Password reset request</h2>
      <p>Hello ${name || 'there'},</p>
      <p>We received a request to reset the password for your CLN admin account.</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;">Reset password</a>
      </p>
      <p>If the button does not work, copy and paste this link into your browser:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link will expire soon for your security.</p>
    </div>
  `;

  const text = [
    `Hello ${name || 'there'},`,
    '',
    'We received a request to reset the password for your CLN admin account.',
    '',
    `Reset it here: ${resetUrl}`,
    '',
    'This link will expire soon for your security.'
  ].join('\n');

  return { subject, html, text };
}

async function sendViaResend({ to, subject, html, text }) {
  const { apiKey, from } = normalizeResendConfig();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 15000);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text
      }),
      signal: abortController.signal
    });

    const rawBody = await response.text();
    const parsedBody = rawBody ? tryParseJson(rawBody) : null;

    if (!response.ok) {
      const responseMessage = parsedBody?.message || parsedBody?.error || rawBody || response.statusText || 'Unknown error';
      throw new Error(`Resend request failed: ${response.status} ${responseMessage}`);
    }

    if (!parsedBody || typeof parsedBody !== 'object' || !parsedBody.id) {
      throw new Error('Resend request failed: invalid API response.');
    }

    return parsedBody;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Resend request timed out while sending the email.');
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  if (!to || !resetUrl) {
    throw new Error('Password reset email requires both a recipient and reset URL.');
  }

  const { subject, html, text } = buildResetEmail({ name, resetUrl });

  try {
    if (process.env.SMTP_HOST) {
      await sendViaSMTP({ to, subject, html, text });
    } else {
      await sendViaResend({ to, subject, html, text });
    }
  } catch (err) {
    console.error('[Mailer] sendPasswordResetEmail error:', err && err.message ? err.message : err);
    throw err;
  }
}

async function sendSystemNotificationEmail({ to, name, subject, message }) {
  if (!to || !message) {
    throw new Error('System notification email requires a recipient and message.');
  }

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
      <h2 style="margin-bottom: 16px;">System Notification</h2>
      <p>Hello ${name || 'there'},</p>
      <p>${message}</p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">This is an automated system notification from CLN.</p>
    </div>
  `;

  const text = `Hello ${name || 'there'},\n\n${message}\n\nThis is an automated system notification from CLN.`;

  try {
    if (process.env.SMTP_HOST) {
      await sendViaSMTP({ to, subject, html, text });
    } else {
      await sendViaResend({ to, subject, html, text });
    }
  } catch (err) {
    console.error('[Mailer] sendSystemNotificationEmail error:', err && err.message ? err.message : err);
    throw err;
  }
}

module.exports = {
  sendPasswordResetEmail,
  sendSystemNotificationEmail,
  debugResendEnvironment: debugMailerEnvironment
};


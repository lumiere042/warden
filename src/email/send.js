/** Send the report through Resend or SMTP, picked by EMAIL_PROVIDER. */
export async function sendEmail({ subject, html, attachmentHtml, attachmentName }, email) {
  if (!email.to.length) throw new Error('EMAIL_TO is not set');
  if (!email.from) throw new Error('EMAIL_FROM is not set');

  if (email.provider === 'resend') return sendResend({ subject, html, attachmentHtml, attachmentName }, email);
  if (email.provider === 'smtp') return sendSmtp({ subject, html, attachmentHtml, attachmentName }, email);
  throw new Error(`EMAIL_PROVIDER must be "resend" or "smtp" (got "${email.provider || ''}")`);
}

async function sendResend({ subject, html, attachmentHtml, attachmentName }, email) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: email.from,
    to: email.to,
    subject,
    html,
    attachments: [{ filename: attachmentName, content: Buffer.from(attachmentHtml).toString('base64') }],
  });
  if (error) throw new Error(`Resend: ${error.message}`);
  return data?.id;
}

async function sendSmtp({ subject, html, attachmentHtml, attachmentName }, email) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) throw new Error('SMTP_HOST is not set');
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  const info = await transport.sendMail({
    from: email.from,
    to: email.to.join(', '),
    subject,
    html,
    attachments: [{ filename: attachmentName, content: attachmentHtml, contentType: 'text/html' }],
  });
  return info.messageId;
}

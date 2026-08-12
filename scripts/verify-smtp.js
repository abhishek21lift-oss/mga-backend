#!/usr/bin/env node
'use strict';
// Check the SMTP credentials before a real customer's invitation is the test.
//
//   node scripts/verify-smtp.js                 # verify the connection only
//   node scripts/verify-smtp.js you@example.com # ...and send a real invitation
//
// The second form sends the ACTUAL invitation template with a dummy token, so
// what lands in the inbox is what a studio owner will see — including how it
// renders in dark mode and whether it went to spam. A template that passes
// unit tests can still look wrong in Outlook.
//
// Reads the same environment variables the server does. Nothing is written to
// the database and no invitation row is created.

require('dotenv').config();

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

/** Explains what a given failure actually means, rather than echoing the code. */
function diagnose(err) {
  const code = err.code || '';
  const response = err.response || '';

  if (code === 'EAUTH' || /535|534|password|authenticat/i.test(response)) {
    return [
      'The host accepted the connection but rejected the credentials.',
      '',
      '  • SMTP_USER must be the FULL address (support@myptstudio.com), not "support".',
      '  • SMTP_PASS is the MAILBOX password set in hPanel → Emails → the mailbox →',
      '    Change password. It is not your hPanel account password.',
      '  • The mailbox has to exist. Authenticating against an address that was',
      '    never provisioned fails exactly like a wrong password.',
    ].join('\n');
  }
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(err.message || '')) {
    return [
      `The hostname "${process.env.SMTP_HOST}" does not resolve — so this is a typo`,
      'or a wrong host, not a credentials problem.',
      '',
      '  • Hostinger\'s is normally smtp.hostinger.com, but the mailbox\'s',
      '    "Connect apps manually" panel is authoritative — it sometimes lists a',
      '    numbered host instead.',
      '  • Check for a stray space or a pasted "https://" prefix; this field is a',
      '    bare hostname, not a URL.',
    ].join('\n');
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
    const port = process.env.SMTP_PORT || '(unset, defaulting to 587)';
    return [
      `Could not establish a session on port ${port}.`,
      '',
      '  • 465 is implicit TLS, 587 is STARTTLS. The code sets secure=true only',
      '    for 465, so those are the only two correct pairings — 465 with',
      '    STARTTLS settings hangs rather than returning an error.',
      '  • Check SMTP_HOST against the mailbox\'s "Connect apps manually" panel;',
      '    Hostinger sometimes lists a numbered host rather than smtp.hostinger.com.',
      '  • Some networks block outbound 465/587 entirely. If this works from your',
      '    laptop but not from the deploy, that is the likely cause.',
    ].join('\n');
  }
  if (code === 'EENVELOPE' || /550|553|relay/i.test(response)) {
    return [
      'The server refused the envelope — usually the From address.',
      '',
      '  • EMAIL_FROM / SMTP_FROM must be an address on a domain this mailbox is',
      '    allowed to send as. Hostinger will not relay for a domain it does not',
      '    host, even with valid credentials.',
    ].join('\n');
  }
  return 'No specific diagnosis for this one — the raw error is above.';
}

async function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing: ${missing.join(', ')}`);
    console.error('Set them in .env (locally) or the Render dashboard, then re-run.');
    process.exit(1);
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  console.log('Configuration');
  console.log(`  host    ${process.env.SMTP_HOST}`);
  console.log(`  port    ${port} (${port === 465 ? 'implicit TLS' : 'STARTTLS'})`);
  console.log(`  user    ${process.env.SMTP_USER}`);
  // Never printed. Length alone is enough to catch a truncated paste or a
  // trailing newline picked up from a copy.
  console.log(`  pass    ${'*'.repeat(8)} (${process.env.SMTP_PASS.length} chars)`);
  console.log(`  from    ${process.env.EMAIL_FROM || process.env.SMTP_FROM || '(unset)'}`);
  console.log('');

  if (/\s/.test(process.env.SMTP_PASS)) {
    console.warn('  ! SMTP_PASS contains whitespace — often a stray newline from a paste.\n');
  }

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  try {
    process.stdout.write('Verifying connection and credentials… ');
    await transport.verify();
    console.log('OK\n');
  } catch (err) {
    console.log('FAILED\n');
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    if (err.response) console.error(`Server said: ${err.response}`);
    console.error(`\n${diagnose(err)}`);
    process.exit(1);
  }

  const to = process.argv[2];
  if (!to) {
    console.log('Credentials are good. Pass an address to send a real test invitation:');
    console.log('  node scripts/verify-smtp.js you@example.com');
    return;
  }

  // Deliberately the real template with a dummy token, so what arrives is
  // exactly what a studio owner receives. The link will land on the
  // set-password page and correctly report an invalid invitation.
  const { invitationHtml, invitationText } = require('../src/lib/emailTemplates/invitation');
  const vars = {
    ownerName: 'Test Owner',
    studioName: 'Test Studio',
    email: to,
    actionUrl: `${(process.env.FRONTEND_URL || 'https://example.com').replace(/\/+$/, '')}/auth/set-password?token=smtp-verification-not-a-real-token`,
    expiryHours: 24,
  };

  try {
    process.stdout.write(`Sending a test invitation to ${to}… `);
    const info = await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: '[TEST] You\'re invited to MY PT STUDIO — activate Test Studio',
      text: invitationText(vars),
      html: invitationHtml(vars),
    });
    console.log('sent');
    console.log(`  message id  ${info.messageId}`);
    if (info.accepted?.length) console.log(`  accepted    ${info.accepted.join(', ')}`);
    if (info.rejected?.length) console.log(`  rejected    ${info.rejected.join(', ')}`);
    console.log('');
    console.log('Check the inbox — and the spam folder. Worth confirming:');
    console.log('  • it did not land in spam (if it did, check SPF/DKIM for the domain)');
    console.log('  • the maroon button renders, including in dark mode');
    console.log('  • the "Set Your Password" link opens the activation page');
    console.log('    (it will correctly say the invitation is not valid — the token is fake)');
  } catch (err) {
    console.log('FAILED\n');
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    if (err.response) console.error(`Server said: ${err.response}`);
    console.error(`\n${diagnose(err)}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

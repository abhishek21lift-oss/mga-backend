'use strict';
// The admin invitation email.
//
// Written as table-based HTML with inline styles because that is what email
// clients actually render. Outlook uses Word's rendering engine, Gmail strips
// <style> blocks in some contexts, and flexbox/grid support is inconsistent
// everywhere. Every rule that matters is therefore inline and on a table.
//
// ── Dark mode ────────────────────────────────────────────────────────────
//
// Two mechanisms, because neither is enough alone. `color-scheme` +
// `prefers-color-scheme` covers Apple Mail and Gmail on iOS. Outlook.com and
// Gmail on Android instead FORCE-INVERT colours regardless, which is why the
// design leads with a near-black band that stays legible inverted rather than
// a white card that would flip to charcoal and drag the maroon with it.
//
// ── No remote images ─────────────────────────────────────────────────────
//
// The wordmark is text, not an <img>. Most clients block remote images by
// default, so a logo image would render as a broken box on first open — on the
// one email whose entire job is to look trustworthy enough to click. The only
// remote asset is the 1x1 tracking pixel, whose absence costs nothing.

const { siteName, supportEmail } = require('../siteIdentity');

const BRAND = {
  black: '#0B0B0C',
  ink: '#16171A',
  maroon: '#7B1E2B',
  maroonDark: '#5C161F',
  white: '#FFFFFF',
  paper: '#F6F5F4',
  line: '#E4E1DE',
  muted: '#6B6B70',
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @param {object} p
 * @param {string} p.ownerName   Person being invited.
 * @param {string} p.studioName  Their studio.
 * @param {string} p.email       Address the account logs in with.
 * @param {string} p.actionUrl   Set-password link carrying the raw token.
 * @param {string} [p.pixelUrl]  Open-tracking pixel. Omitted if unavailable.
 * @param {number} p.expiryHours
 */
function invitationHtml({ ownerName, studioName, email, actionUrl, pixelUrl, expiryHours }) {
  const owner = esc(ownerName || 'there');
  const studio = esc(studioName || 'Your studio');
  const addr = esc(email);
  const url = esc(actionUrl);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>Welcome to ${siteName()}</title>
<style>
  /* Stripped by some clients — everything here is an enhancement, never a
     requirement. The inline styles below stand on their own. */
  @media (prefers-color-scheme: dark) {
    .bodybg { background:${BRAND.black} !important; }
    .card { background:${BRAND.ink} !important; border-color:#2A2B2F !important; }
    .t-primary { color:${BRAND.white} !important; }
    .t-muted { color:#A0A0A6 !important; }
    .rule { border-color:#2A2B2F !important; }
    .detail { background:#1E1F23 !important; }
  }
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .h1 { font-size:24px !important; line-height:31px !important; }
    .cta a { display:block !important; }
  }
</style>
</head>
<body class="bodybg" style="margin:0;padding:0;background:${BRAND.paper};-webkit-font-smoothing:antialiased;">

<!-- Preheader: the grey line a client shows next to the subject. Hidden in the
     body itself, otherwise it prints twice. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
  Set your password to activate ${studio} on ${siteName()}. This link expires in ${expiryHours} hours.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bodybg" style="background:${BRAND.paper};">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

        <!-- Brand band. Near-black so a forced-inversion client still lands on
             something readable rather than flipping a white header to grey. -->
        <tr>
          <td class="pad" style="background:${BRAND.black};border-radius:14px 14px 0 0;padding:26px 36px;text-align:center;">
            <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:19px;font-weight:800;letter-spacing:3px;color:${BRAND.white};text-transform:uppercase;">
              ${esc(siteName()).replace(/ /g, '&nbsp;')}
            </div>
            <div style="height:3px;width:44px;background:${BRAND.maroon};margin:10px auto 0;border-radius:2px;"></div>
          </td>
        </tr>

        <tr>
          <td class="card pad" style="background:${BRAND.white};border-left:1px solid ${BRAND.line};border-right:1px solid ${BRAND.line};padding:36px;">

            <h1 class="h1 t-primary" style="margin:0 0 10px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:26px;line-height:33px;font-weight:800;color:${BRAND.ink};letter-spacing:-0.4px;">
              Welcome to ${esc(siteName())}
            </h1>

            <p class="t-primary" style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:25px;color:${BRAND.ink};">
              Hello ${owner},
            </p>
            <p class="t-muted" style="margin:0 0 24px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:25px;color:${BRAND.muted};">
              Your Admin Studio has been created successfully. Set a password to activate it and sign in for the first time.
            </p>

            <!-- Details. Confirms the address the account actually logs in
                 with, which is the detail people get wrong when an invite goes
                 to a shared or forwarded mailbox. -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="detail" style="background:${BRAND.paper};border-radius:10px;margin:0 0 28px;">
              <tr>
                <td style="padding:18px 20px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
                  ${[
                    ['Studio', studio],
                    ['Owner', owner],
                    ['Registered email', addr],
                  ].map(([k, v], i) => `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:${i ? '10px' : '0'} 0 0;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND.muted};">${k}</td>
                    </tr>
                    <tr>
                      <td class="t-primary" style="padding:2px 0 0;font-size:15px;font-weight:600;color:${BRAND.ink};word-break:break-word;">${v}</td>
                    </tr>
                  </table>`).join('')}
                </td>
              </tr>
            </table>

            <!-- CTA. VML fallback so Outlook renders a real rounded button
                 rather than a bare underlined link. -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cta">
              <tr>
                <td align="center" style="padding:0 0 22px;">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                    href="${url}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="20%" stroke="f" fillcolor="${BRAND.maroon}">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;">Set Your Password</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-- -->
                  <a href="${url}"
                     style="display:inline-block;background:${BRAND.maroon};background-image:linear-gradient(135deg,${BRAND.maroon} 0%,${BRAND.maroonDark} 100%);color:${BRAND.white};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:52px;text-decoration:none;padding:0 40px;border-radius:10px;letter-spacing:0.2px;">
                    Set Your Password
                  </a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>

            <p class="t-muted" style="margin:0 0 20px;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${BRAND.muted};">
              This link expires in <strong style="color:${BRAND.maroon};">${expiryHours} hours</strong> and can be used once.
            </p>

            <hr class="rule" style="border:none;border-top:1px solid ${BRAND.line};margin:0 0 18px;" />

            <!-- Some clients mangle long links; a copyable fallback means the
                 email still works when the button does not. -->
            <p class="t-muted" style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;color:${BRAND.muted};">
              If the button does not work, paste this into your browser:
            </p>
            <p style="margin:0 0 18px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;word-break:break-all;">
              <a href="${url}" style="color:${BRAND.maroon};text-decoration:underline;">${url}</a>
            </p>

            <p class="t-muted" style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:20px;color:${BRAND.muted};">
              If you didn&rsquo;t request this invitation, you can safely ignore this email — the link will expire on its own and no account will be activated.
            </p>

          </td>
        </tr>

        <tr>
          <td class="card pad" style="background:${BRAND.white};border:1px solid ${BRAND.line};border-top:none;border-radius:0 0 14px 14px;padding:22px 36px;text-align:center;">
            <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:2px;color:${BRAND.ink};text-transform:uppercase;" class="t-primary">
              ${siteName()}
            </div>
            ${supportEmail() ? `<div class="t-muted" style="margin-top:5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:${BRAND.muted};">
              <a href="mailto:${supportEmail()}" style="color:${BRAND.muted};text-decoration:none;">${supportEmail()}</a>
            </div>` : ''}
          </td>
        </tr>
      </table>

      ${pixelUrl ? `<img src="${esc(pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;opacity:0;" />` : ''}

    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Plain-text alternative. Not optional: a message with no text/plain part
 * scores worse with spam filters, and this is the one email that must not
 * land in junk.
 */
function invitationText({ ownerName, studioName, email, actionUrl, expiryHours }) {
  return [
    `WELCOME TO ${siteName().toUpperCase()}`,
    '',
    `Hello ${ownerName || 'there'},`,
    '',
    'Your Admin Studio has been created successfully. Set a password to activate it and sign in for the first time.',
    '',
    `Studio:           ${studioName || '-'}`,
    `Owner:            ${ownerName || '-'}`,
    `Registered email: ${email}`,
    '',
    'Set your password:',
    actionUrl,
    '',
    `This link expires in ${expiryHours} hours and can be used once.`,
    '',
    "If you didn't request this invitation, ignore this email — the link expires on its own and no account will be activated.",
    '',
    '--',
    siteName(),
    // Filtered out below when unset, rather than printed as an empty line.
    supportEmail(),
  ].filter((line) => line !== null).join('\n');
}

module.exports = { invitationHtml, invitationText, BRAND };

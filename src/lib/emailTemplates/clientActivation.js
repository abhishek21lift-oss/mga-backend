'use strict';
// The client activation email.
//
// Same construction as invitation.js, and for the same reasons documented at
// length there: table-based HTML with inline styles because that is what mail
// clients actually render; a near-black brand band that survives the
// force-inversion Outlook.com and Gmail-on-Android apply regardless of
// `prefers-color-scheme`; a VML fallback so the button is a button in Outlook;
// and a plain-text alternative, because a message with no text/plain part
// scores worse with spam filters and this is an email that must not land in
// junk.
//
// Two deliberate differences from the admin invitation:
//
//   • No tracking pixel. Open tracking on a studio owner's onboarding email is
//     an operations metric. On a client's it is surveillance of somebody who
//     never signed up for a platform account, so it is simply not here — and
//     with it goes the only remote asset, which is a deliverability win too.
//
//   • The address is not printed. The admin email shows the registered email
//     because invites to shared or forwarded mailboxes are a real failure
//     mode there. A client's email went to their own inbox; repeating it back
//     adds nothing and puts a personal address in a message that gets
//     forwarded and screenshotted.
//
// NO PASSWORD IS EVER IN THIS EMAIL. The link is the credential and it is
// single-use; the password is chosen by the client on the page it opens.

const { BRAND } = require('./invitation');
const { siteName, supportEmail } = require('../siteIdentity');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @param {object} p
 * @param {string} p.clientName  The client, as their trainer entered them.
 * @param {string} p.studioName  The studio training them.
 * @param {string} p.actionUrl   Create-password link carrying the raw token.
 * @param {number} p.expiryHours
 */
function clientActivationHtml({ clientName, studioName, actionUrl, expiryHours }) {
  const name = esc(String(clientName || '').trim().split(/\s+/)[0] || 'there');
  const studio = esc(studioName || 'your studio');
  const url = esc(actionUrl);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>Activate your ${studio} account</title>
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
  Create your password to see your workouts, diet and progress. This link expires in ${expiryHours} hours.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bodybg" style="background:${BRAND.paper};">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

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
              Your account is ready
            </h1>

            <p class="t-primary" style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:25px;color:${BRAND.ink};">
              Hello ${name},
            </p>
            <p class="t-muted" style="margin:0 0 24px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:25px;color:${BRAND.muted};">
              ${studio} has set up your personal account. Create a password to see your workouts, diet plan, measurements, attendance and payments — all in one place.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="detail" style="background:${BRAND.paper};border-radius:10px;margin:0 0 28px;">
              <tr>
                <td style="padding:18px 20px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
                  <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND.muted};">What you get</div>
                  <div class="t-primary" style="padding:8px 0 0;font-size:14.5px;line-height:23px;color:${BRAND.ink};">
                    Your workout plan &middot; Your diet plan &middot; Progress &amp; measurements &middot; Attendance &middot; Invoices &amp; payments
                  </div>
                </td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cta">
              <tr>
                <td align="center" style="padding:0 0 22px;">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                    href="${url}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="20%" stroke="f" fillcolor="${BRAND.maroon}">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;">Activate My Account</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-- -->
                  <a href="${url}"
                     style="display:inline-block;background:${BRAND.maroon};background-image:linear-gradient(135deg,${BRAND.maroon} 0%,${BRAND.maroonDark} 100%);color:${BRAND.white};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:52px;text-decoration:none;padding:0 40px;border-radius:10px;letter-spacing:0.2px;">
                    Activate My Account
                  </a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>

            <p class="t-muted" style="margin:0 0 20px;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${BRAND.muted};">
              This link expires in <strong style="color:${BRAND.maroon};">${expiryHours} hours</strong> and can be used once.
            </p>

            <hr class="rule" style="border:none;border-top:1px solid ${BRAND.line};margin:0 0 18px;" />

            <p class="t-muted" style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;color:${BRAND.muted};">
              If the button does not work, paste this into your browser:
            </p>
            <p style="margin:0 0 18px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;word-break:break-all;">
              <a href="${url}" style="color:${BRAND.maroon};text-decoration:underline;">${url}</a>
            </p>

            <p class="t-muted" style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:20px;color:${BRAND.muted};">
              We will never ask you for your password by email. If you were not expecting this, ignore it — the link expires on its own and no account is activated. Any questions, speak to your trainer at ${studio}.
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

    </td>
  </tr>
</table>
</body>
</html>`;
}

function clientActivationText({ clientName, studioName, actionUrl, expiryHours }) {
  const name = String(clientName || '').trim().split(/\s+/)[0] || 'there';
  const studio = studioName || 'your studio';
  return [
    `YOUR ${siteName().toUpperCase()} ACCOUNT IS READY`,
    '',
    `Hello ${name},`,
    '',
    `${studio} has set up your personal account. Create a password to see your`,
    'workouts, diet plan, measurements, attendance and payments.',
    '',
    'Activate your account:',
    actionUrl,
    '',
    `This link expires in ${expiryHours} hours and can be used once.`,
    '',
    'We will never ask you for your password by email. If you were not expecting',
    'this, ignore it — the link expires on its own and no account is activated.',
    '',
    '--',
    siteName(),
    // Filtered out below when unset, rather than printed as an empty line.
    supportEmail(),
  ].filter((line) => line !== null).join('\n');
}

module.exports = { clientActivationHtml, clientActivationText };

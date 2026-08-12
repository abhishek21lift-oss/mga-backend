// src/services/whatsappDelivery.js
// Actual delivery of a WhatsApp message via Twilio's Messaging API.
//
// Shared by the whatsapp worker (via whatsapp.service.js) and the
// notifications channel adapter — one copy of the Twilio transport so the two
// paths can never drift. This is a "delivery primitive": it never throws on
// a Twilio error response, it returns a result object exactly like the
// channel adapters in notifications.service.js.

const logger = require('../lib/logger');

function twilioWhatsappConfigured(env = process.env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
}

function normalizeTo(to) {
  return to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
}

/**
 * Send a free-form WhatsApp text message.
 * @param {object} opts { to, body?, template?, variables? }
 *   body wins over variables/template; a template with variables falls back
 *   to a human-readable text because no pre-approved template SID is wired up.
 */
async function sendText(opts) {
  const { to, body, template, variables } = opts || {};
  if (!to) return { status: 'failed', error: 'no recipient' };

  if (!twilioWhatsappConfigured()) {
    logger.warn(
      { to, template },
      'whatsapp not_configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM)'
    );
    return { status: 'not_configured', provider_id: null };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  try {
    const text = body || (variables ? variables.join(' — ') : template || '');
    const params = new URLSearchParams({
      From: from,
      To: normalizeTo(to),
      Body: text,
    });
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      logger.error({ status: res.status, data }, 'twilio whatsapp failed');
      return { status: 'failed', error: data.message || 'twilio error' };
    }
    return { status: 'sent', provider_id: data.sid };
  } catch (err) {
    logger.error({ err: err.message }, 'twilio whatsapp exception');
    return { status: 'failed', error: err.message };
  }
}

/**
 * Send via a pre-approved Twilio content template. The current integration
 * has no approved template SIDs, so this degrades to sendText with the
 * template name preserved in the payload for observability.
 */
async function sendTemplate(opts) {
  return sendText(opts);
}

module.exports = { sendText, sendTemplate, twilioWhatsappConfigured };

// src/modules/command-center/collectors/http.collector.js
//
// API performance, from the in-process ring in httpMetrics.js.
//
// Grades on p95, not the mean. A mean of 180ms can hide one endpoint taking
// four seconds for one studio in every twenty — and that studio is the one that
// files the ticket. p95 is also what the "slowest endpoints" list is ranked by,
// so the number that turns the card amber and the list explaining it agree.
//
// The 5xx rate is graded separately and harder than latency. Slow is a
// degradation; a 500 is a request that did not happen at all.
'use strict';

const { STATUS, result } = require('../registry');
const httpMetrics = require('../httpMetrics');

const NAME = 'http';

const P95_WARN_MS = Number(process.env.CC_HTTP_P95_WARN_MS) || 800;
const P95_CRIT_MS = Number(process.env.CC_HTTP_P95_CRIT_MS) || 2500;
const ERROR_RATE_WARN = 0.02;
const ERROR_RATE_CRIT = 0.10;
// Below this, percentiles are noise — three requests make a p95 meaningless.
const MIN_SAMPLES_TO_GRADE = 20;

// A rate needs a numerator, not just a ratio.
//
// This guard was applied to latency and not to the error rate, and the
// consequence was a console full of red. At a quiet hour the five-minute
// window holds about six requests, so ONE failing endpoint reads as 16.7% —
// over the 10% critical line — and pages. It then "clears itself" when the
// next window happens not to contain that request. Forty-nine of those in a
// day teaches an operator to ignore the card, which is worse than not having
// it.
//
// Deliberately an absolute floor on the ERROR COUNT rather than reusing
// MIN_SAMPLES_TO_GRADE. A sample gate would suppress the alert that matters
// most: six requests in the window and all six failing is a total outage at
// 3am, and "too few samples to grade" is exactly the wrong answer to it.
// A floor keeps that case red (6 >= 5) and drops 1-in-6 (1 < 5).
const MIN_ERRORS_WARN = 2;
const MIN_ERRORS_CRIT = 5;

async function collect() {
  const data = httpMetrics.summarise({ windowMs: 5 * 60 * 1000 });

  // No traffic is not a fault. A freshly restarted process, or a quiet night,
  // must not paint the console amber.
  if (!data.samples) {
    return result(NAME, { status: STATUS.HEALTHY, data, reason: null });
  }

  const p95 = data.latency_ms.p95;
  const serverErrors = data.status.server_errors;
  const serverErrorRate = serverErrors / data.samples;
  const thin = data.samples < MIN_SAMPLES_TO_GRADE;

  let status = STATUS.HEALTHY;
  let reason = null;

  if (serverErrors >= MIN_ERRORS_CRIT && serverErrorRate >= ERROR_RATE_CRIT) {
    status = STATUS.CRITICAL;
    reason = `${serverErrors} server errors in ${data.samples} requests`;
  } else if (!thin && p95 >= P95_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `API p95 ${p95}ms${data.slowest_endpoints[0] ? ` — slowest: ${data.slowest_endpoints[0].endpoint}` : ''}`;
  } else if (serverErrors >= MIN_ERRORS_WARN && serverErrorRate >= ERROR_RATE_WARN) {
    status = STATUS.WARNING;
    reason = `${serverErrors} server error(s) in ${data.samples} requests`;
  } else if (!thin && p95 >= P95_WARN_MS) {
    status = STATUS.WARNING;
    reason = `API p95 ${p95}ms${data.slowest_endpoints[0] ? ` — slowest: ${data.slowest_endpoints[0].endpoint}` : ''}`;
  }

  // Say when a percentile is not worth trusting rather than hiding the sample
  // size and letting someone act on a p95 drawn from four requests.
  const notes = [];
  if (thin) notes.push(`Only ${data.samples} requests in window — latency not graded below ${MIN_SAMPLES_TO_GRADE}`);
  // Errors under the floor are not an alert, but they are not nothing either.
  // Saying so is what keeps "we stopped alerting on it" from becoming "we
  // stopped showing it" — the count is right there for anyone looking.
  if (serverErrors > 0 && status !== STATUS.CRITICAL) {
    notes.push(`${serverErrors} server error(s) in ${data.samples} requests`);
  }
  if (notes.length) data.note = notes.join(' · ');

  return result(NAME, { status, data, reason });
}

module.exports = {
  NAME, collect, P95_WARN_MS, P95_CRIT_MS,
  ERROR_RATE_WARN, ERROR_RATE_CRIT, MIN_SAMPLES_TO_GRADE,
  MIN_ERRORS_WARN, MIN_ERRORS_CRIT,
};

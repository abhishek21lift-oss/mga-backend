'use strict';
// Lightweight natural-language date-range parsing for AI Coach tool calls
// ("this week", "last 30 days", etc.). Deliberately simple — this is not a
// general NLU date parser, just enough patterns to cover how people actually
// phrase these questions in chat. Defaults to the last 30 days, matching the
// same default already used by POST /api/ai/business/insights.

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function parseDateRange(text) {
  const now = new Date();
  const t = (text || '').toLowerCase();

  if (/\btoday\b/.test(t)) return { from: startOfDay(now), to: now, label: 'today' };
  if (/\bthis week\b/.test(t)) return { from: startOfWeek(now), to: now, label: 'this week' };
  if (/\bthis month\b/.test(t)) return { from: startOfMonth(now), to: now, label: 'this month' };
  if (/\blast month\b/.test(t)) {
    const firstOfThisMonth = startOfMonth(now);
    const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 1);
    const lastMonthStart = startOfMonth(lastMonthEnd);
    return { from: lastMonthStart, to: lastMonthEnd, label: 'last month' };
  }

  const daysMatch = t.match(/last (\d+)\s*days?/);
  if (daysMatch) {
    const n = Math.min(parseInt(daysMatch[1], 10) || 30, 365);
    return { from: new Date(now.getTime() - n * 86400000), to: now, label: `last ${n} days` };
  }

  return { from: new Date(now.getTime() - 30 * 86400000), to: now, label: 'last 30 days' };
}

module.exports = { parseDateRange };

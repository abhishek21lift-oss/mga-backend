const express = require('express');
const { auth, adminOnly } = require('../middleware/auth');
const { enqueueEmail } = require('../services/emailQueue.service');

const router = express.Router();

router.post('/email-queue', auth, adminOnly, async function(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const job = await enqueueEmail({
      source: 'debug',
      createdBy: req.user?.id || null,
      createdAt: new Date().toISOString(),
    });

    return res.json({ success: true, jobId: job.id });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

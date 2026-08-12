-- ============================================================
-- 110_repair_enrolled_clients_stuck_pending.sql
--
-- DATA REPAIR: clients who were fully enrolled in a PT package but
-- left showing "Not Enrolled" on the clients list.
--
-- Cause: the PT enrollment page (pt-os/clients/[id]/enroll) saves
-- via PATCH /clients/:id, which — unlike POST /clients — only ever
-- touched `status` when the caller explicitly sent it. The enroll
-- page never sent it, so every client completed through that page
-- stayed on status='pending' regardless of a full payment and a
-- complete schedule. Both sides are fixed in code (the page now
-- sends status, and PATCH now auto-promotes the same way POST
-- always did); this repairs the rows already written under the bug.
--
-- Second-order effect this also corrects: only 'active' consumes a
-- plan seat (SEAT_CONSUMING_STATUSES in lib/subscription.js), so
-- these clients were not counting against their studio's plan
-- limit either — a studio could exceed its paid quota unnoticed.
--
-- SCOPE — deliberately narrow. "Enrolled" is the SAME condition the
-- application uses (POST /clients, and now PATCH /clients/:id):
-- an end date, a real duration, or a real charged amount. Clients
-- added to the roster but never enrolled (no package, ₹0, no dates)
-- are LEGITIMATELY 'pending' and must stay that way — promoting
-- them would inflate active-client counts and wrongly consume plan
-- seats. At time of writing that distinction is real, not
-- theoretical: of 6 pending clients across the 3 live studios, 4
-- are correctly pending (roster-only) and only 2 are broken.
--
-- Idempotent: re-running matches nothing once repaired, so this is
-- safe on every environment and on repeat deploys.
-- ============================================================

UPDATE pt_clients
   SET status     = 'active',
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND status = 'pending'
   AND (
         pt_end_date IS NOT NULL
      OR COALESCE(final_amount, 0) > 0
      OR COALESCE(duration_months, 0) > 0
   );

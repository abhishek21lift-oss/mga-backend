const { z } = require('zod');

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);
const emailSchema = z.string().email('Invalid email').max(255).transform(function(v) { return v.toLowerCase().trim(); });
const emailOptional = emailSchema.optional().nullable().or(z.literal('').transform(function() { return undefined; }));

const authSchemas = {
  login: {
    body: z.object({
      email: emailSchema,
      password: z.string().min(1, 'Password is required'),
      // Optional TOTP code — required at login for platform super admins who
      // have 2FA enabled (enforced in the login handler, not here).
      mfa_code: z.string().trim().regex(/^\d{6}$/, 'MFA code must be 6 digits').optional(),
      // Which door the person came through: the staff sign-in or the member
      // one. Enforced in the login handler, AFTER the password check — see
      // routes/auth.js for why the order matters.
      //
      // Optional and defaulting to 'staff' so existing callers (the mobile
      // app on /api/v1/auth/login, any saved bookmark) keep working exactly
      // as before. A member has never been able to sign in through those, so
      // defaulting this way changes nothing for anyone who works today.
      portal: z.enum(['staff', 'member']).optional(),
    }),
  },
  changePassword: {
    body: z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: passwordSchema,
    }),
  },
  createUser: {
    body: z.object({
      name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
      email: emailSchema,
      password: passwordSchema,
      role: z.enum(['admin', 'manager', 'trainer', 'reception', 'member']).default('trainer'),
      trainer_id: z.string().optional().nullable(),
      member_id: z.string().optional().nullable(),
    }),
  },
};

const mobileSchema = z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable();

const clientSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
      mobile: mobileSchema,
      email: emailOptional,
      gender: z.string().max(20).optional().nullable(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      trainer_id: z.string().optional().nullable(),
      package_type: z.string().optional().nullable(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      paid_amount: z.number().optional().nullable(),
      joining_date: z.string().optional().nullable(),
      pt_start_date: z.string().optional().nullable(),
      pt_end_date: z.string().optional().nullable(),
      payment_method: z.string().optional().nullable(),
      payment_date: z.string().optional().nullable(),
      weight: z.number().optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
      status: z.string().optional().nullable(),
      photo_url: z.string().optional().nullable(),
      biometric_code: z.string().optional().nullable(),
      plan_id: z.string().optional().nullable(),
    }),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      mobile: mobileSchema,
      email: emailOptional,
      gender: z.string().max(20).optional().nullable(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      trainer_id: z.string().optional().nullable(),
      package_type: z.string().optional().nullable(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      paid_amount: z.number().optional().nullable(),
      status: z.string().optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
      is_active: z.boolean().optional(),
    }),
  },
};

const paymentSchemas = {
  create: {
    body: z.object({
      client_id: z.string().min(1, 'client_id is required'),
      amount: z.number().positive('Amount must be positive'),
      method: z.string().max(50).optional(),
      date: z.string().optional(),
      payment_mode: z.string().max(50).optional(),
      notes: z.string().max(500).optional().nullable(),
      plan_id: z.string().optional().nullable(),
      trainer_id: z.string().optional().nullable(),
    }),
  },
};

const planSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      kind: z.string().optional(),
      description: z.string().optional().nullable(),
      duration: z.string().optional(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      joining_fee: z.number().optional().nullable(),
      tax_pct: z.number().optional().nullable(),
      sessions_per_week: z.number().optional().nullable(),
      features: z.string().optional().nullable(),
      popular: z.boolean().optional(),
      color: z.string().optional(),
      is_active: z.boolean().optional(),
      status: z.string().optional(),
    }),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      kind: z.string().optional(),
      description: z.string().optional().nullable(),
      duration: z.string().optional(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      joining_fee: z.number().optional().nullable(),
      tax_pct: z.number().optional().nullable(),
      sessions_per_week: z.number().optional().nullable(),
      features: z.string().optional().nullable(),
      popular: z.boolean().optional(),
      color: z.string().optional(),
      is_active: z.boolean().optional(),
      status: z.string().optional(),
    }),
  },
};

const trainerBaseFields = {
  name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
  mobile: mobileSchema,
  email: emailOptional,
  dob: z.string().optional().nullable(),
  // Accept 'Male'|'Female'|'Other' or empty/null
  gender: z.enum(['Male', 'Female', 'Other']).optional().nullable()
    .or(z.literal('').transform(function() { return null; })),
  address: z.string().max(500).optional().nullable(),
  role: z.string().optional(),
  joining_date: z.string().optional().nullable(),
  // salary is a plain number (rupees) — not divided by 100
  salary: z.number().nonnegative().optional().nullable(),
  // incentive_rate is sent as a percentage (e.g. 50 for 50%);
  // the route divides by 100 before storing as a decimal in the DB.
  incentive_rate: z.number().min(0).max(100).optional().nullable(),
  specialization: z.string().max(500).optional().nullable(),
  // certifications stored as a comma-separated TEXT (not TEXT[])
  certifications: z.string().max(1000).optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  notes: z.string().max(2000).optional().nullable(),
  bio: z.string().max(2000).optional().nullable(),
  // schedule stores working days as comma-separated TEXT (e.g. "Mon, Tue, Wed")
  schedule: z.string().max(200).optional().nullable(),
  biometric_code: z.string().optional().nullable(),
  // metadata holds extended fields that have no dedicated DB column
  metadata: z.record(z.unknown()).optional().default({}),
};

const trainerSchemas = {
  create: {
    body: z.object(trainerBaseFields),
  },
  update: {
    body: z.object({
      // name is optional on update
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      mobile: mobileSchema,
      email: emailOptional,
      dob: z.string().optional().nullable(),
      gender: z.enum(['Male', 'Female', 'Other']).optional().nullable()
        .or(z.literal('').transform(function() { return null; })),
      address: z.string().max(500).optional().nullable(),
      role: z.string().optional(),
      joining_date: z.string().optional().nullable(),
      salary: z.number().nonnegative().optional().nullable(),
      incentive_rate: z.number().min(0).max(100).optional().nullable(),
      specialization: z.string().max(500).optional().nullable(),
      certifications: z.string().max(1000).optional().nullable(),
      status: z.enum(['active', 'inactive']).optional(),
      notes: z.string().max(2000).optional().nullable(),
      bio: z.string().max(2000).optional().nullable(),
      schedule: z.string().max(200).optional().nullable(),
      biometric_code: z.string().optional().nullable(),
      metadata: z.record(z.unknown()).optional(),
    }),
  },
};

// Gym members (Phase 2). Deliberately NOT clientSchemas with fields removed:
// a member is a person who belongs to the gym, and every PT-shaped field above
// — trainer_id, package_type, base_amount, sessions_per_week — is exactly what
// must not be required of one. See docs/GMS_TARGET_ARCHITECTURE.md §1.
//
// dob is a real date here rather than the free string clientSchemas accepts,
// because members.dob is a DATE column from birth. pt_clients only takes a
// string because it predates 033_schema_fixes.sql converting its own column.
const memberStatuses = ['prospect', 'active', 'inactive', 'expired', 'cancelled'];
const memberSources  = ['walk-in', 'lead', 'import', 'pt', 'portal', 'other'];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional().nullable()
  .or(z.literal('').transform(function() { return undefined; }));

const memberSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
      mobile: mobileSchema,
      email: emailOptional,
      dob: isoDate,
      gender: z.string().max(20).optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      photo_url: z.string().max(1000).optional().nullable(),
      emergency_contact: z.string().max(255).optional().nullable(),
      emergency_phone: z.string().max(20).optional().nullable(),
      status: z.enum(memberStatuses).optional(),
      joined_on: isoDate,
      source: z.enum(memberSources).optional(),
      notes: z.string().max(5000).optional().nullable(),
      // member_code is deliberately absent: it is allocated server-side per
      // organization. Letting a caller choose it reintroduces the collision the
      // generator exists to prevent.
    }),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      mobile: mobileSchema,
      email: emailOptional,
      dob: isoDate,
      gender: z.string().max(20).optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      photo_url: z.string().max(1000).optional().nullable(),
      emergency_contact: z.string().max(255).optional().nullable(),
      emergency_phone: z.string().max(20).optional().nullable(),
      status: z.enum(memberStatuses).optional(),
      joined_on: isoDate,
      notes: z.string().max(5000).optional().nullable(),
    }),
  },
};

// Memberships (Phase 3). A period of gym access, priced by duration —
// deliberately not planSchemas, whose `sessions_per_week` and PT/Membership
// `kind` belong to the pre-multi-tenant catalogue this replaces.
const money = z.number().nonnegative().optional();

const membershipPlanSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1, 'Plan name is required').max(255).transform(function(v) { return v.trim(); }),
      description: z.string().max(2000).optional().nullable(),
      duration_days: z.number().int().positive('Duration must be at least one day'),
      price: money,
      joining_fee: money,
      tax_pct: money,
      is_active: z.boolean().optional(),
      sort_order: z.number().int().optional(),
    }),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      description: z.string().max(2000).optional().nullable(),
      duration_days: z.number().int().positive().optional(),
      price: money,
      joining_fee: money,
      tax_pct: money,
      is_active: z.boolean().optional(),
      sort_order: z.number().int().optional(),
    }),
  },
};

const membershipSchemas = {
  create: {
    body: z.object({
      member_id: z.string().min(1),
      plan_id: z.string().min(1),
      starts_on: isoDate,
      // Accepted so a studio can sell an odd-length term, but normally derived
      // from the plan's duration_days.
      ends_on: isoDate,
      discount: money,
      amount_paid: money,
      // A joining fee is charged once. Renewals never include it; this lets the
      // front desk waive it on a first sale too.
      include_joining_fee: z.boolean().optional(),
      status: z.enum(['pending', 'active']).optional(),
      notes: z.string().max(2000).optional().nullable(),
    }),
  },
  renew: {
    body: z.object({
      // Omitted renews onto the same plan.
      plan_id: z.string().min(1).optional(),
      starts_on: isoDate,
      discount: money,
      amount_paid: money,
      notes: z.string().max(2000).optional().nullable(),
    }),
  },
  freeze: {
    body: z.object({
      from_date: isoDate,
      reason: z.string().max(500).optional().nullable(),
    }),
  },
  resume: {
    body: z.object({
      to_date: isoDate,
    }),
  },
  changePlan: {
    body: z.object({
      plan_id: z.string().min(1),
      discount: money,
      note: z.string().max(500).optional().nullable(),
    }),
  },
  cancel: {
    body: z.object({
      reason: z.string().max(500).optional().nullable(),
    }),
  },
};

module.exports = {
  authSchemas,
  clientSchemas,
  memberSchemas,
  membershipPlanSchemas,
  membershipSchemas,
  paymentSchemas,
  planSchemas,
  trainerSchemas,
  z,
};

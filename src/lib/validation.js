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

module.exports = {
  authSchemas,
  clientSchemas,
  paymentSchemas,
  planSchemas,
  trainerSchemas,
  z,
};

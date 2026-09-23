-- Backs the 24-hours-before appointment reminder (src/appointmentReminder.ts).
-- appointment_at is when the booked appointment is scheduled for;
-- appointment_reminder_sent_at records that the reminder already went out,
-- so a later worker run never sends it twice.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_reminder_sent_at TIMESTAMPTZ;

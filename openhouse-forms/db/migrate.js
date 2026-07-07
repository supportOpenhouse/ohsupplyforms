require('dotenv').config();
const pool = require('./pool');

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS master_societies (
  id SERIAL PRIMARY KEY,
  city TEXT NOT NULL, locality TEXT NOT NULL, society_name TEXT NOT NULL,
  UNIQUE(city, locality, society_name)
);
CREATE INDEX IF NOT EXISTS idx_ms_city ON master_societies(city);

CREATE TABLE IF NOT EXISTS master_areas (
  id SERIAL PRIMARY KEY,
  society_name TEXT NOT NULL,
  area_sqft REAL NOT NULL,
  UNIQUE(society_name, area_sqft)
);
CREATE INDEX IF NOT EXISTS idx_ma_soc ON master_areas(society_name);

CREATE TABLE IF NOT EXISTS properties (
  uid TEXT PRIMARY KEY,

  -- Form 1: Visit Schedule
  schedule_date DATE, schedule_time TEXT, lead_id TEXT, field_exec TEXT,
  source TEXT, demand_price REAL, first_name TEXT, last_name TEXT, owner_broker_name TEXT, contact_no TEXT,
  city TEXT, locality TEXT, society_name TEXT, unit_no TEXT, tower_no TEXT,
  floor TEXT, configuration TEXT, area_sqft REAL,
  assigned_by TEXT,
  schedule_submitted_at TIMESTAMPTZ,

  -- Form 2: Visit (Audit)
  extra_area JSONB DEFAULT '[]', bathrooms INTEGER, balconies INTEGER,
  gas_pipeline TEXT, possession_status TEXT, tentative_handover_date DATE,
  club_facility TEXT, parking TEXT, parking_image TEXT, sunlight INTEGER,
  furnishing TEXT, furnishing_details JSONB DEFAULT '[]',
  total_lifts INTEGER, total_floors_tower INTEGER, total_flats_floor INTEGER,
  exit_facing TEXT, exit_compass_image TEXT,
  balcony_details JSONB DEFAULT '[]',
  video_link TEXT, additional_images JSONB DEFAULT '[]',
  visit_submitted_at TIMESTAMPTZ,

  -- Form 3: Token Request
  token_requested_by TEXT,
  cheque_image_url TEXT, cheque_bank_name TEXT, cheque_account_number TEXT, cheque_ifsc TEXT,
  co_owner TEXT, registry_status TEXT, occupancy_status TEXT, key_handover_date DATE,
  guaranteed_sale_price REAL, performance_guarantee REAL,
  initial_period INTEGER, rent_payable_initial_period TEXT,
  grace_period INTEGER, rent_payable_grace_period TEXT,
  outstanding_loan REAL, bank_name_loan TEXT, loan_account_number TEXT, loan_pay_willingness TEXT,
  inclusions TEXT, papers_available TEXT, documents_available JSONB DEFAULT '[]',
  token_remarks TEXT, token_is_draft BOOLEAN DEFAULT FALSE,
  token_submitted_at TIMESTAMPTZ,

  -- Form 4: Deal Terms (for Owner)
  deal_token_amount REAL,
  deal_bank_name TEXT, deal_bank_account_number TEXT, deal_ifsc_code TEXT,
  deal_transfer_date DATE, deal_neft_reference TEXT,
  token_deal_submitted_at TIMESTAMPTZ,

  -- Form 5: Final
  remaining_amount REAL,
  final_submitted_at TIMESTAMPTZ,

  -- Form 6: Listing
  listing_asking_price REAL,
  society_age_years REAL, total_units INTEGER,
  maintenance_charges REAL, society_move_in_charges REAL,
  electricity_charges REAL, water_supply TEXT, dg_charges REAL,
  alpha_beta TEXT, beta_pct REAL, loan_status TEXT, seller_location TEXT,
  current_occupancy_pct REAL, circle_rate REAL, parking_number TEXT,
  listing_submitted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prop_city ON properties(city);
CREATE INDEX IF NOT EXISTS idx_prop_created ON properties(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_lead_id ON properties(lead_id);

CREATE TABLE IF NOT EXISTS cp_master (
  id SERIAL PRIMARY KEY,
  cp_code TEXT UNIQUE NOT NULL,
  cp_name TEXT NOT NULL,
  cp_phone TEXT,
  cp_firm TEXT,
  cp_email TEXT,
  cp_aadhaar_front_url TEXT,
  cp_aadhaar_back_url TEXT,
  cp_pan_card_url TEXT,
  cp_cancelled_cheque_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cpm_code ON cp_master(cp_code);
CREATE INDEX IF NOT EXISTS idx_cpm_phone ON cp_master(cp_phone);
`;

const COMPAT_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='assigned_by') THEN ALTER TABLE properties ADD COLUMN assigned_by TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_requested_by') THEN ALTER TABLE properties ADD COLUMN token_requested_by TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_bank_name') THEN ALTER TABLE properties ADD COLUMN deal_bank_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_bank_account_number') THEN ALTER TABLE properties ADD COLUMN deal_bank_account_number TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_ifsc_code') THEN ALTER TABLE properties ADD COLUMN deal_ifsc_code TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_transfer_date') THEN ALTER TABLE properties ADD COLUMN deal_transfer_date DATE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_neft_reference') THEN ALTER TABLE properties ADD COLUMN deal_neft_reference TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='society_age_years') THEN ALTER TABLE properties ADD COLUMN society_age_years REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='total_units') THEN ALTER TABLE properties ADD COLUMN total_units INTEGER; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='maintenance_charges') THEN ALTER TABLE properties ADD COLUMN maintenance_charges REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='society_move_in_charges') THEN ALTER TABLE properties ADD COLUMN society_move_in_charges REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='electricity_charges') THEN ALTER TABLE properties ADD COLUMN electricity_charges REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='water_supply') THEN ALTER TABLE properties ADD COLUMN water_supply TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='dg_charges') THEN ALTER TABLE properties ADD COLUMN dg_charges REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='alpha_beta') THEN ALTER TABLE properties ADD COLUMN alpha_beta TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='beta_pct') THEN ALTER TABLE properties ADD COLUMN beta_pct REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='loan_status') THEN ALTER TABLE properties ADD COLUMN loan_status TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='seller_location') THEN ALTER TABLE properties ADD COLUMN seller_location TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='current_occupancy_pct') THEN ALTER TABLE properties ADD COLUMN current_occupancy_pct REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='circle_rate') THEN ALTER TABLE properties ADD COLUMN circle_rate REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='parking_number') THEN ALTER TABLE properties ADD COLUMN parking_number TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='tower_no') THEN ALTER TABLE properties ADD COLUMN tower_no TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='first_name') THEN ALTER TABLE properties ADD COLUMN first_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='last_name') THEN ALTER TABLE properties ADD COLUMN last_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='exit_compass_image') THEN ALTER TABLE properties ADD COLUMN exit_compass_image TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cheque_bank_name') THEN ALTER TABLE properties ADD COLUMN cheque_bank_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cheque_account_number') THEN ALTER TABLE properties ADD COLUMN cheque_account_number TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cheque_ifsc') THEN ALTER TABLE properties ADD COLUMN cheque_ifsc TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='key_handover_date') THEN ALTER TABLE properties ADD COLUMN key_handover_date DATE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_token_amount') THEN ALTER TABLE properties ADD COLUMN deal_token_amount REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='remaining_amount') THEN ALTER TABLE properties ADD COLUMN remaining_amount REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='schedule_submitted_at') THEN ALTER TABLE properties ADD COLUMN schedule_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_deal_submitted_at') THEN ALTER TABLE properties ADD COLUMN token_deal_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_is_draft') THEN ALTER TABLE properties ADD COLUMN token_is_draft BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='final_submitted_at') THEN ALTER TABLE properties ADD COLUMN final_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='balcony_details') THEN ALTER TABLE properties ADD COLUMN balcony_details JSONB DEFAULT '[]'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_broker_name') THEN ALTER TABLE properties ADD COLUMN owner_broker_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='listing_asking_price') THEN ALTER TABLE properties ADD COLUMN listing_asking_price REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='listing_submitted_at') THEN ALTER TABLE properties ADD COLUMN listing_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='google_access_token') THEN ALTER TABLE users ADD COLUMN google_access_token TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='google_refresh_token') THEN ALTER TABLE users ADD COLUMN google_refresh_token TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='is_dead') THEN ALTER TABLE properties ADD COLUMN is_dead BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='visit_remarks') THEN ALTER TABLE properties ADD COLUMN visit_remarks TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='has_loan') THEN ALTER TABLE properties ADD COLUMN has_loan TEXT DEFAULT 'No'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_remarks_printed') THEN ALTER TABLE properties ADD COLUMN token_remarks_printed TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_email') THEN ALTER TABLE properties ADD COLUMN owner_email TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_email') THEN ALTER TABLE properties ADD COLUMN co_owner_email TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_number') THEN ALTER TABLE properties ADD COLUMN co_owner_number TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_name') THEN ALTER TABLE properties ADD COLUMN cp_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_phone') THEN ALTER TABLE properties ADD COLUMN cp_phone TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_firm') THEN ALTER TABLE properties ADD COLUMN cp_firm TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_email') THEN ALTER TABLE properties ADD COLUMN cp_email TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_type') THEN ALTER TABLE properties ADD COLUMN deal_type TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='oh_acquired_model') THEN ALTER TABLE properties ADD COLUMN oh_acquired_model TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='agreed_brokerage') THEN ALTER TABLE properties ADD COLUMN agreed_brokerage TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='deal_value') THEN ALTER TABLE properties ADD COLUMN deal_value TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='total_brokerage_amount') THEN ALTER TABLE properties ADD COLUMN total_brokerage_amount TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='to_be_released_now') THEN ALTER TABLE properties ADD COLUMN to_be_released_now TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_cancelled_cheque_url') THEN ALTER TABLE properties ADD COLUMN cp_cancelled_cheque_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_pan_card_url') THEN ALTER TABLE properties ADD COLUMN cp_pan_card_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_aadhaar_front_url') THEN ALTER TABLE properties ADD COLUMN cp_aadhaar_front_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_aadhaar_back_url') THEN ALTER TABLE properties ADD COLUMN cp_aadhaar_back_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_ama_signed_url') THEN ALTER TABLE properties ADD COLUMN cp_ama_signed_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='loan_applicant_name') THEN ALTER TABLE properties ADD COLUMN loan_applicant_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='loan_co_applicant_name') THEN ALTER TABLE properties ADD COLUMN loan_co_applicant_name TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_bill_submitted_at') THEN ALTER TABLE properties ADD COLUMN cp_bill_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_manager') THEN ALTER TABLE users ADD COLUMN is_manager BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='managed_team') THEN ALTER TABLE users ADD COLUMN managed_team JSONB DEFAULT '[]'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN ALTER TABLE users ADD COLUMN phone TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='can_assign') THEN ALTER TABLE users ADD COLUMN can_assign BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='can_visit') THEN ALTER TABLE users ADD COLUMN can_visit BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_top_manager') THEN ALTER TABLE users ADD COLUMN is_top_manager BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='seller_residential_status') THEN ALTER TABLE properties ADD COLUMN seller_residential_status TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='sellers_available_on_registry') THEN ALTER TABLE properties ADD COLUMN sellers_available_on_registry TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='pending_request_submitted_at') THEN ALTER TABLE properties ADD COLUMN pending_request_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='signed_ama_url') THEN ALTER TABLE properties ADD COLUMN signed_ama_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_aadhaar_front_url') THEN ALTER TABLE properties ADD COLUMN co_owner_aadhaar_front_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_aadhaar_back_url') THEN ALTER TABLE properties ADD COLUMN co_owner_aadhaar_back_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_pan_url') THEN ALTER TABLE properties ADD COLUMN co_owner_pan_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='co_owner_cheque_url') THEN ALTER TABLE properties ADD COLUMN co_owner_cheque_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='email_thread_id') THEN ALTER TABLE properties ADD COLUMN email_thread_id TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='email_message_id') THEN ALTER TABLE properties ADD COLUMN email_message_id TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='is_token_refunded') THEN ALTER TABLE properties ADD COLUMN is_token_refunded BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='gst_applicable') THEN ALTER TABLE properties ADD COLUMN gst_applicable TEXT DEFAULT 'No'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_gst_invoice_url') THEN ALTER TABLE properties ADD COLUMN cp_gst_invoice_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_coi_url') THEN ALTER TABLE properties ADD COLUMN cp_coi_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='docs_verification_mode') THEN ALTER TABLE properties ADD COLUMN docs_verification_mode TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_bill_remarks') THEN ALTER TABLE properties ADD COLUMN cp_bill_remarks TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='third_owner_email') THEN ALTER TABLE properties ADD COLUMN third_owner_email TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='broker_email') THEN ALTER TABLE properties ADD COLUMN broker_email TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_sanction_url') THEN ALTER TABLE properties ADD COLUMN ama_sanction_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_soa_url') THEN ALTER TABLE properties ADD COLUMN ama_soa_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_lod_url') THEN ALTER TABLE properties ADD COLUMN ama_lod_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_pg_non_forfeitable') THEN ALTER TABLE properties ADD COLUMN ama_pg_non_forfeitable TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_beta_max_pct') THEN ALTER TABLE properties ADD COLUMN ama_beta_max_pct REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_beta_min_pct') THEN ALTER TABLE properties ADD COLUMN ama_beta_min_pct REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_payment_structure') THEN ALTER TABLE properties ADD COLUMN ama_payment_structure TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_maint_alignment') THEN ALTER TABLE properties ADD COLUMN ama_maint_alignment TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_elec_alignment') THEN ALTER TABLE properties ADD COLUMN ama_elec_alignment TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_special_terms') THEN ALTER TABLE properties ADD COLUMN ama_special_terms TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_prop_docs') THEN ALTER TABLE properties ADD COLUMN ama_prop_docs JSONB DEFAULT '{}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_submitted_at') THEN ALTER TABLE properties ADD COLUMN ama_submitted_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='super_area') THEN ALTER TABLE properties ADD COLUMN super_area REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='carpet_area') THEN ALTER TABLE properties ADD COLUMN carpet_area REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='incentive_visit') THEN ALTER TABLE properties ADD COLUMN incentive_visit TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='incentive_owner_meeting') THEN ALTER TABLE properties ADD COLUMN incentive_owner_meeting TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='total_cp_amount') THEN ALTER TABLE properties ADD COLUMN total_cp_amount TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='ama_date') THEN ALTER TABLE properties ADD COLUMN ama_date DATE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_pan_url') THEN ALTER TABLE properties ADD COLUMN owner_pan_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_aadhaar_front_url') THEN ALTER TABLE properties ADD COLUMN owner_aadhaar_front_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_aadhaar_back_url') THEN ALTER TABLE properties ADD COLUMN owner_aadhaar_back_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_property_doc_url') THEN ALTER TABLE properties ADD COLUMN owner_property_doc_url TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_code') THEN ALTER TABLE properties ADD COLUMN cp_code TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='total_deposit') THEN ALTER TABLE properties ADD COLUMN total_deposit REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='refundable_deposit') THEN ALTER TABLE properties ADD COLUMN refundable_deposit REAL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='core_home_id') THEN ALTER TABLE properties ADD COLUMN core_home_id INTEGER; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_super') THEN ALTER TABLE users ADD COLUMN is_super BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_request_email_sent') THEN ALTER TABLE properties ADD COLUMN token_request_email_sent BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='token_deal_email_sent') THEN ALTER TABLE properties ADD COLUMN token_deal_email_sent BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='pending_request_email_sent') THEN ALTER TABLE properties ADD COLUMN pending_request_email_sent BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='cp_bill_email_sent') THEN ALTER TABLE properties ADD COLUMN cp_bill_email_sent BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='final_email_sent') THEN ALTER TABLE properties ADD COLUMN final_email_sent BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='owner_will_vacate') THEN ALTER TABLE properties ADD COLUMN owner_will_vacate TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='gcal_event_id') THEN ALTER TABLE properties ADD COLUMN gcal_event_id TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='gcal_creator_id') THEN ALTER TABLE properties ADD COLUMN gcal_creator_id INTEGER; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='visit_date_history') THEN ALTER TABLE properties ADD COLUMN visit_date_history JSONB; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='replicated') THEN ALTER TABLE properties ADD COLUMN replicated BOOLEAN DEFAULT FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='replicated_from') THEN ALTER TABLE properties ADD COLUMN replicated_from TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='parking_image') THEN ALTER TABLE properties ADD COLUMN parking_image TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='brokerage_ama_signed') THEN ALTER TABLE properties ADD COLUMN brokerage_ama_signed TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='brokerage_ama_signed_amount') THEN ALTER TABLE properties ADD COLUMN brokerage_ama_signed_amount TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='brokerage_registry') THEN ALTER TABLE properties ADD COLUMN brokerage_registry TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='brokerage_registry_amount') THEN ALTER TABLE properties ADD COLUMN brokerage_registry_amount TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='additional_brokerage') THEN ALTER TABLE properties ADD COLUMN additional_brokerage TEXT; END IF;
  -- floor holds text values ("Ground"/"Top") alongside numbers; convert legacy integer column.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='floor' AND data_type='integer') THEN ALTER TABLE properties ALTER COLUMN floor TYPE TEXT USING floor::TEXT; END IF;
END $$;
-- One-time bootstrap: grant super-user to the original hardcoded emails if no super exists yet
UPDATE users SET is_super=TRUE
  WHERE LOWER(email) IN ('sahaj.dureja@openhouse.in','saransh.khera@openhouse.in')
    AND NOT EXISTS (SELECT 1 FROM users WHERE is_super=TRUE);
`;

const LOGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  uid TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  actor_email TEXT,
  actor_name TEXT,
  dashboard TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')
);
CREATE INDEX IF NOT EXISTS idx_logs_uid ON activity_logs(uid);
CREATE INDEX IF NOT EXISTS idx_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_logs_actor ON activity_logs(actor_email);
CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_dashboard ON activity_logs(dashboard);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='activity_logs' AND column_name='dashboard')
  THEN ALTER TABLE activity_logs ADD COLUMN dashboard TEXT; END IF;
END $$;
`;

module.exports = { MIGRATION_SQL, COMPAT_SQL, LOGS_TABLE_SQL };

// One-time seed: populate phone, can_assign, can_visit, is_top_manager from old hardcoded data
// Run via: node db/migrate.js seed
const SEED_USER_ROLES = {
  'rahool@openhouse.in':             { phone:'9899546824', is_top_manager:true },
  'ashish@openhouse.in':             { phone:'9555666059', is_top_manager:true },
  'prashant@openhouse.in':           { phone:'9289500953', is_top_manager:true },
  'abhishek.rathore@openhouse.in':   { phone:'9452441498', can_assign:true },
  'aman.dixit@openhouse.in':         { phone:'9266533475', can_assign:true, can_visit:true },
  'animesh.singh@openhouse.in':      { phone:'9810826481', can_assign:true, can_visit:true },
  'arti.ahirwar@openhouse.in':       { phone:'9289500948', can_assign:true },
  'deepak.mishra@openhouse.in':       { phone:'8130724002', can_assign:true, can_visit:true },
  'deepak.rana@openhouse.in':         { phone:'7428500192', can_assign:true, can_visit:true },
  'kavita.rawat@openhouse.in':       { phone:'9311338216', can_assign:true },
  'nisha.deewan@openhouse.in':       { phone:'9211599292', can_assign:true },
  'rahul.sheel@openhouse.in':        { phone:'9289311664', can_assign:true, can_visit:true },
  'rupali.prasad@openhouse.in':      { phone:'9289996738', can_assign:true },
  'sahil.singh@openhouse.in':        { phone:'9217275007', can_assign:true, can_visit:true },
  'shashank.kumar@openhouse.in':     { phone:'9205658886', can_assign:true },
  'sushmita.roy@openhouse.in':       { phone:'9821700377', can_assign:true },
  'ashwani.sharma@openhouse.in':     { phone:'9217710686', can_visit:true },
  'manish.sharma@openhouse.in':      { phone:'7428500816', can_visit:true },
  'nishant.kumar@openhouse.in':      { phone:'8130733966', can_visit:true },
  'praveen.kumar@openhouse.in':      { phone:'9289996737', can_visit:true },
  'rahul.singh@openhouse.in':        { phone:'9217710683', can_visit:true },
  'saurabh@openhouse.in':            { phone:'9174286625' },
  'sahaj.dureja@openhouse.in':       { phone:'8003297088', can_assign:true, can_visit:true },
  'saransh.khera@openhouse.in':      { phone:'8595594789' },
  'vaibhav.dwivedi@openhouse.in':    { phone:'' },
};

async function seedUserRoles() {
  console.log('Seeding user roles from hardcoded data...');
  for (const [email, data] of Object.entries(SEED_USER_ROLES)) {
    try {
      await pool.query(
        `UPDATE users SET
          phone=COALESCE(NULLIF($1,''),phone),
          can_assign=COALESCE($2,can_assign),
          can_visit=COALESCE($3,can_visit),
          is_top_manager=COALESCE($4,is_top_manager)
        WHERE LOWER(email)=$5 AND phone IS NULL`,
        [data.phone||null, data.can_assign||false, data.can_visit||false, data.is_top_manager||false, email]
      );
    } catch(e) { console.error(`Seed ${email}:`, e.message); }
  }
  console.log('User roles seeded.');
}

if (require.main === module) {
  (async () => {
    try {
      await pool.query(MIGRATION_SQL); console.log('Migration done');
      await pool.query(COMPAT_SQL); console.log('Compat done');
      await pool.query(LOGS_TABLE_SQL); console.log('Logs table done');
      if (process.argv[2] === 'seed') await seedUserRoles();
      process.exit(0);
    } catch(e) { console.error(e); process.exit(1); }
  })();
}
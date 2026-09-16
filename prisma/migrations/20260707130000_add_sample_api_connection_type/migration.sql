-- Add the sandbox sample-inverter connection type so a paying customer can turn
-- on a synthetic inverter feed without real vendor credentials.
ALTER TYPE "ConnectionType" ADD VALUE IF NOT EXISTS 'sample_api';

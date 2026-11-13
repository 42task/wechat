-- Existing devices and new registrations without an explicit type use iOS.
ALTER TABLE `device` ADD COLUMN `device_type` varchar(32) NOT NULL DEFAULT 'ios';

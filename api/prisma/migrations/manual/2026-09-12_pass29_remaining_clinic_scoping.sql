-- Pass 29 — Multi-Tenant Clinics (remaining modules)
--
-- Adds clinicId to Reviews, Invoice, Prescription, Blogs (all required, backfilled from
-- the same "Legacy Clinic" Pass 27 created) and to Notification (nullable — see that
-- column's own schema.prisma comment for why).
--
-- Same caveats as Pass 27's migration file: hand-written (no prisma migrate history to
-- diff against), not run through the prisma CLI in this environment. Run
-- npx prisma validate and test against staging first. MariaDB DDL is not fully
-- transactional — back up first.
--
-- Assumes Pass 27's migration has already run (the "Legacy Clinic" row exists).

SET @legacy_clinic_id = (SELECT `id` FROM `Clinic` WHERE `slug` = 'legacy-clinic' LIMIT 1);

-- ============================================================================
-- Reviews
-- ============================================================================
ALTER TABLE `Reviews` ADD COLUMN `clinicId` VARCHAR(191) NULL;
UPDATE `Reviews` SET `clinicId` = @legacy_clinic_id WHERE `clinicId` IS NULL;
ALTER TABLE `Reviews`
  MODIFY COLUMN `clinicId` VARCHAR(191) NOT NULL,
  ADD INDEX `Reviews_clinicId_status_idx`(`clinicId`, `status`),
  ADD CONSTRAINT `Reviews_clinicId_fkey` FOREIGN KEY (`clinicId`) REFERENCES `Clinic`(`id`);

-- ============================================================================
-- Invoice
-- ============================================================================
ALTER TABLE `Invoice` ADD COLUMN `clinicId` VARCHAR(191) NULL;
UPDATE `Invoice` SET `clinicId` = @legacy_clinic_id WHERE `clinicId` IS NULL;
ALTER TABLE `Invoice`
  MODIFY COLUMN `clinicId` VARCHAR(191) NOT NULL,
  ADD INDEX `Invoice_clinicId_idx`(`clinicId`),
  ADD CONSTRAINT `Invoice_clinicId_fkey` FOREIGN KEY (`clinicId`) REFERENCES `Clinic`(`id`);

-- ============================================================================
-- Prescription
-- ============================================================================
ALTER TABLE `Prescription` ADD COLUMN `clinicId` VARCHAR(191) NULL;
UPDATE `Prescription` SET `clinicId` = @legacy_clinic_id WHERE `clinicId` IS NULL;
ALTER TABLE `Prescription`
  MODIFY COLUMN `clinicId` VARCHAR(191) NOT NULL,
  ADD INDEX `Prescription_clinicId_idx`(`clinicId`),
  ADD CONSTRAINT `Prescription_clinicId_fkey` FOREIGN KEY (`clinicId`) REFERENCES `Clinic`(`id`);

-- ============================================================================
-- Blogs — no existing @@map, table name is the model name "Blogs"
-- ============================================================================
ALTER TABLE `Blogs` ADD COLUMN `clinicId` VARCHAR(191) NULL;
UPDATE `Blogs` SET `clinicId` = @legacy_clinic_id WHERE `clinicId` IS NULL;
ALTER TABLE `Blogs`
  MODIFY COLUMN `clinicId` VARCHAR(191) NOT NULL,
  ADD INDEX `Blogs_clinicId_idx`(`clinicId`),
  ADD CONSTRAINT `Blogs_clinicId_fkey` FOREIGN KEY (`clinicId`) REFERENCES `Clinic`(`id`);

-- ============================================================================
-- Notification — NULLABLE, no backfill. Every existing row genuinely has no
-- retrievable clinic context (dispatchNotification's call sites don't pass one yet —
-- see docs/passes/29-multi-tenant-clinics-remaining-modules.md), so leaving these NULL
-- is correct, not a shortcut.
-- ============================================================================
ALTER TABLE `Notification`
  ADD COLUMN `clinicId` VARCHAR(191) NULL,
  ADD INDEX `Notification_clinicId_status_idx`(`clinicId`, `status`),
  ADD CONSTRAINT `Notification_clinicId_fkey` FOREIGN KEY (`clinicId`) REFERENCES `Clinic`(`id`);

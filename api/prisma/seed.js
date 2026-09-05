/**
 * Kuwait-centric test data seeder for Careva.
 *
 * Wipes and repopulates every app table with a self-consistent set of doctors,
 * patients, appointments, payments/invoices, prescriptions and reviews — all
 * priced in KWD and addressed in Kuwait's governorates — so the app is fully
 * click-through-able without any manual data entry.
 *
 * Usage (from api/):
 *   node prisma/seed.js
 *   npx prisma db seed        // same thing, via the "prisma.seed" entry in package.json
 *
 * All seeded accounts (admin, every doctor, every patient) share the password
 * printed at the end of the run.
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const prisma = new PrismaClient();

const TEST_PASSWORD = 'Passw0rd!123';
const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Reference data (Kuwait)
// ---------------------------------------------------------------------------

const GOVERNORATES = ['Al Asimah', 'Hawalli', 'Farwaniya', 'Mubarak Al-Kabeer', 'Ahmadi', 'Jahra'];

const AREAS = [
  { city: 'Kuwait City', state: 'Al Asimah', zip: '13001' },
  { city: 'Salmiya', state: 'Hawalli', zip: '20002' },
  { city: 'Hawalli', state: 'Hawalli', zip: '32001' },
  { city: 'Jabriya', state: 'Hawalli', zip: '12613' },
  { city: 'Farwaniya', state: 'Farwaniya', zip: '18001' },
  { city: 'Fahaheel', state: 'Ahmadi', zip: '64001' },
  { city: 'Mangaf', state: 'Ahmadi', zip: '54001' },
  { city: 'Salwa', state: 'Hawalli', zip: '40001' },
  { city: 'Mishref', state: 'Mubarak Al-Kabeer', zip: '42001' },
  { city: 'Sabah Al-Salem', state: 'Mubarak Al-Kabeer', zip: '46001' },
  { city: 'Jahra', state: 'Jahra', zip: '01001' },
];

const CLINIC_NAMES = [
  'Al-Salam Medical Clinic',
  'Dar Al Shifa Specialist Clinic',
  'Kuwait Specialized Medical Center',
  'Royale Hayat Polyclinic',
  'Taiba Medical Center',
  'Al-Sabah Family Clinic',
  'Gulf Medical Polyclinic',
  'Mishref Health Center',
  'Al-Rashidiya Medical Complex',
  'New Mowasat Outpatient Clinic',
];

const DOCTOR_SPECIALIZATIONS = [
  'Cardiologist', 'Dermatologist', 'Orthopedic Surgeon', 'Gynecologist',
  'Neurologist', 'Ophthalmologist', 'Pediatrician', 'Endocrinologist',
  'Gastroenterologist', 'Pulmonologist',
];

const DEGREES = ['MBBS, MD', 'MBBCh, MRCP', 'MBBS, FRCS', 'MD, PhD', 'MBBS, DGO', 'MD, DM'];
const COLLEGES = [
  'Kuwait University Faculty of Medicine', 'Cairo University Faculty of Medicine',
  'Ain Shams University', 'University of Jordan School of Medicine',
  'Damascus University Faculty of Medicine', 'Manipal Academy of Higher Education',
];

const DOCTOR_FIRST_NAMES_M = ['Ahmad', 'Yousef', 'Khalid', 'Abdullah', 'Hassan', 'Fahad', 'Mohammed', 'Salman'];
const DOCTOR_FIRST_NAMES_F = ['Fatima', 'Mariam', 'Noura', 'Salma', 'Aisha', 'Dalal', 'Shaikha', 'Hessa'];
const DOCTOR_LAST_NAMES = [
  'Al-Sabah', 'Al-Mutairi', 'Al-Kandari', 'Al-Ajmi', 'Al-Rashidi', 'Al-Failakawi',
  'Al-Enezi', 'Al-Qallaf', 'Al-Dosari', 'Al-Fadhli', 'Al-Shammari', 'Boushehri',
];

// Kuwait has a large expatriate population, so the patient list mixes Kuwaiti
// nationals with common expat communities (Egyptian, Indian, Filipino, Syrian).
// Kuwaiti-national and expat names, mixed together — all resident in Kuwait
// (Patient.country below records residence, not nationality; the schema has
// no separate nationality field).
const PATIENTS_SEED = [
  { first: 'Mohammed', last: 'Al-Mutairi', gender: 'male' },
  { first: 'Latifa', last: 'Al-Ajmi', gender: 'female' },
  { first: 'Saad', last: 'Al-Enezi', gender: 'male' },
  { first: 'Bibi', last: 'Al-Qallaf', gender: 'female' },
  { first: 'Omar', last: 'Al-Shammari', gender: 'male' },
  { first: 'Reem', last: 'Boushehri', gender: 'female' },
  { first: 'Ahmed', last: 'Hassan', gender: 'male' },
  { first: 'Mona', last: 'Fathy', gender: 'female' },
  { first: 'Priya', last: 'Nair', gender: 'female' },
  { first: 'Rajesh', last: 'Kumar', gender: 'male' },
  { first: 'Maria', last: 'Santos', gender: 'female' },
  { first: 'Jose', last: 'Reyes', gender: 'male' },
  { first: 'Layla', last: 'Haddad', gender: 'female' },
  { first: 'Karim', last: 'Youssef', gender: 'male' },
  { first: 'Anjali', last: 'Menon', gender: 'female' },
];

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

const DISEASES = [
  'Hypertension', 'Type 2 Diabetes Mellitus', 'Coronary Artery Disease', 'Osteoarthritis',
  'Asthma', 'Migraine', 'Gastroesophageal Reflux Disease (GERD)', 'Chronic Kidney Disease',
];

const MEDICINES = [
  { medicine: 'Metformin', dosage: '500 mg', frequency: 'Twice Daily (BID)', duration: '30 days' },
  { medicine: 'Amlodipine', dosage: '5 mg', frequency: 'Once Daily (QD)', duration: '30 days' },
  { medicine: 'Atorvastatin', dosage: '20 mg', frequency: 'Once Daily (QD)', duration: '90 days' },
  { medicine: 'Omeprazole', dosage: '20 mg', frequency: 'Once Daily (QD)', duration: '14 days' },
  { medicine: 'Salbutamol Inhaler', dosage: '100 mcg', frequency: 'As Needed (PRN)', duration: '30 days' },
  { medicine: 'Paracetamol', dosage: '500 mg', frequency: 'Every 6 Hours (Q6H)', duration: '5 days' },
];

const VISIT_REASONS = [
  'General checkup', 'Follow-up visit', 'New problem / symptom', 'Chronic care management',
  'Consultation / second opinion', 'Prescription refill', 'Lab results review',
];

const TIME_SLOTS = ['09:00 AM', '09:30 AM', '10:00 AM', '10:30 AM', '11:00 AM', '04:00 PM', '04:30 PM', '05:00 PM'];

// Kuwait's working week is Sunday–Thursday; Friday/Saturday is the weekend.
const WORKING_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pickMany = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pad = (n, len) => String(n).padStart(len, '0');
const kuwaitMobile = () => `+965${pick(['5', '6', '9'])}${pad(randInt(0, 9999999), 7)}`;
const generateTrackingId = () => `CV${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const isoDateDaysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// Mirrors api/src/shared/money.ts — KWD is a 3-decimal-place currency (1 KWD = 1000 fils).
const toFils = (kwdAmount) => Math.round(kwdAmount * 1000);

// Mirrors the fee formula in appointment.service.ts (createAppointment /
// createAppointmentByUnAuthenticateUser): a flat 10 KWD booking fee, 15% VAT on
// (doctor fee + booking fee).
const computeFees = (doctorFeeKwd) => {
  const doctorFee = toFils(doctorFeeKwd);
  const bookingFee = toFils(10);
  const vat = Math.round(0.15 * (doctorFee + bookingFee));
  const totalAmount = doctorFee + bookingFee + vat;
  return { doctorFee, bookingFee, vat, totalAmount };
};

let invoiceSeq = 0;
const nextInvoiceNumber = () => {
  invoiceSeq += 1;
  const now = new Date();
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1, 2);
  return `INV${year}${month}${pad(invoiceSeq, 4)}`;
};

// ---------------------------------------------------------------------------
// Wipe (child tables first, respecting the schema's Restrict/Cascade rules)
// ---------------------------------------------------------------------------

async function wipe() {
  console.log('Clearing existing data...');
  await prisma.notification.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.invoice.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.paymentWebhookEvent.deleteMany({});
  await prisma.medicine.deleteMany({});
  await prisma.prescription.deleteMany({});
  await prisma.reviews.deleteMany({});
  await prisma.favourites.deleteMany({});
  await prisma.appointments.deleteMany({});
  await prisma.blogs.deleteMany({});
  await prisma.scheduleDay.deleteMany({});
  await prisma.doctorTimeSlot.deleteMany({});
  await prisma.doctorBlockedDate.deleteMany({});
  await prisma.doctor.deleteMany({});
  await prisma.patient.deleteMany({});
  await prisma.forgotPassword.deleteMany({});
  await prisma.userVerfication.deleteMany({});
  await prisma.auth.deleteMany({});
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main() {
  await wipe();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, BCRYPT_ROUNDS);

  // --- Admins -----------------------------------------------------------
  console.log('Creating admin accounts...');
  await prisma.auth.create({
    data: { email: 'admin@careva.kw', password: passwordHash, role: 'admin', isDemo: false },
  });
  await prisma.auth.create({
    data: { email: 'demo.admin@careva.kw', password: passwordHash, role: 'admin', isDemo: true },
  });

  // --- Doctors ------------------------------------------------------------
  console.log('Creating doctors...');
  const doctors = [];
  for (let i = 0; i < 10; i++) {
    const isMale = i % 2 === 0;
    const firstName = pick(isMale ? DOCTOR_FIRST_NAMES_M : DOCTOR_FIRST_NAMES_F);
    const lastName = DOCTOR_LAST_NAMES[i % DOCTOR_LAST_NAMES.length];
    const area = AREAS[i % AREAS.length];
    const specialization = DOCTOR_SPECIALIZATIONS[i % DOCTOR_SPECIALIZATIONS.length];
    const priceKwd = randInt(10, 30); // consultation fee in KWD
    const completionYear = String(randInt(1998, 2018));
    const experience = String(2024 - Number(completionYear));

    const doctor = await prisma.doctor.create({
      data: {
        firstName,
        lastName,
        email: `dr.${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}${i}@careva.kw`,
        phone: kuwaitMobile(),
        gender: isMale ? 'male' : 'female',
        dob: `19${randInt(60, 85)}-0${randInt(1, 9)}-1${randInt(0, 9)}`,
        biography: `${specialization} with ${experience}+ years of experience treating patients across Kuwait, based in ${area.city}.`,
        clinicName: CLINIC_NAMES[i % CLINIC_NAMES.length],
        clinicAddress: `Block ${randInt(1, 12)}, Street ${randInt(1, 60)}, ${area.city}`,
        city: area.city,
        state: area.state,
        country: 'Kuwait',
        postalCode: area.zip,
        price: priceKwd.toFixed(3), // KWD is 3-decimal
        services: 'Consultation, Follow-up, Second Opinion',
        specialization,
        degree: pick(DEGREES),
        college: pick(COLLEGES),
        completionYear,
        experience,
        designation: pick(['Consultant', 'Senior Consultant', 'Specialist']),
        registration: `KMA-${randInt(10000, 99999)}`,
        year: completionYear,
        experienceHospitalName: pick(CLINIC_NAMES),
        expericenceStart: String(Number(completionYear) + 1),
        expericenceEnd: '',
        verified: true,
        approvalStatus: 'APPROVED',
        approvalStatusChangedAt: new Date(),
        approvalStatusChangedBy: 'seed-script',
        approvalStatusChangeReason: 'Seeded as pre-approved for local testing',
        currency: 'KWD',
      },
    });
    doctors.push(doctor);

    await prisma.auth.create({
      data: { email: doctor.email, password: passwordHash, userId: doctor.id, role: 'doctor', isDemo: false },
    });

    // Weekly recurring availability, Sun–Thu (Kuwait's working week).
    for (const day of WORKING_DAYS) {
      const slots = pickMany(TIME_SLOTS, 4).sort();
      await prisma.doctorTimeSlot.create({
        data: {
          doctorId: doctor.id,
          day,
          weekDay: day,
          maximumPatient: slots.length,
          timeSlot: {
            create: slots.map((slot) => {
              const [, hh, mm, ap] = slot.match(/(\d+):(\d+) (\w+)/);
              let startHour = Number(hh) % 12;
              if (ap === 'PM') startHour += 12;
              const startTotalMin = startHour * 60 + Number(mm);
              const endTotalMin = startTotalMin + 30;
              const startTime = `${pad(Math.floor(startTotalMin / 60), 2)}:${pad(startTotalMin % 60, 2)}`;
              const endTime = `${pad(Math.floor(endTotalMin / 60), 2)}:${pad(endTotalMin % 60, 2)}`;
              return { startTime, endTime };
            }),
          },
        },
      });
    }

    // One blocked date — Kuwait National Day.
    await prisma.doctorBlockedDate.create({
      data: { doctorId: doctor.id, date: `${new Date().getFullYear()}-02-25`, reason: 'Kuwait National Day' },
    });
  }

  // --- Patients -------------------------------------------------------------
  console.log('Creating patients...');
  const patients = [];
  for (let i = 0; i < PATIENTS_SEED.length; i++) {
    const p = PATIENTS_SEED[i];
    const area = AREAS[(i + 3) % AREAS.length];
    const dob = new Date(randInt(1965, 2005), randInt(0, 11), randInt(1, 28));

    const patient = await prisma.patient.create({
      data: {
        firstName: p.first,
        lastName: p.last,
        dateOfBirth: dob,
        bloodGroup: pick(BLOOD_GROUPS),
        mobile: kuwaitMobile(),
        city: area.city,
        state: area.state,
        zipCode: area.zip,
        gender: p.gender,
        country: 'Kuwait', // country of residence
        email: `${p.first.toLowerCase()}.${p.last.toLowerCase().replace(/[^a-z]/g, '')}${i}@example.com`,
        address: `Block ${randInt(1, 12)}, Street ${randInt(1, 60)}, House ${randInt(1, 200)}, ${area.city}, Kuwait`,
      },
    });
    patients.push(patient);

    await prisma.auth.create({
      data: { email: patient.email, password: passwordHash, userId: patient.id, role: 'patient', isDemo: false },
    });
  }

  // --- Favourites -------------------------------------------------------------
  console.log('Creating favourites...');
  for (const patient of patients.slice(0, 8)) {
    const favDoctors = pickMany(doctors, 2);
    for (const doctor of favDoctors) {
      await prisma.favourites.create({ data: { patientId: patient.id, doctorId: doctor.id } }).catch(() => {});
    }
  }

  // --- Appointments (+ payments, invoices, prescriptions, reviews) -----------
  console.log('Creating appointments...');
  const statusPlan = [
    // { status, dayOffset } — dayOffset negative = past, positive = future
    { status: 'COMPLETED', dayOffset: -20 },
    { status: 'COMPLETED', dayOffset: -14 },
    { status: 'COMPLETED', dayOffset: -7 },
    { status: 'SCHEDULED', dayOffset: 2 },
    { status: 'SCHEDULED', dayOffset: 5 },
    { status: 'PENDING', dayOffset: 3 },
    { status: 'PENDING', dayOffset: 6 },
    { status: 'CANCELLED_BY_PATIENT', dayOffset: -3 },
    { status: 'CANCELLED_BY_DOCTOR', dayOffset: -5 },
    { status: 'DECLINED', dayOffset: -2 },
    { status: 'NO_SHOW', dayOffset: -10 },
    { status: 'EXPIRED', dayOffset: -30 },
  ];

  for (let i = 0; i < statusPlan.length; i++) {
    const { status, dayOffset } = statusPlan[i];
    const patient = patients[i % patients.length];
    const doctor = doctors[i % doctors.length];
    const scheduleDate = isoDateDaysFromNow(dayOffset);
    const scheduleTime = pick(TIME_SLOTS);
    const isPastConfirmed = ['COMPLETED', 'NO_SHOW', 'EXPIRED'].includes(status);
    const isMoneyStatus = ['SCHEDULED', 'COMPLETED', 'NO_SHOW'].includes(status);

    const paymentStatusForAppt = isMoneyStatus ? 'paid' : 'unpaid';

    const appointment = await prisma.appointments.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        trackingId: generateTrackingId(),
        firstName: patient.firstName,
        lastName: patient.lastName,
        email: patient.email,
        phone: patient.mobile,
        address: patient.address,
        description: `${pick(VISIT_REASONS)} regarding ${pick(DISEASES).toLowerCase()}.`,
        scheduleDate,
        scheduleTime,
        reasonForVisit: pick(VISIT_REASONS),
        status,
        statusChangedAt: new Date(),
        statusChangedBy: status === 'PENDING' ? null : 'seed-script',
        statusChangeReason: status === 'PENDING' ? null : `Seeded in ${status} state for testing`,
        paymentStatus: paymentStatusForAppt,
        prescriptionStatus: status === 'COMPLETED' ? 'issued' : 'notIssued',
        isFollowUp: i % 4 === 0,
        patientType: i % 3 === 0 ? 'new' : 'returning',
      },
    });

    // Payment + Invoice — only once an appointment is SCHEDULED/COMPLETED/NO_SHOW,
    // matching the real app's invoice-at-SCHEDULED trigger (see schema.prisma's
    // Invoice model comment).
    if (isMoneyStatus) {
      const fees = computeFees(Number(doctor.price));
      const payment = await prisma.payment.create({
        data: {
          appointmentId: appointment.id,
          paymentMethod: 'card',
          paymentType: 'online',
          status: 'SUCCEEDED',
          provider: 'telr',
          currency: 'KWD',
          DoctorFee: fees.doctorFee,
          bookingFee: fees.bookingFee,
          vat: fees.vat,
          totalAmount: fees.totalAmount,
          providerOrderId: `TELR-ORD-${randInt(100000, 999999)}`,
          providerPaymentId: `TELR-PAY-${randInt(100000, 999999)}`,
        },
      });

      await prisma.invoice.create({
        data: {
          appointmentId: appointment.id,
          paymentId: payment.id,
          invoiceNumber: nextInvoiceNumber(),
          status: status === 'COMPLETED' || status === 'NO_SHOW' ? 'PAID' : 'ISSUED',
          currency: 'KWD',
          doctorFee: fees.doctorFee,
          bookingFee: fees.bookingFee,
          vat: fees.vat,
          totalAmount: fees.totalAmount,
        },
      });
    }

    // Prescription + review — only for completed visits.
    if (status === 'COMPLETED') {
      const disease = pick(DISEASES);
      await prisma.prescription.create({
        data: {
          doctorId: doctor.id,
          patientId: patient.id,
          appointmentId: appointment.id,
          disease,
          daignosis: disease,
          instruction: 'Take medication as prescribed, maintain a balanced diet, and follow up in 2 weeks if symptoms persist.',
          followUpdate: isoDateDaysFromNow(dayOffset + 14),
          test: pick(['Blood Test', 'ECG', 'X-Ray', null]),
          status: 'ISSUED',
          medicines: { create: pickMany(MEDICINES, 2) },
        },
      });

      await prisma.reviews.create({
        data: {
          doctorId: doctor.id,
          patientId: patient.id,
          appointmentId: appointment.id,
          description: pick([
            'Very professional and explained everything clearly.',
            'Short waiting time and a caring doctor. Highly recommended.',
            'Good experience overall, will book again.',
            'The clinic was clean and the doctor was thorough.',
          ]),
          star: String(randInt(3, 5)),
          isRecommended: true,
          status: 'PUBLISHED',
        },
      });
    }
  }

  console.log('\nDone. Seeded:');
  console.log(`  ${doctors.length} doctors, ${patients.length} patients, ${statusPlan.length} appointments`);
  console.log('\nLogin with any seeded email below and this password:');
  console.log(`  Password: ${TEST_PASSWORD}`);
  console.log('\n  Admin (full access):   admin@careva.kw');
  console.log('  Admin (read-only demo): demo.admin@careva.kw');
  console.log(`  Doctor example:        ${doctors[0].email}`);
  console.log(`  Patient example:       ${patients[0].email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

const router = require('express').Router();
const db     = require('../config/database');
const PDFKit = require('pdfkit');
const { authenticate, authorize } = require('../middleware/auth');

function genRxNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `RX-${stamp}-${Math.floor(Math.random()*9000)+1000}`;
}

// GET /api/prescriptions
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, patient_id, limit=50, offset=0 } = req.query;
    let where = ['true'], params = [], i = 1;

    if (req.user.role_name === 'doctor' && !req.user.permissions?.all) {
      where.push(`pr.doctor_id = $${i++}`); params.push(req.user.id);
    }
    if (status)     { where.push(`pr.status = $${i++}`);     params.push(status); }
    if (patient_id) { where.push(`pr.patient_id = $${i++}`); params.push(patient_id); }
    params.push(parseInt(limit), parseInt(offset));

    const rows = await db.getAll(
      `SELECT pr.*,
              pt.name AS patient_name, pt.phone AS patient_phone,
              pt.age AS patient_age, pt.gender AS patient_gender,
              u.name AS doctor_name,
              dp.specialization, dp.registration_number
       FROM prescriptions pr
       JOIN patients pt ON pr.patient_id = pt.id
       JOIN users u ON pr.doctor_id = u.id
       LEFT JOIN doctor_profiles dp ON u.id = dp.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY pr.visit_date DESC
       LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const total = await db.getOne(
      `SELECT COUNT(*) AS c FROM prescriptions pr WHERE ${where.join(' AND ')}`,
      params.slice(0,-2)
    );
    res.json({ data: rows, total: parseInt(total.c) });
  } catch (err) { next(err); }
});

// GET /api/prescriptions/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const rx = await db.getOne(
      `SELECT pr.*,
              pt.name AS patient_name, pt.phone AS patient_phone, pt.age AS patient_age,
              pt.gender AS patient_gender, pt.blood_group, pt.allergies,
              pt.address AS patient_address,
              u.name AS doctor_name, u.phone AS doctor_phone, u.email AS doctor_email,
              dp.specialization, dp.registration_number, dp.qualification,
              dp.clinic_name, dp.clinic_address, dp.clinic_phone
       FROM prescriptions pr
       JOIN patients pt ON pr.patient_id = pt.id
       JOIN users u ON pr.doctor_id = u.id
       LEFT JOIN doctor_profiles dp ON u.id = dp.user_id
       WHERE pr.id::text = $1 OR pr.uuid::text = $1 OR pr.rx_number = $1`,
      [req.params.id]
    );
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });

    const [medicines, lab_tests, vitals] = await Promise.all([
      // Include gst_rate so billing page can compute accurate totals
      db.getAll(
        `SELECT pi.*, m.gst_rate
         FROM prescription_items pi
         LEFT JOIN medicines m ON pi.medicine_id = m.id
         WHERE pi.prescription_id = $1
         ORDER BY pi.id`,
        [rx.id]
      ),
      db.getAll('SELECT * FROM prescription_lab_tests WHERE prescription_id=$1 ORDER BY id', [rx.id]),
      db.getOne('SELECT * FROM patient_vitals WHERE patient_id=$1 ORDER BY recorded_at DESC LIMIT 1', [rx.patient_id]),
    ]);

    res.json({ ...rx, medicines, lab_tests, vitals: vitals || null });
  } catch (err) { next(err); }
});

// POST /api/prescriptions — doctors only
router.post('/', authenticate, authorize('doctor','admin'), async (req, res, next) => {
  try {
    const {
      patient_id, chief_complaint, diagnosis,
      medicines=[], lab_tests=[], advice, follow_up_date, notes
    } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });

    const patient = await db.getOne('SELECT id FROM patients WHERE id=$1', [patient_id]);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const result = await db.transaction(async (client) => {
      const rx_number = genRxNumber();
      const rxRow = (await client.query(
        `INSERT INTO prescriptions
         (rx_number,doctor_id,patient_id,chief_complaint,diagnosis,advice,follow_up_date,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, uuid, rx_number`,
        [rx_number, req.user.id, patient_id, chief_complaint||null,
         diagnosis||null, advice||null, follow_up_date||null, notes||null]
      )).rows[0];

      for (const m of medicines) {
        await client.query(
          `INSERT INTO prescription_items
           (prescription_id,medicine_id,medicine_name,dosage,frequency,duration,quantity,instructions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rxRow.id, m.medicine_id||null, m.medicine_name, m.dosage||null,
           m.frequency||null, m.duration||null, m.quantity||null, m.instructions||null]
        );
      }
      for (const lt of lab_tests) {
        await client.query(
          `INSERT INTO prescription_lab_tests
           (prescription_id,test_name,instructions,urgency)
           VALUES ($1,$2,$3,$4)`,
          [rxRow.id, lt.test_name, lt.instructions||null, lt.urgency||'Routine']
        );
      }
      return rxRow;
    });

    res.status(201).json({
      message: 'Prescription created',
      id: result.id,
      uuid: result.uuid,
      rx_number: result.rx_number,
    });
  } catch (err) { next(err); }
});

// PATCH /api/prescriptions/:id/status
router.patch('/:id/status', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body;
    await db.run(
      `UPDATE prescriptions SET status=$1, dispensed_by=$2, dispensed_at=NOW() WHERE id=$3`,
      [status, req.user.id, req.params.id]
    );
    res.json({ message: 'Status updated' });
  } catch (err) { next(err); }
});

// GET /api/prescriptions/:id/pdf?size=A4|A5
router.get('/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const rx = await db.getOne(
      `SELECT pr.*,
              pt.name AS patient_name, pt.phone AS patient_phone,
              pt.age AS patient_age, pt.gender AS patient_gender,
              pt.blood_group, pt.address AS patient_address, pt.allergies,
              u.name AS doctor_name, u.phone AS doctor_phone,
              dp.specialization, dp.registration_number, dp.qualification,
              dp.clinic_name, dp.clinic_address, dp.clinic_phone
       FROM prescriptions pr
       JOIN patients pt ON pr.patient_id = pt.id
       JOIN users u ON pr.doctor_id = u.id
       LEFT JOIN doctor_profiles dp ON u.id = dp.user_id
       WHERE pr.id::text=$1 OR pr.uuid::text=$1 OR pr.rx_number=$1`,
      [req.params.id]
    );
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });

    rx.medicines = await db.getAll(
      'SELECT * FROM prescription_items WHERE prescription_id=$1 ORDER BY id',
      [rx.id]
    );
    rx.lab_tests = await db.getAll(
      'SELECT * FROM prescription_lab_tests WHERE prescription_id=$1 ORDER BY id',
      [rx.id]
    );
    const pharmacy = await db.getOne('SELECT * FROM pharmacy_info WHERE id=1');

    // ── Page layout constants ───────────────────────────────────────────────
    const pgSize = (['A4','A5'].includes((req.query.size||'').toUpperCase()))
      ? req.query.size.toUpperCase() : 'A4';
    const isA5 = pgSize === 'A5';

    const L    = isA5 ? 25   : 50;      // left & right margin
    const PW   = isA5 ? 419.53 : 595.28; // page width in points
    const PH   = isA5 ? 595.28 : 841.89; // page height in points
    const R    = PW - L;                  // right edge
    const W    = R - L;                   // usable width
    const MAXY = PH - L - 45;            // max Y before adding a new page

    // Font size set
    const F = {
      doctor: isA5 ? 13  : 17,
      secHdr: isA5 ? 9   : 11,
      body:   isA5 ? 8.5 : 10,
      small:  isA5 ? 7.5 : 9,
      tiny:   isA5 ? 6   : 7,
      rxSym:  isA5 ? 22  : 32,
    };
    const LH = isA5 ? 11 : 14; // standard line height

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Rx-${rx.rx_number}.pdf"`);

    const doc = new PDFKit({ margin: L, size: pgSize });
    doc.pipe(res);

    // Helper: add a new page if y exceeds MAXY, reset y to top margin
    const checkBreak = (y) => {
      if (y > MAXY) { doc.addPage(); return L + 5; }
      return y;
    };

    // ── Doctor letterhead ───────────────────────────────────────────────────
    let y = L - 5;
    doc.fontSize(F.doctor).font('Helvetica-Bold').fillColor('#1a5e3a')
       .text(rx.doctor_name, L, y);
    y += isA5 ? 16 : 21;

    doc.fontSize(F.small).font('Helvetica').fillColor('#333');
    const quals = [rx.qualification, rx.specialization].filter(Boolean).join(' | ');
    if (quals) { doc.text(quals, L, y, { width: W * 0.58 }); y += LH; }
    if (rx.registration_number) { doc.text(`Reg. No: ${rx.registration_number}`, L, y, { width: W * 0.58 }); y += LH; }
    const clinicLine = [rx.clinic_name, rx.clinic_address].filter(Boolean).join(' | ');
    if (clinicLine) { doc.text(clinicLine, L, y, { width: W * 0.58 }); y += LH; }
    if (rx.clinic_phone) { doc.text(`Tel: ${rx.clinic_phone}`, L, y); y += LH; }

    // Pharmacy info — right-aligned in right 40% of header
    if (pharmacy) {
      const phX = L + Math.floor(W * 0.60);
      const phW = R - phX;
      doc.fontSize(isA5 ? 7 : 8.5).fillColor('#666').font('Helvetica')
         .text(pharmacy.name || '', phX, L - 5, { align: 'right', width: phW })
         .text(`GST: ${pharmacy.gst_number || ''}`, phX, L + LH - 2, { align: 'right', width: phW })
         .text(`Lic: ${pharmacy.drug_license_number || ''}`, phX, L + LH * 2 - 3, { align: 'right', width: phW });
    }

    // ── Divider ─────────────────────────────────────────────────────────────
    y += isA5 ? 4 : 6;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#1a5e3a').lineWidth(1.5).stroke();
    y += isA5 ? 8 : 10;

    // ── Rx symbol + metadata ────────────────────────────────────────────────
    doc.fontSize(F.rxSym).font('Helvetica-Bold').fillColor('#1a5e3a').text('℞', L, y);
    const metaX = L + Math.floor(W * 0.5);
    doc.fontSize(F.small - 0.5).font('Helvetica').fillColor('#666')
       .text(`Rx No: ${rx.rx_number}`, metaX, y + 4, { align: 'right', width: R - metaX })
       .text(`Date: ${new Date(rx.visit_date).toLocaleDateString('en-IN')}`, metaX, y + LH + 4, { align: 'right', width: R - metaX });
    y += isA5 ? 28 : 38;

    // ── Patient summary ──────────────────────────────────────────────────────
    const lblW = isA5 ? 58 : 75;
    const lblEnd = L + lblW;

    doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#000').text('Patient:', L, y);
    doc.font('Helvetica').text(
      [rx.patient_name, rx.patient_age ? rx.patient_age+' yrs' : null, rx.patient_gender, rx.patient_phone]
        .filter(Boolean).join('   '),
      lblEnd, y, { width: W - lblW }
    );
    y += LH;

    if (rx.allergies) {
      doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#cc0000').text('Allergies:', L, y);
      doc.font('Helvetica').fillColor('#cc0000').text(rx.allergies, lblEnd, y, { width: W - lblW });
      y += LH;
      doc.fillColor('#000');
    }
    if (rx.chief_complaint) {
      doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#000').text('Complaint:', L, y);
      doc.font('Helvetica').text(rx.chief_complaint, lblEnd, y, { width: W - lblW }); y += LH;
    }
    if (rx.diagnosis) {
      doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#000').text('Diagnosis:', L, y);
      doc.font('Helvetica').text(rx.diagnosis, lblEnd, y, { width: W - lblW }); y += LH;
    }

    y += 4;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += isA5 ? 10 : 14;

    // ── Medications ──────────────────────────────────────────────────────────
    if (rx.medicines.length) {
      y = checkBreak(y);
      doc.fontSize(F.secHdr).font('Helvetica-Bold').fillColor('#1a5e3a').text('Medications', L, y);
      y += isA5 ? 12 : 16;

      for (let i = 0; i < rx.medicines.length; i++) {
        y = checkBreak(y);
        const m = rx.medicines[i];
        doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#000')
           .text(`${i+1}. ${m.medicine_name}`, L + 8, y);
        if (m.quantity) {
          doc.text(`Qty: ${m.quantity}`, R - 65, y, { align: 'right', width: 65 });
        }
        y += LH;

        const detail = [m.dosage, m.frequency, m.duration, m.instructions].filter(Boolean).join('  ·  ');
        if (detail) {
          y = checkBreak(y);
          doc.fontSize(F.small).font('Helvetica').fillColor('#555')
             .text(detail, L + 18, y, { width: W - 22 });
          y += LH;
        }
        y += 2;
      }
    }

    // ── Lab investigations ────────────────────────────────────────────────────
    if (rx.lab_tests.length) {
      y += 4; y = checkBreak(y);
      doc.moveTo(L, y).lineTo(R, y).strokeColor('#ddd').lineWidth(0.5).stroke();
      y += isA5 ? 8 : 10;
      doc.fontSize(F.secHdr).font('Helvetica-Bold').fillColor('#1a5e3a').text('Lab Investigations', L, y);
      y += isA5 ? 12 : 16;

      for (const lt of rx.lab_tests) {
        y = checkBreak(y);
        doc.fontSize(F.body).font('Helvetica').fillColor('#000').text(`• ${lt.test_name}`, L + 8, y);
        if (lt.urgency && lt.urgency !== 'Routine') {
          doc.fillColor('#cc0000').text(`[${lt.urgency}]`, R - 65, y, { width: 65 });
        }
        y += LH;
        if (lt.instructions) {
          y = checkBreak(y);
          doc.fontSize(F.small).fillColor('#555').text(lt.instructions, L + 18, y, { width: W - 22 });
          y += LH;
        }
      }
    }

    // ── Advice / instructions ─────────────────────────────────────────────────
    if (rx.advice) {
      y += 4; y = checkBreak(y);
      doc.moveTo(L, y).lineTo(R, y).strokeColor('#ddd').lineWidth(0.5).stroke();
      y += isA5 ? 8 : 10;
      doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#000').text('Advice / Instructions:', L, y);
      y += LH;
      y = checkBreak(y);
      doc.font('Helvetica').fontSize(F.small).fillColor('#333')
         .text(rx.advice, L, y, { width: W });
      y += 28;
    }

    if (rx.follow_up_date) {
      y = checkBreak(y);
      doc.fontSize(F.body).font('Helvetica-Bold').fillColor('#1a5e3a')
         .text(`Follow-up: ${new Date(rx.follow_up_date).toLocaleDateString('en-IN')}`, L, y);
      y += 18;
    }

    // ── Signature block ───────────────────────────────────────────────────────
    // Positioned at least 20pt below content, but pushed to bottom third of page
    const sigMinY = Math.max(y + 20, isA5 ? PH - 110 : PH - 140);
    const sigY = Math.min(sigMinY, MAXY - 50);  // don't overflow off page
    doc.moveTo(R - 165, sigY).lineTo(R, sigY).strokeColor('#000').lineWidth(0.5).stroke();
    doc.fontSize(F.small).font('Helvetica').fillColor('#333')
       .text(rx.doctor_name, R - 165, sigY + 4)
       .text(rx.specialization || '', R - 165, sigY + LH + 4)
       .text(`Reg: ${rx.registration_number || ''}`, R - 165, sigY + LH * 2 + 4);

    // ── Footer disclaimer ─────────────────────────────────────────────────────
    doc.fontSize(F.tiny).fillColor('#aaa')
       .text(
         'This is a digitally generated prescription. Valid subject to physical verification.',
         L, PH - L - 22, { align: 'center', width: W }
       );

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;

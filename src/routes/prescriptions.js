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

    // Doctors see only their own prescriptions
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
      `SELECT COUNT(*) AS c FROM prescriptions pr WHERE ${where.slice(0,-0).join(' AND ')}`,
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
      db.getAll('SELECT * FROM prescription_items WHERE prescription_id=$1 ORDER BY id', [rx.id]),
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

// GET /api/prescriptions/:id/pdf
router.get('/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const rx = await db.getOne(
      `SELECT pr.*,
              pt.name AS patient_name, pt.phone AS patient_phone,
              pt.age AS patient_age, pt.gender AS patient_gender,
              pt.blood_group, pt.address AS patient_address,
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
    rx.medicines  = await db.getAll('SELECT * FROM prescription_items WHERE prescription_id=$1', [rx.id]);
    rx.lab_tests  = await db.getAll('SELECT * FROM prescription_lab_tests WHERE prescription_id=$1', [rx.id]);
    const pharmacy = await db.getOne('SELECT * FROM pharmacy_info WHERE id=1');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Rx-${rx.rx_number}.pdf"`);

    const doc = new PDFKit({ margin: 50, size: 'A4' });
    doc.pipe(res);

    // Doctor header block
    doc.fontSize(17).font('Helvetica-Bold').fillColor('#1a5e3a').text(rx.doctor_name, 50, 45);
    doc.fontSize(10).font('Helvetica').fillColor('#333')
       .text(`${rx.qualification||''} | ${rx.specialization||''}`, 50, 66)
       .text(`Reg. No: ${rx.registration_number||''}`, 50, 80)
       .text(`${rx.clinic_name||''} | ${rx.clinic_address||''}`, 50, 94);
    if (rx.clinic_phone) doc.text(`Tel: ${rx.clinic_phone}`, 50, 108);

    // Right: pharmacy
    if (pharmacy) {
      doc.fontSize(9).fillColor('#555')
         .text(pharmacy.name, 310, 45, { align:'right', width:235 })
         .text(`GST: ${pharmacy.gst_number||''}`, 310, 58, { align:'right', width:235 })
         .text(`Lic: ${pharmacy.drug_license_number||''}`, 310, 70, { align:'right', width:235 });
    }

    // Divider
    doc.moveTo(50, 128).lineTo(545, 128).strokeColor('#1a5e3a').lineWidth(1.5).stroke();

    // Rx symbol + meta
    doc.fontSize(32).font('Helvetica-Bold').fillColor('#1a5e3a').text('℞', 50, 138);
    doc.fontSize(9).font('Helvetica').fillColor('#666')
       .text(`Rx No: ${rx.rx_number}`, 310, 143, { align:'right', width:235 })
       .text(`Date: ${new Date(rx.visit_date).toLocaleDateString('en-IN')}`, 310, 155, { align:'right', width:235 });

    let y = 178;
    doc.fillColor('#000').fontSize(10).font('Helvetica-Bold').text('Patient:', 80, y);
    doc.font('Helvetica').text(
      `${rx.patient_name}   ${rx.patient_age ? rx.patient_age+' yrs' : ''}   ${rx.patient_gender||''}   ${rx.patient_phone||''}`,
      140, y
    );
    y += 14;
    if (rx.allergies) {
      doc.font('Helvetica-Bold').fillColor('#c00').text('Allergies:', 80, y);
      doc.font('Helvetica').fillColor('#c00').text(rx.allergies, 148, y);
      y += 14; doc.fillColor('#000');
    }
    if (rx.chief_complaint) {
      doc.font('Helvetica-Bold').text('Complaint:', 80, y);
      doc.font('Helvetica').text(rx.chief_complaint, 150, y); y += 14;
    }
    if (rx.diagnosis) {
      doc.font('Helvetica-Bold').text('Diagnosis:', 80, y);
      doc.font('Helvetica').text(rx.diagnosis, 150, y); y += 14;
    }

    doc.moveTo(50, y+6).lineTo(545, y+6).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 18;

    // Medicines
    if (rx.medicines.length) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a5e3a').text('Medications', 50, y); y += 16;
      rx.medicines.forEach((m, i) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(`${i+1}. ${m.medicine_name}`, 62, y);
        if (m.quantity) doc.text(`Qty: ${m.quantity}`, 460, y, { align:'right', width:80 });
        y += 13;
        const detail = [m.dosage, m.frequency, m.duration, m.instructions].filter(Boolean).join('  ·  ');
        if (detail) { doc.fontSize(9).font('Helvetica').fillColor('#555').text(detail, 75, y); y += 13; }
        y += 3;
      });
    }

    // Lab tests
    if (rx.lab_tests.length) {
      y += 4;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').lineWidth(0.5).stroke(); y += 10;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a5e3a').text('Lab Investigations', 50, y); y += 16;
      rx.lab_tests.forEach((lt, i) => {
        doc.fontSize(10).font('Helvetica').fillColor('#000').text(`${i+1}. ${lt.test_name}`, 62, y);
        if (lt.urgency !== 'Routine') {
          doc.fillColor('#cc0000').text(`[${lt.urgency}]`, 350, y);
        }
        y += 14;
        if (lt.instructions) { doc.fontSize(9).fillColor('#555').text(lt.instructions, 75, y); y += 12; }
      });
    }

    // Advice & follow-up
    if (rx.advice) {
      y += 5;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').lineWidth(0.5).stroke(); y += 10;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text('Advice / Instructions:', 50, y); y += 13;
      doc.font('Helvetica').fontSize(9).fillColor('#333').text(rx.advice, 50, y, { width:495 });
      y += 30;
    }
    if (rx.follow_up_date) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a5e3a')
         .text(`Follow-up: ${new Date(rx.follow_up_date).toLocaleDateString('en-IN')}`, 50, y);
      y += 18;
    }

    // Signature
    const sigY = Math.max(y + 30, 720);
    doc.moveTo(380, sigY).lineTo(540, sigY).strokeColor('#000').lineWidth(0.5).stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#333')
       .text(rx.doctor_name, 380, sigY+4)
       .text(rx.specialization||'', 380, sigY+16)
       .text(`Reg: ${rx.registration_number||''}`, 380, sigY+28);

    doc.fontSize(7).fillColor('#aaa')
       .text('This is a digitally generated prescription. Valid subject to physical verification.', 50, 795, { align:'center', width:495 });
    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;

const router  = require('express').Router();
const db      = require('../config/database');
const PDFKit  = require('pdfkit');
const { authenticate, authorize } = require('../middleware/auth');

// Generate bill number scoped to the current year-month so sequence resets each month
async function genBillNumber() {
  const n  = new Date();
  const ym = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const last = await db.getOne(
    "SELECT bill_number FROM sales WHERE bill_number LIKE $1 ORDER BY id DESC LIMIT 1",
    [`BILL-${ym}-%`]
  );
  const seq = last ? (parseInt(last.bill_number.split('-').pop()) + 1) : 1;
  return `BILL-${ym}-${String(seq).padStart(5,'0')}`;
}

// GET /api/sales
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { date_from, date_to, patient_id, bill_number, limit=50, offset=0 } = req.query;
    let where = ['s.is_cancelled=false'], params = [], i = 1;
    if (date_from)   { where.push(`DATE(s.bill_date) >= $${i++}`); params.push(date_from); }
    if (date_to)     { where.push(`DATE(s.bill_date) <= $${i++}`); params.push(date_to); }
    if (patient_id)  { where.push(`s.patient_id = $${i++}`);       params.push(patient_id); }
    if (bill_number) { where.push(`s.bill_number ILIKE $${i++}`);  params.push(`%${bill_number}%`); }
    params.push(parseInt(limit), parseInt(offset));
    const rows = await db.getAll(
      `SELECT s.*, p.name AS patient_name, u.name AS created_by_name
       FROM sales s
       LEFT JOIN patients p ON s.patient_id=p.id
       LEFT JOIN users u ON s.created_by=u.id
       WHERE ${where.join(' AND ')}
       ORDER BY s.bill_date DESC LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const tot = await db.getOne(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS sum
       FROM sales s WHERE ${where.join(' AND ')}`,
      params.slice(0,-2)
    );
    res.json({ data: rows, total: parseInt(tot.c), totalAmount: parseFloat(tot.sum) });
  } catch (err) { next(err); }
});

// GET /api/sales/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const sale = await db.getOne(
      `SELECT s.*, p.name AS patient_name, p.phone AS patient_phone,
              p.address AS patient_address, u.name AS created_by_name
       FROM sales s
       LEFT JOIN patients p ON s.patient_id=p.id
       LEFT JOIN users u ON s.created_by=u.id
       WHERE s.id=$1`,
      [req.params.id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    sale.items = await db.getAll(
      `SELECT si.*, m.name AS medicine_name, m.generic_name, m.form,
              m.strength, m.hsn_code, m.gst_rate
       FROM sale_items si JOIN medicines m ON si.medicine_id=m.id
       WHERE si.sale_id=$1`,
      [sale.id]
    );
    res.json(sale);
  } catch (err) { next(err); }
});

// POST /api/sales — create bill
router.post('/', authenticate, authorize('pharmacist','cashier','admin'), async (req, res, next) => {
  try {
    const {
      patient_id, doctor_id, prescription_id,
      items=[], payment_mode='Cash', payment_status='Paid',
      discount_percent=0, notes, amount_paid
    } = req.body;
    if (!items.length) return res.status(400).json({ error: 'No items in sale' });

    const result = await db.transaction(async (client) => {
      let subtotal=0, cgst_total=0, sgst_total=0;

      const processed = [];
      for (const item of items) {
        const stock = (await client.query(
          'SELECT * FROM inventory WHERE medicine_id=$1 AND batch_number=$2',
          [item.medicine_id, item.batch_number]
        )).rows[0];
        if (!stock) throw new Error(`Batch ${item.batch_number} not found`);
        const avail = stock.quantity_in - stock.quantity_out;
        if (avail < item.quantity)
          throw new Error(`Insufficient stock: ${item.batch_number} has only ${avail} units`);

        const med = (await client.query('SELECT * FROM medicines WHERE id=$1', [item.medicine_id])).rows[0];
        const lineTotal    = item.quantity * item.mrp;
        const discAmt      = lineTotal * (item.discount_percent||0) / 100;
        const taxable      = lineTotal - discAmt;
        const cgst         = parseFloat((taxable * (med.gst_rate/2) / 100).toFixed(2));
        const sgst         = parseFloat((taxable * (med.gst_rate/2) / 100).toFixed(2));
        subtotal    += taxable;
        cgst_total  += cgst;
        sgst_total  += sgst;
        processed.push({
          ...item,
          expiry_date:  stock.expiry_date,
          cgst_percent: med.gst_rate/2,
          sgst_percent: med.gst_rate/2,
          total_amount: parseFloat((taxable+cgst+sgst).toFixed(2)),
        });
      }

      const discAmt    = parseFloat((subtotal * discount_percent / 100).toFixed(2));
      const afterDisc  = subtotal - discAmt;
      const grandTotal = parseFloat((afterDisc + cgst_total + sgst_total).toFixed(2));
      const rounded    = Math.round(grandTotal);
      const roundOff   = parseFloat((rounded - grandTotal).toFixed(2));
      const finalTotal = rounded;
      const paid       = amount_paid !== undefined ? parseFloat(amount_paid) : finalTotal;
      const balance    = parseFloat((finalTotal - paid).toFixed(2));

      const bill_number = await genBillNumber();
      const saleRow = (await client.query(
        `INSERT INTO sales
         (bill_number,patient_id,doctor_id,prescription_id,payment_mode,payment_status,
          subtotal,discount_percent,discount_amount,cgst_amount,sgst_amount,
          round_off,total_amount,amount_paid,balance,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [bill_number, patient_id||null, doctor_id||null, prescription_id||null,
         payment_mode, payment_status, subtotal.toFixed(2), discount_percent,
         discAmt, cgst_total.toFixed(2), sgst_total.toFixed(2),
         roundOff, finalTotal, paid, balance, notes||null, req.user.id]
      )).rows[0];

      for (const item of processed) {
        await client.query(
          `INSERT INTO sale_items
           (sale_id,medicine_id,batch_number,expiry_date,quantity,mrp,
            discount_percent,cgst_percent,sgst_percent,igst_percent,total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [saleRow.id, item.medicine_id, item.batch_number, item.expiry_date,
           item.quantity, item.mrp, item.discount_percent||0,
           item.cgst_percent, item.sgst_percent, 0, item.total_amount]
        );
        await client.query(
          'UPDATE inventory SET quantity_out=quantity_out+$1 WHERE medicine_id=$2 AND batch_number=$3',
          [item.quantity, item.medicine_id, item.batch_number]
        );
      }

      if (prescription_id) {
        await client.query(
          "UPDATE prescriptions SET status='Dispensed', dispensed_by=$1, dispensed_at=NOW() WHERE id=$2",
          [req.user.id, prescription_id]
        );
      }
      return { bill_number, id: saleRow.id, total_amount: finalTotal };
    });

    res.status(201).json({ message: 'Sale created', ...result });
  } catch (err) {
    if (err.message.includes('Insufficient') || err.message.includes('not found'))
      return res.status(400).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/sales/:id/cancel
router.patch('/:id/cancel', authenticate, authorize('admin','pharmacist'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    const sale = await db.getOne('SELECT * FROM sales WHERE id=$1', [req.params.id]);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (sale.is_cancelled) return res.status(400).json({ error: 'Already cancelled' });

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE sales SET is_cancelled=true, cancel_reason=$1 WHERE id=$2',
        [reason||'Cancelled by user', req.params.id]
      );
      const items = (await client.query('SELECT * FROM sale_items WHERE sale_id=$1', [req.params.id])).rows;
      for (const item of items) {
        await client.query(
          'UPDATE inventory SET quantity_out=quantity_out-$1 WHERE medicine_id=$2 AND batch_number=$3',
          [item.quantity, item.medicine_id, item.batch_number]
        );
      }
    });
    res.json({ message: 'Sale cancelled and stock reversed' });
  } catch (err) { next(err); }
});

// GET /api/sales/:id/pdf?size=A4|A5 — GST tax invoice
router.get('/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const sale = await db.getOne(
      `SELECT s.*, p.name AS patient_name, p.phone AS patient_phone, p.address AS patient_address
       FROM sales s LEFT JOIN patients p ON s.patient_id=p.id WHERE s.id=$1`,
      [req.params.id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    sale.items = await db.getAll(
      `SELECT si.*, m.name AS medicine_name, m.generic_name, m.form, m.strength, m.hsn_code, m.gst_rate
       FROM sale_items si JOIN medicines m ON si.medicine_id=m.id WHERE si.sale_id=$1 ORDER BY si.id`,
      [sale.id]
    );
    const pharmacy = await db.getOne('SELECT * FROM pharmacy_info WHERE id=1');

    // ── Page layout constants ───────────────────────────────────────────────
    const pgSize = (['A4','A5'].includes((req.query.size||'').toUpperCase()))
      ? req.query.size.toUpperCase() : 'A4';
    const isA5 = pgSize === 'A5';

    const L    = isA5 ? 25   : 40;
    const PW   = isA5 ? 419.53 : 595.28;
    const PH   = isA5 ? 595.28 : 841.89;
    const R    = PW - L;
    const W    = R - L;
    const MAXY = PH - L - 45;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${sale.bill_number}.pdf"`);

    const doc = new PDFKit({ margin: L, size: pgSize });
    doc.pipe(res);

    const checkBreak = (y) => {
      if (y > MAXY) {
        doc.addPage();
        // Repeat compact header on continuation pages
        doc.fontSize(isA5 ? 8 : 9).font('Helvetica-Bold').fillColor('#333')
           .text(`${pharmacy?.name || 'PHARMACY'} — Invoice ${sale.bill_number} (continued)`, L, L - 5);
        doc.moveTo(L, L + 12).lineTo(R, L + 12).strokeColor('#ccc').lineWidth(0.5).stroke();
        return L + 20;
      }
      return y;
    };

    // ── Pharmacy header ─────────────────────────────────────────────────────
    doc.fontSize(isA5 ? 12 : 15).font('Helvetica-Bold').fillColor('#1a5e3a')
       .text(pharmacy?.name || 'PHARMACY', L, L - 5, { align: 'center', width: W });

    let y = L + (isA5 ? 15 : 18);
    doc.fontSize(isA5 ? 7 : 8.5).font('Helvetica').fillColor('#555');
    const addrLine = [pharmacy?.address, pharmacy?.city].filter(Boolean).join(', ');
    if (addrLine) { doc.text(addrLine, L, y, { align: 'center', width: W }); y += isA5 ? 10 : 12; }
    const infoLine = [
      pharmacy?.gst_number   ? `GST: ${pharmacy.gst_number}`            : null,
      pharmacy?.drug_license_number ? `Drug Lic: ${pharmacy.drug_license_number}` : null,
      pharmacy?.phone        ? `Ph: ${pharmacy.phone}`                   : null,
    ].filter(Boolean).join('   |   ');
    if (infoLine) { doc.text(infoLine, L, y, { align: 'center', width: W }); y += isA5 ? 10 : 12; }

    y += 4;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#1a5e3a').lineWidth(1.5).stroke();
    y += 4;
    doc.fontSize(isA5 ? 9 : 11).font('Helvetica-Bold').fillColor('#1a5e3a')
       .text('GST TAX INVOICE', L, y, { align: 'center', width: W });
    y += isA5 ? 13 : 16;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#aaa').lineWidth(0.5).stroke();
    y += 6;

    // ── Bill metadata ───────────────────────────────────────────────────────
    const metaFS = isA5 ? 7.5 : 9;
    const bdate  = new Date(sale.bill_date).toLocaleString('en-IN');
    doc.fontSize(metaFS).font('Helvetica').fillColor('#333');
    doc.text(`Bill No: ${sale.bill_number}`,     L, y);
    doc.text(`Date: ${bdate}`,                   L, y + metaFS + 3);
    doc.text(`Payment: ${sale.payment_mode}`,    L, y + (metaFS + 3) * 2);
    if (sale.patient_name) {
      const pX = L + Math.floor(W / 2) + 5;
      doc.text(`Patient: ${sale.patient_name}`,        pX, y,             { width: R - pX });
      doc.text(`Phone: ${sale.patient_phone || '—'}`,  pX, y + metaFS + 3, { width: R - pX });
    }
    y += (metaFS + 3) * 3 + 8;

    // ── Items table ─────────────────────────────────────────────────────────
    // A4 has 9 columns (with GST%); A5 has 8 (drop GST% — shown in totals)
    const C = isA5
      ? { sno: L, name: L+15, batch: L+133, exp: L+182, qty: L+219, mrp: L+244, disc: L+288, amt: R }
      : { sno: L, name: L+20, batch: L+195, exp: L+248, qty: L+302, mrp: L+340, disc: L+382, gst: L+416, amt: R };

    const TFS = isA5 ? 7 : 8;  // table font size
    const ROW = TFS + 5;        // row height

    // Table header
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#555').lineWidth(0.5).stroke();
    y += 3;
    doc.fontSize(TFS).font('Helvetica-Bold').fillColor('#333');
    doc.text('#',        C.sno, y);
    doc.text('Medicine', C.name, y);
    doc.text('Batch',    C.batch, y);
    doc.text('Exp',      C.exp, y);
    doc.text('Qty',      C.qty, y);
    doc.text('MRP',      C.mrp, y);
    doc.text('Disc%',    C.disc, y);
    if (!isA5) doc.text('GST%', C.gst, y);
    doc.text('Amount',   C.amt - (isA5 ? 38 : 50), y, { align: 'right', width: isA5 ? 38 : 50 });
    y += ROW;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#aaa').lineWidth(0.3).stroke();
    y += 3;

    const nameW = isA5 ? (C.batch - C.name - 3) : (C.batch - C.name - 3);

    doc.font('Helvetica').fontSize(TFS).fillColor('#000');
    for (const [i, item] of sale.items.entries()) {
      y = checkBreak(y);
      const exp = item.expiry_date
        ? new Date(item.expiry_date).toLocaleDateString('en-IN', { month: '2-digit', year: '2-digit' })
        : '—';
      doc.text(String(i+1),                                                       C.sno, y);
      doc.text(item.medicine_name,                       C.name, y, { width: nameW, ellipsis: true });
      doc.text(item.batch_number,                        C.batch, y);
      doc.text(exp,                                      C.exp, y);
      doc.text(String(item.quantity),                    C.qty, y);
      doc.text(parseFloat(item.mrp).toFixed(2),          C.mrp, y);
      doc.text(`${item.discount_percent || 0}%`,         C.disc, y);
      if (!isA5) {
        const totalGst = parseFloat(item.cgst_percent||0) + parseFloat(item.sgst_percent||0);
        doc.text(`${totalGst.toFixed(0)}%`, C.gst, y);
      }
      doc.text(
        parseFloat(item.total_amount).toFixed(2),
        C.amt - (isA5 ? 38 : 50), y,
        { align: 'right', width: isA5 ? 38 : 50 }
      );
      y += ROW;
    }

    // For A5: show GST breakdown as a compact footnote under the table
    if (isA5) {
      doc.fontSize(6).fillColor('#666')
         .text(
           `CGST ₹${parseFloat(sale.cgst_amount).toFixed(2)}  |  SGST ₹${parseFloat(sale.sgst_amount).toFixed(2)}`,
           C.name, y
         );
      y += 10;
    }

    doc.moveTo(L, y).lineTo(R, y).strokeColor('#555').lineWidth(0.3).stroke();
    y += 8;

    // ── Totals block ────────────────────────────────────────────────────────
    const totFS   = isA5 ? 8 : 9;
    const totLblX = isA5 ? R - 115 : R - 160;
    const totValW = isA5 ? 75 : 110;

    const addRow = (label, value, bold = false) => {
      doc.fontSize(totFS).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000')
         .text(label, totLblX, y)
         .text(value, R - totValW, y, { align: 'right', width: totValW });
      y += totFS + 4;
    };

    addRow('Subtotal (excl. GST):',    `₹${parseFloat(sale.subtotal).toFixed(2)}`);
    if (parseFloat(sale.discount_amount) > 0) {
      addRow(`Discount (${sale.discount_percent}%):`, `- ₹${parseFloat(sale.discount_amount).toFixed(2)}`);
    }
    if (!isA5) {
      addRow('CGST:', `₹${parseFloat(sale.cgst_amount).toFixed(2)}`);
      addRow('SGST:', `₹${parseFloat(sale.sgst_amount).toFixed(2)}`);
    } else {
      const totalGst = parseFloat(sale.cgst_amount) + parseFloat(sale.sgst_amount);
      addRow('GST (CGST + SGST):', `₹${totalGst.toFixed(2)}`);
    }
    if (parseFloat(sale.round_off) !== 0) {
      addRow('Round off:', `₹${parseFloat(sale.round_off).toFixed(2)}`);
    }

    y += 2;
    doc.moveTo(totLblX - 4, y).lineTo(R, y).strokeColor('#333').lineWidth(0.5).stroke();
    y += 4;
    addRow('TOTAL:', `₹${parseFloat(sale.total_amount).toFixed(2)}`, true);

    // Amount paid / balance (if partial)
    if (parseFloat(sale.balance) !== 0) {
      y += 2;
      addRow('Paid:', `₹${parseFloat(sale.amount_paid).toFixed(2)}`);
      addRow(parseFloat(sale.balance) > 0 ? 'Balance Due:' : 'Change:',
             `₹${Math.abs(parseFloat(sale.balance)).toFixed(2)}`);
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    y += 12;
    doc.fontSize(isA5 ? 6 : 7.5).font('Helvetica').fillColor('#888')
       .text(
         'Medicines once sold will not be returned/exchanged without valid prescription.',
         L, y, { align: 'center', width: W }
       );

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;

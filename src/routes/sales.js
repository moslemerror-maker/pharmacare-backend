const router  = require('express').Router();
const db      = require('../config/database');
const PDFKit  = require('pdfkit');
const { authenticate, authorize } = require('../middleware/auth');

async function genBillNumber() {
  const n = new Date();
  const ym = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const last = await db.getOne("SELECT bill_number FROM sales ORDER BY id DESC LIMIT 1");
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

      // Validate stock & build processed items
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
        processed.push({ ...item, expiry_date: stock.expiry_date,
          cgst_percent: med.gst_rate/2, sgst_percent: med.gst_rate/2,
          total_amount: parseFloat((taxable+cgst+sgst).toFixed(2)) });
      }

      const discAmt   = parseFloat((subtotal * discount_percent / 100).toFixed(2));
      const afterDisc = subtotal - discAmt;
      const grandTotal= parseFloat((afterDisc + cgst_total + sgst_total).toFixed(2));
      const rounded   = Math.round(grandTotal);
      const roundOff  = parseFloat((rounded - grandTotal).toFixed(2));
      const finalTotal= rounded;
      const paid      = amount_paid !== undefined ? parseFloat(amount_paid) : finalTotal;
      const balance   = parseFloat((finalTotal - paid).toFixed(2));

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
      // Reverse inventory deduction
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

// GET /api/sales/:id/pdf — GST tax invoice PDF
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
       FROM sale_items si JOIN medicines m ON si.medicine_id=m.id WHERE si.sale_id=$1`,
      [sale.id]
    );
    const pharmacy = await db.getOne('SELECT * FROM pharmacy_info WHERE id=1');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${sale.bill_number}.pdf"`);

    const doc = new PDFKit({ margin: 40, size: 'A4' });
    doc.pipe(res);

    // Header
    doc.fontSize(15).font('Helvetica-Bold')
       .text(pharmacy?.name || 'PHARMACY', 40, 40, { align: 'center' });
    doc.fontSize(9).font('Helvetica')
       .text(`${pharmacy?.address || ''}, ${pharmacy?.city || ''}`, { align: 'center' })
       .text(`GST: ${pharmacy?.gst_number||''} | Drug Lic: ${pharmacy?.drug_license_number||''} | Ph: ${pharmacy?.phone||''}`, { align: 'center' });

    doc.moveTo(40, 90).lineTo(555, 90).strokeColor('#333').lineWidth(1).stroke();
    doc.fontSize(11).font('Helvetica-Bold').text('GST TAX INVOICE', { align: 'center' });
    doc.moveTo(40, 108).lineTo(555, 108).strokeColor('#333').lineWidth(0.5).stroke();

    // Bill meta
    doc.fontSize(9).font('Helvetica');
    const bdate = new Date(sale.bill_date).toLocaleString('en-IN');
    doc.text(`Bill No: ${sale.bill_number}`, 40, 115);
    doc.text(`Date: ${bdate}`, 40, 127);
    doc.text(`Payment: ${sale.payment_mode}`, 40, 139);
    if (sale.patient_name) {
      doc.text(`Patient: ${sale.patient_name}`, 300, 115);
      doc.text(`Phone: ${sale.patient_phone||'-'}`, 300, 127);
    }

    // Table header
    let y = 160;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#555').lineWidth(0.5).stroke();
    y += 4;
    const cx = { sno:40, name:60, batch:235, exp:285, qty:340, mrp:378, disc:418, gst:450, amt:500 };
    doc.fontSize(8).font('Helvetica-Bold');
    Object.entries({ sno:'#', name:'Medicine', batch:'Batch', exp:'Exp',
                     qty:'Qty', mrp:'MRP', disc:'Disc%', gst:'GST%', amt:'Amount' })
      .forEach(([k,v]) => doc.text(v, cx[k], y));
    y += 12;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#999').lineWidth(0.3).stroke();
    y += 4;

    doc.font('Helvetica').fontSize(8);
    for (const [i, item] of sale.items.entries()) {
      if (y > 720) { doc.addPage(); y = 40; }
      const exp = item.expiry_date
        ? new Date(item.expiry_date).toLocaleDateString('en-IN',{month:'2-digit',year:'2-digit'})
        : '';
      doc.text(i+1,           cx.sno,   y);
      doc.text(item.medicine_name, cx.name, y, { width:170, ellipsis:true });
      doc.text(item.batch_number,  cx.batch, y);
      doc.text(exp,                cx.exp,   y);
      doc.text(item.quantity,      cx.qty,   y);
      doc.text(parseFloat(item.mrp).toFixed(2), cx.mrp, y);
      doc.text(`${item.discount_percent||0}%`,  cx.disc, y);
      doc.text(`${parseFloat(item.cgst_percent||0)+parseFloat(item.sgst_percent||0)}%`, cx.gst, y);
      doc.text(parseFloat(item.total_amount).toFixed(2), cx.amt, y);
      y += 14;
    }

    doc.moveTo(40, y).lineTo(555, y).strokeColor('#555').lineWidth(0.3).stroke();
    y += 8;

    // Totals
    const lx=390, rx=550;
    const addRow = (label, val, bold=false) => {
      if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      doc.fontSize(9).text(label, lx, y).text(val, rx, y, { align:'right' });
      y += 14;
    };
    addRow('Subtotal:', `₹${parseFloat(sale.subtotal).toFixed(2)}`);
    if (parseFloat(sale.discount_amount) > 0)
      addRow(`Discount (${sale.discount_percent}%):`, `- ₹${parseFloat(sale.discount_amount).toFixed(2)}`);
    addRow('CGST:', `₹${parseFloat(sale.cgst_amount).toFixed(2)}`);
    addRow('SGST:', `₹${parseFloat(sale.sgst_amount).toFixed(2)}`);
    if (parseFloat(sale.round_off) !== 0)
      addRow('Round off:', `₹${parseFloat(sale.round_off).toFixed(2)}`);
    addRow('TOTAL:', `₹${parseFloat(sale.total_amount).toFixed(2)}`, true);

    y += 10;
    doc.fontSize(8).font('Helvetica').fillColor('#777')
       .text('Medicines once sold will not be returned/exchanged without valid prescription.', 40, y, { align:'center', width:515 });
    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;

const router  = require('express').Router();
const db      = require('../config/database');
const ExcelJS = require('exceljs');
const { authenticate, authorize } = require('../middleware/auth');

const ROLES = ['admin','manager','pharmacist'];

function hdr(ws, cols, bgHex) {
  ws.columns = cols;
  const row = ws.getRow(1);
  row.eachCell(cell => {
    cell.font  = { bold:true, color:{ argb:'FFFFFFFF' } };
    cell.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb: bgHex } };
    cell.alignment = { horizontal:'center', vertical:'middle' };
    cell.border = { bottom:{ style:'thin', color:{ argb:'FFCCCCCC' } } };
  });
  row.height = 22;
  ws.views = [{ state:'frozen', ySplit:1 }];
}

// GET /api/reports/mis?type=all|sales|inventory|shortstock|gst&date_from=&date_to=
router.get('/mis', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const { type='all' } = req.query;
    const df = req.query.date_from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dt = req.query.date_to   || new Date().toISOString().split('T')[0];

    const wb = new ExcelJS.Workbook();
    wb.creator = 'PharmaCare Pro';
    wb.created = new Date();

    const pharmacy = await db.getOne('SELECT * FROM pharmacy_info WHERE id=1');

    // Cover sheet
    const cover = wb.addWorksheet('Info');
    cover.getCell('A1').value = pharmacy?.name || 'PharmaCare';
    cover.getCell('A1').font = { bold:true, size:16 };
    cover.getCell('A2').value = `MIS Report: ${df} to ${dt}`;
    cover.getCell('A3').value = `Generated: ${new Date().toLocaleString('en-IN')}`;
    cover.getCell('A4').value = `GST No: ${pharmacy?.gst_number||''}`;

    // ── SALES ──────────────────────────────────────────────
    if (type==='all' || type==='sales') {
      const ws = wb.addWorksheet('Sales Report');
      hdr(ws, [
        { header:'Bill No',      key:'bill_number',    width:22 },
        { header:'Date',         key:'bill_date',      width:20 },
        { header:'Patient',      key:'patient_name',   width:22 },
        { header:'Payment Mode', key:'payment_mode',   width:14 },
        { header:'Subtotal',     key:'subtotal',       width:13 },
        { header:'Discount',     key:'discount_amount',width:13 },
        { header:'CGST',         key:'cgst_amount',    width:11 },
        { header:'SGST',         key:'sgst_amount',    width:11 },
        { header:'Total',        key:'total_amount',   width:13 },
        { header:'Status',       key:'payment_status', width:12 },
      ], 'FF1A5E3A');

      const rows = await db.getAll(
        `SELECT s.*, p.name AS patient_name FROM sales s
         LEFT JOIN patients p ON s.patient_id=p.id
         WHERE DATE(s.bill_date) BETWEEN $1 AND $2 AND s.is_cancelled=false
         ORDER BY s.bill_date`, [df, dt]
      );
      let totals = { subtotal:0, discount_amount:0, cgst_amount:0, sgst_amount:0, total_amount:0 };
      rows.forEach(r => {
        const row = ws.addRow({ ...r, bill_date: new Date(r.bill_date).toLocaleString('en-IN') });
        ['subtotal','discount_amount','cgst_amount','sgst_amount','total_amount'].forEach(k => {
          row.getCell(k).numFmt = '₹#,##0.00';
          totals[k] += parseFloat(r[k]||0);
        });
      });
      const tr = ws.addRow({ bill_number:`TOTAL (${rows.length} bills)`, ...totals });
      tr.font = { bold:true };
      tr.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8F5E9' } };
      ['subtotal','discount_amount','cgst_amount','sgst_amount','total_amount'].forEach(k =>
        tr.getCell(k).numFmt = '₹#,##0.00'
      );
    }

    // ── STOCK ──────────────────────────────────────────────
    if (type==='all' || type==='inventory') {
      const ws = wb.addWorksheet('Stock Report');
      hdr(ws, [
        { header:'Medicine',      key:'medicine_name',  width:30 },
        { header:'Generic',       key:'generic_name',   width:22 },
        { header:'Category',      key:'category',       width:16 },
        { header:'Batch',         key:'batch_number',   width:14 },
        { header:'Expiry',        key:'expiry_date',    width:12 },
        { header:'MRP',           key:'mrp',            width:10 },
        { header:'Purchase Rate', key:'purchase_rate',  width:14 },
        { header:'In',            key:'quantity_in',    width:8  },
        { header:'Out',           key:'quantity_out',   width:8  },
        { header:'Stock',         key:'current_qty',    width:10 },
        { header:'Value (MRP)',   key:'stock_value',    width:14 },
        { header:'Status',        key:'status',         width:14 },
      ], 'FF1A3A5E');

      const rows = await db.getAll(
        `SELECT inv.*,
                (inv.quantity_in - inv.quantity_out) AS current_qty,
                (inv.quantity_in - inv.quantity_out) * inv.mrp AS stock_value,
                m.name AS medicine_name, m.generic_name, m.category,
                m.reorder_level, m.min_stock
         FROM inventory inv JOIN medicines m ON inv.medicine_id=m.id
         ORDER BY m.name, inv.expiry_date`
      );
      rows.forEach(r => {
        const status = r.current_qty <= 0 ? 'OUT OF STOCK'
                     : r.current_qty < r.min_stock ? 'CRITICAL'
                     : r.current_qty <= r.reorder_level ? 'LOW' : 'OK';
        const row = ws.addRow({ ...r, status });
        ['mrp','purchase_rate','stock_value'].forEach(k => row.getCell(k).numFmt = '₹#,##0.00');
        const c = r.current_qty <= 0 ? 'FFFF4444'
                : r.current_qty < r.min_stock ? 'FFFFA500' : null;
        if (c) {
          ['current_qty','status'].forEach(k => {
            row.getCell(k).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:c } };
          });
        }
      });
    }

    // ── SHORT STOCK ────────────────────────────────────────
    if (type==='all' || type==='shortstock') {
      const ws = wb.addWorksheet('Short & Negative Stock');
      hdr(ws, [
        { header:'Medicine',     key:'name',          width:30 },
        { header:'Category',     key:'category',      width:16 },
        { header:'Total Stock',  key:'total_stock',   width:13 },
        { header:'Reorder Level',key:'reorder_level', width:14 },
        { header:'Min Stock',    key:'min_stock',     width:11 },
        { header:'Nearest Expiry',key:'nearest_expiry',width:14},
        { header:'Alert',        key:'alert',         width:16 },
      ], 'FF7B1A1A');

      const rows = await db.getAll(
        `SELECT m.id, m.name, m.category, m.reorder_level, m.min_stock,
                COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) AS total_stock,
                MIN(inv.expiry_date) AS nearest_expiry
         FROM medicines m LEFT JOIN inventory inv ON m.id=inv.medicine_id
         WHERE m.is_active=true
         GROUP BY m.id
         HAVING COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) <= m.reorder_level
         ORDER BY total_stock ASC`
      );
      rows.forEach(r => {
        const alert = r.total_stock <= 0 ? '⚠ OUT / NEGATIVE'
                    : r.total_stock < r.min_stock ? '⛔ CRITICAL' : '⚠ LOW';
        const row = ws.addRow({ ...r, alert });
        const c = r.total_stock <= 0 ? 'FFFF4444' : r.total_stock < r.min_stock ? 'FFFFA500' : 'FFFFFF99';
        row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:c } };
      });
    }

    // ── GST SUMMARY ────────────────────────────────────────
    if (type==='all' || type==='gst') {
      const ws = wb.addWorksheet('GST Summary');
      hdr(ws, [
        { header:'GST Rate',     key:'gst_rate',     width:12 },
        { header:'HSN Code',     key:'hsn_code',     width:14 },
        { header:'Taxable Amt',  key:'taxable',      width:15 },
        { header:'CGST',         key:'cgst',         width:12 },
        { header:'SGST',         key:'sgst',         width:12 },
        { header:'Total GST',    key:'total_gst',    width:12 },
        { header:'Total Billed', key:'total',        width:14 },
      ], 'FF4A1A7E');

      const rows = await db.getAll(
        `SELECT m.gst_rate, m.hsn_code,
                SUM(si.total_amount / (1 + m.gst_rate/100)) AS taxable,
                SUM(si.total_amount / (1 + m.gst_rate/100) * (m.gst_rate/200)) AS cgst,
                SUM(si.total_amount / (1 + m.gst_rate/100) * (m.gst_rate/200)) AS sgst,
                SUM(si.total_amount / (1 + m.gst_rate/100) * (m.gst_rate/100)) AS total_gst,
                SUM(si.total_amount) AS total
         FROM sale_items si
         JOIN medicines m ON si.medicine_id=m.id
         JOIN sales s ON si.sale_id=s.id
         WHERE DATE(s.bill_date) BETWEEN $1 AND $2 AND s.is_cancelled=false
         GROUP BY m.gst_rate, m.hsn_code
         ORDER BY m.gst_rate`, [df, dt]
      );
      rows.forEach(r => {
        const row = ws.addRow(r);
        ['taxable','cgst','sgst','total_gst','total'].forEach(k =>
          row.getCell(k).numFmt = '₹#,##0.00'
        );
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MIS-${df}-${dt}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// GET /api/reports/shortstock — JSON
router.get('/shortstock', authenticate, async (req, res, next) => {
  try {
    res.json(await db.getAll(
      `SELECT m.id, m.name, m.generic_name, m.category, m.barcode,
              m.reorder_level, m.min_stock,
              COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) AS total_stock,
              MIN(inv.expiry_date) AS nearest_expiry,
              COUNT(DISTINCT inv.batch_number) AS batches
       FROM medicines m LEFT JOIN inventory inv ON m.id=inv.medicine_id
       WHERE m.is_active=true
       GROUP BY m.id
       HAVING COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) <= m.reorder_level
       ORDER BY total_stock ASC`
    ));
  } catch (err) { next(err); }
});

// GET /api/reports/expiring?days=90
router.get('/expiring', authenticate, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '90');
    res.json(await db.getAll(
      `SELECT inv.*, m.name AS medicine_name, m.generic_name,
              (inv.quantity_in - inv.quantity_out) AS current_qty,
              inv.expiry_date - CURRENT_DATE AS days_to_expiry
       FROM inventory inv JOIN medicines m ON inv.medicine_id=m.id
       WHERE (inv.quantity_in - inv.quantity_out) > 0
         AND inv.expiry_date <= CURRENT_DATE + ($1 * INTERVAL '1 day')
       ORDER BY inv.expiry_date ASC`, [days]
    ));
  } catch (err) { next(err); }
});

// GET /api/reports/gst?date_from=&date_to=
router.get('/gst', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const df = req.query.date_from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dt = req.query.date_to   || new Date().toISOString().split('T')[0];
    const rows = await db.getAll(
      `SELECT m.gst_rate, m.hsn_code,
              SUM(si.total_amount / (1 + m.gst_rate/100)) AS taxable_value,
              SUM(si.total_amount / (1 + m.gst_rate/100) * (m.gst_rate/200)) AS cgst,
              SUM(si.total_amount / (1 + m.gst_rate/100) * (m.gst_rate/200)) AS sgst,
              SUM(si.total_amount) AS total_billed
       FROM sale_items si
       JOIN medicines m ON si.medicine_id=m.id
       JOIN sales s ON si.sale_id=s.id
       WHERE DATE(s.bill_date) BETWEEN $1 AND $2 AND s.is_cancelled=false
       GROUP BY m.gst_rate, m.hsn_code ORDER BY m.gst_rate`, [df, dt]
    );
    res.json({ period:{ from:df, to:dt }, data:rows });
  } catch (err) { next(err); }
});

module.exports = router;

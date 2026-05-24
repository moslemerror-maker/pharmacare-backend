const router = require('express').Router();
const db     = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res, next) => {
  try {
    const today      = new Date().toISOString().split('T')[0];
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                         .toISOString().split('T')[0];

    const [
      todaySales, monthSales, pendingRx,
      lowStockCount, expiringCount, outOfStockCount,
      salesTrend, topMedicines, paymentBreakdown, recentRx
    ] = await Promise.all([

      db.getOne(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount
         FROM sales WHERE DATE(bill_date)=$1 AND is_cancelled=false`, [today]
      ),
      db.getOne(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount
         FROM sales WHERE DATE(bill_date) >= $1 AND is_cancelled=false`, [monthStart]
      ),
      db.getOne(
        "SELECT COUNT(*) AS count FROM prescriptions WHERE status='Active'"
      ),
      db.getOne(
        `SELECT COUNT(DISTINCT medicine_id) AS count FROM (
           SELECT i.medicine_id,
                  SUM(i.quantity_in - i.quantity_out) AS stock,
                  m.reorder_level
           FROM inventory i JOIN medicines m ON i.medicine_id=m.id
           GROUP BY i.medicine_id, m.reorder_level
           HAVING SUM(i.quantity_in - i.quantity_out) > 0
              AND SUM(i.quantity_in - i.quantity_out) <= m.reorder_level
         ) AS t`
      ),
      db.getOne(
        `SELECT COUNT(*) AS count FROM inventory
         WHERE (quantity_in - quantity_out) > 0
           AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`
      ),
      db.getOne(
        `SELECT COUNT(DISTINCT m.id) AS count FROM medicines m
         WHERE m.is_active=true
           AND COALESCE((
             SELECT SUM(i.quantity_in - i.quantity_out)
             FROM inventory i WHERE i.medicine_id=m.id
           ),0) <= 0`
      ),
      db.getAll(
        `SELECT DATE(bill_date) AS date,
                COUNT(*) AS bills,
                COALESCE(SUM(total_amount),0) AS amount
         FROM sales
         WHERE DATE(bill_date) >= CURRENT_DATE - INTERVAL '6 days'
           AND is_cancelled=false
         GROUP BY DATE(bill_date) ORDER BY date`
      ),
      db.getAll(
        `SELECT m.name, m.generic_name,
                SUM(si.quantity) AS qty,
                SUM(si.total_amount) AS revenue
         FROM sale_items si
         JOIN medicines m ON si.medicine_id=m.id
         JOIN sales s ON si.sale_id=s.id
         WHERE DATE(s.bill_date) >= $1 AND s.is_cancelled=false
         GROUP BY si.medicine_id, m.name, m.generic_name
         ORDER BY revenue DESC LIMIT 10`, [monthStart]
      ),
      db.getAll(
        `SELECT payment_mode, COUNT(*) AS count, SUM(total_amount) AS amount
         FROM sales WHERE DATE(bill_date)=$1 AND is_cancelled=false
         GROUP BY payment_mode`, [today]
      ),
      db.getAll(
        `SELECT pr.rx_number, pr.visit_date, pr.status,
                pt.name AS patient_name, u.name AS doctor_name
         FROM prescriptions pr
         JOIN patients pt ON pr.patient_id=pt.id
         JOIN users u ON pr.doctor_id=u.id
         WHERE pr.status='Active'
         ORDER BY pr.visit_date DESC LIMIT 5`
      ),
    ]);

    res.json({
      today:  { sales: todaySales,  date: today },
      month:  { sales: monthSales,  from: monthStart },
      alerts: {
        pendingRx:   parseInt(pendingRx.count),
        lowStock:    parseInt(lowStockCount.count),
        expiring30:  parseInt(expiringCount.count),
        outOfStock:  parseInt(outOfStockCount.count),
      },
      salesTrend,
      topMedicines,
      paymentBreakdown,
      recentRx,
    });
  } catch (err) { next(err); }
});

module.exports = router;

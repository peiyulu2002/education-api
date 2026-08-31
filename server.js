/**
 * Pretty English - Backend Server
 * Node.js + Express + PostgreSQL (pg)
 * 腾讯云 CloudBase PostgreSQL 模式环境（education-app）
 *
 * 数据库连接通过环境变量（服务端直连，不硬编码密码）：
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
 *   PGSSL 设为 'false' 可关闭 SSL（默认开启，CloudBase 托管 PG 通常需要）
 *
 * API Endpoints:
 *   POST   /api/login                 - Admin login
 *   GET    /api/students              - List all students
 *   POST   /api/students              - Create student
 *   PUT    /api/students/:id          - Update student
 *   DELETE /api/students/:id          - Delete student
 *   GET    /api/students/:id          - Student detail (with purchases + deductions)
 *   GET    /api/billing               - Billing summary (all students)
 *   GET    /api/purchases             - List all purchases (payment records)
 *   POST   /api/purchases             - Create purchase (buy hours)
 *   GET    /api/deductions            - List all deductions (lesson records)
 *   POST   /api/deductions            - Create deduction (use hours)
 *   GET    /api/events                - List all calendar events
 *   POST   /api/events                - Create event
 *   PUT    /api/events/:id            - Update event
 *   DELETE /api/events/:id            - Delete event
 *   GET    /api/dashboard             - Dashboard stats
 */

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== Database Setup (CloudBase PostgreSQL, env-driven) =====
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});
const db = pool; // alias for minimal diff in query calls

// ===== Init schema + seed admin =====
async function initDB() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    await db.query(stmt);
  }
  const adminResult = await db.query('SELECT COUNT(*)::int as count FROM admins');
  if (adminResult.rows[0].count === 0) {
    const hashed = bcrypt.hashSync('admin123', 10);
    await db.query('INSERT INTO admins (username, password, name) VALUES ($1, $2, $3)', ['admin', hashed, 'Admin']);
  }
  console.log('Database initialized.');
}

// ===== Auth =====
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = (await db.query('SELECT * FROM admins WHERE username = $1', [username])).rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid username or password' });
    if (!bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.json({ id: admin.id, username: admin.username, name: admin.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Students =====
app.get('/api/students', async (req, res) => {
  try {
    const students = (await db.query('SELECT * FROM students ORDER BY created_at DESC')).rows;
    const result = [];
    for (const s of students) {
      const purchases = (await db.query('SELECT * FROM purchases WHERE student_id = $1', [s.id])).rows;
      const deductions = (await db.query('SELECT * FROM deductions WHERE student_id = $1', [s.id])).rows;
      const totalHours = purchases.reduce((sum, p) => sum + p.total_hours, 0);
      const usedHours = deductions.reduce((sum, d) => sum + d.hours, 0);
      result.push({ ...s, remaining_hours: totalHours - usedHours, used_hours: usedHours, has_purchased: purchases.length > 0 });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/students/:id', async (req, res) => {
  try {
    const s = (await db.query('SELECT * FROM students WHERE id = $1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'Student not found' });
    const purchases = (await db.query('SELECT * FROM purchases WHERE student_id = $1 ORDER BY date DESC', [s.id])).rows;
    const deductions = (await db.query('SELECT * FROM deductions WHERE student_id = $1 ORDER BY date DESC', [s.id])).rows;
    const totalHours = purchases.reduce((sum, p) => sum + p.total_hours, 0);
    const usedHours = deductions.reduce((sum, d) => sum + d.hours, 0);
    const totalPaid = purchases.reduce((sum, p) => sum + p.amount, 0);
    res.json({ ...s, remaining_hours: totalHours - usedHours, used_hours: usedHours, total_paid: totalPaid, purchases, deductions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, grade, address, need, feedback } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const info = await db.query('INSERT INTO students (name, grade, address, need, feedback) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, grade || '', address || '', need || '', feedback || '']);
    res.json({ id: info.rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { name, grade, address, need, feedback } = req.body;
    await db.query('UPDATE students SET name=$1, grade=$2, address=$3, need=$4, feedback=$5 WHERE id=$6', [name, grade || '', address || '', need || '', feedback || '', req.params.id]);
    res.json({ id: parseInt(req.params.id), ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Purchases =====
app.get('/api/purchases', async (req, res) => {
  try {
    // purchases.date 是 TIMESTAMP，PG 返回 Date 对象；转成 text 保持前端格式一致
    const rows = (await db.query(`
      SELECT p.id, p.student_id, p.amount, p.total_hours, p.note, p.date::text AS date,
             s.name as student_name, s.grade as student_grade
      FROM purchases p LEFT JOIN students s ON p.student_id = s.id
      ORDER BY p.date DESC
    `)).rows;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/purchases', async (req, res) => {
  try {
    const { student_id, amount, total_hours, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!total_hours || total_hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
    const info = await db.query('INSERT INTO purchases (student_id, amount, total_hours, note) VALUES ($1,$2,$3,$4) RETURNING id', [student_id, amount, total_hours, note || '']);
    res.json({ id: info.rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Deductions =====
app.get('/api/deductions', async (req, res) => {
  try {
    const rows = (await db.query(`
      SELECT d.*, s.name as student_name, s.grade as student_grade
      FROM deductions d LEFT JOIN students s ON d.student_id = s.id
      ORDER BY d.date DESC
    `)).rows;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/deductions', async (req, res) => {
  try {
    const { student_id, hours, date, note } = req.body;
    if (!hours || hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
    const purchases = (await db.query('SELECT * FROM purchases WHERE student_id = $1', [student_id])).rows;
    const deductions = (await db.query('SELECT * FROM deductions WHERE student_id = $1', [student_id])).rows;
    const remaining = purchases.reduce((s, p) => s + p.total_hours, 0) - deductions.reduce((s, d) => sum + d.hours, 0);
    if (hours > remaining) return res.status(400).json({ error: `Not enough hours! Remaining: ${remaining}` });
    const info = await db.query('INSERT INTO deductions (student_id, hours, date, note) VALUES ($1,$2,$3,$4) RETURNING id', [student_id, hours, date, note || '']);
    res.json({ id: info.rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Events =====
app.get('/api/events', async (req, res) => {
  try {
    const rows = (await db.query(`
      SELECT e.*, s.name as student_name
      FROM events e LEFT JOIN students s ON e.student_id = s.id
      ORDER BY e.date ASC
    `)).rows;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { type, student_id, date, time, title } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const info = await db.query('INSERT INTO events (type, student_id, date, time, title) VALUES ($1,$2,$3,$4,$5) RETURNING id', [type || 'lesson', student_id || null, date, time || '', title || '']);
    res.json({ id: info.rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const { type, student_id, date, time, title } = req.body;
    await db.query('UPDATE events SET type=$1, student_id=$2, date=$3, time=$4, title=$5 WHERE id=$6', [type || 'lesson', student_id || null, date, time || '', title || '', req.params.id]);
    res.json({ id: parseInt(req.params.id), ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Billing Summary =====
app.get('/api/billing', async (req, res) => {
  try {
    const students = (await db.query('SELECT * FROM students ORDER BY name')).rows;
    const result = [];
    for (const s of students) {
      const purchases = (await db.query('SELECT * FROM purchases WHERE student_id = $1', [s.id])).rows;
      const deductions = (await db.query('SELECT * FROM deductions WHERE student_id = $1', [s.id])).rows;
      const totalAmount = purchases.reduce((sum, p) => sum + p.amount, 0);
      const totalHours = purchases.reduce((sum, p) => sum + p.total_hours, 0);
      const usedHours = deductions.reduce((sum, d) => sum + d.hours, 0);
      const remaining = totalHours - usedHours;
      const unitPrice = totalHours > 0 ? Math.round(totalAmount / totalHours) : 0;
      result.push({ ...s, total_amount: totalAmount, total_hours: totalHours, used_hours: usedHours, remaining_hours: remaining, unit_price: unitPrice, has_purchased: purchases.length > 0 });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Dashboard =====
app.get('/api/dashboard', async (req, res) => {
  try {
    const studentCount = (await db.query('SELECT COUNT(*)::int as count FROM students')).rows[0].count;
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${year}-${month}`;
    const monthEvents = (await db.query('SELECT COUNT(*)::int as count FROM events WHERE date LIKE $1', [monthPrefix + '%'])).rows[0].count;
    const totalRevenue = (await db.query('SELECT COALESCE(SUM(amount), 0)::numeric as total FROM purchases')).rows[0].total;
    const allStudents = (await db.query('SELECT * FROM students')).rows;
    const warnings = [];
    for (const s of allStudents) {
      const purchases = (await db.query('SELECT * FROM purchases WHERE student_id = $1', [s.id])).rows;
      const deductions = (await db.query('SELECT * FROM deductions WHERE student_id = $1', [s.id])).rows;
      const remaining = purchases.reduce((sum, p) => sum + p.total_hours, 0) - deductions.reduce((sum, d) => sum + d.hours, 0);
      if (remaining <= 3) {
        warnings.push({ id: s.id, name: s.name, grade: s.grade, remaining_hours: remaining });
      }
    }

    const todayStr = now.toISOString().slice(0, 10);
    const todayEvents = (await db.query(`
      SELECT e.*, s.name as student_name FROM events e
      LEFT JOIN students s ON e.student_id = s.id
      WHERE e.date = $1
    `, [todayStr])).rows;

    res.json({
      student_count: studentCount,
      month_events: monthEvents,
      total_revenue: totalRevenue,
      warning_count: warnings.length,
      warnings,
      today_events: todayEvents
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Serve static files (frontend) =====
const frontendDir = path.join(__dirname, 'public');
if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
}

// Start
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pretty English server running on port ${PORT}`);
  });
}).catch(e => {
  console.error('Failed to initialize database:', e);
  process.exit(1);
});

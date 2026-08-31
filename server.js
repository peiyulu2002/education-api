/**
 * Pretty English - Backend Server
 * Node.js + Express + CloudBase PostgreSQL (PostgREST HTTP API)
 * 腾讯云 CloudBase PostgreSQL 模式环境（education-app，共享集群）
 *
 * 共享集群不提供 PostgreSQL 直连地址，因此不使用 pg 驱动，
 * 改为调用 CloudBase 官方 PostgREST Data API：
 *   https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<table>
 * 认证：Authorization: Bearer <API Key>（service_role，仅在服务端使用）
 *
 * 必须通过环境变量配置（不硬编码）：
 *   TCB_ENV_ID   - CloudBase 环境 ID（如 education-app）
 *   TCB_API_KEY  - CloudBase API Key（service_role，拥有服务端全量权限）
 *   TCB_API_BASE - （可选）覆盖网关地址，默认 https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest
 *
 * 注意：PostgREST 只能做表的增删改查，无法执行建表 DDL。
 * 五张表必须先到 CloudBase 控制台「SQL 编辑器」执行 schema.sql 创建。
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
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== CloudBase PostgreSQL (PostgREST HTTP API) =====
const TCB_ENV_ID = process.env.TCB_ENV_ID;
const TCB_API_KEY = process.env.TCB_API_KEY; // service_role API Key
const TCB_API_BASE = (process.env.TCB_API_BASE ||
  `https://${TCB_ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`).replace(/\/+$/, '');

if (!TCB_ENV_ID || !TCB_API_KEY) {
  console.warn('[WARN] TCB_ENV_ID and/or TCB_API_KEY are not set. DB calls will fail until configured.');
}

/**
 * Call the CloudBase PostgREST Data API.
 * @param {string} table  - table name (path segment)
 * @param {object} opts
 *   method  - GET | POST | PATCH | DELETE (default GET)
 *   query   - raw query string (e.g. "id=eq.5&order=created_at.desc")
 *   body    - object to send as JSON (POST/PATCH)
 *   prefer  - PostgREST Prefer header value (e.g. "return=representation")
 * @returns {Array|Object} parsed JSON
 */
async function api(table, { method = 'GET', query = '', body = null, prefer = null } = {}) {
  const url = `${TCB_API_BASE}/${table}${query ? `?${query}` : ''}`;
  const headers = {
    'Authorization': `Bearer ${TCB_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || j.error || JSON.stringify(j);
    } catch (_) { /* ignore */ }
    throw new Error(`CloudBase PG API ${res.status} on ${table}: ${detail}`);
  }
  const text = await res.text();
  if (!text) return [];
  try { return JSON.parse(text); } catch (_) { return []; }
}

// Build an equality filter, URL-encoding the value (keeps operators like "eq." intact)
function eq(col, val) {
  return `${col}=eq.${encodeURIComponent(val)}`;
}

// PostgREST returns TIMESTAMP columns as "2026-08-31T15:00:00" (or with Z).
// Normalize to the previous pg "::text" style "2026-08-31 15:00:00" so the
// frontend (which does String(date).slice(0,10)) keeps behaving identically.
// TEXT columns like "2026-08-31" have no "T" and are returned unchanged.
function fmtTs(v) {
  if (typeof v !== 'string') return v;
  return v.replace('T', ' ').replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
}

const num = (v) => Number(v || 0);

// ===== Init: seed default admin (best-effort; tables must already exist) =====
async function ensureAdmin() {
  try {
    const admins = await api('admins', { query: 'select=id' });
    if (!admins || admins.length === 0) {
      const hashed = bcrypt.hashSync('admin123', 10);
      await api('admins', {
        method: 'POST',
        body: { username: 'admin', password: hashed, name: 'Admin' },
        prefer: 'return=representation',
      });
      console.log('Seeded default admin (admin / admin123)');
    }
  } catch (e) {
    console.warn('Admin seed skipped (tables may not exist yet in CloudBase):', e.message);
  }
}

// ===== Auth =====
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const rows = await api('admins', { query: eq('username', username) });
    const admin = rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid username or password' });
    if (!bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.json({ id: admin.id, username: admin.username, name: admin.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Students =====
app.get('/api/students', async (req, res) => {
  try {
    const students = await api('students', { query: 'order=created_at.desc' });
    const purchases = await api('purchases', { query: 'select=student_id,total_hours' });
    const deductions = await api('deductions', { query: 'select=student_id,hours' });
    const purMap = {}, dedMap = {};
    purchases.forEach(p => { purMap[p.student_id] = (purMap[p.student_id] || 0) + num(p.total_hours); });
    deductions.forEach(d => { dedMap[d.student_id] = (dedMap[d.student_id] || 0) + num(d.hours); });
    const result = students.map(s => {
      const totalHours = purMap[s.id] || 0;
      const usedHours = dedMap[s.id] || 0;
      return {
        ...s,
        remaining_hours: totalHours - usedHours,
        used_hours: usedHours,
        has_purchased: (purMap[s.id] || 0) > 0,
      };
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.get('/api/students/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const sRows = await api('students', { query: eq('id', id) });
    const s = sRows[0];
    if (!s) return res.status(404).json({ error: 'Student not found' });
    const purchases = (await api('purchases', { query: `${eq('student_id', id)}&order=date.desc` }))
      .map(p => ({ ...p, date: fmtTs(p.date) }));
    const deductions = (await api('deductions', { query: `${eq('student_id', id)}&order=date.desc` }))
      .map(d => ({ ...d, date: fmtTs(d.date) }));
    const totalHours = purchases.reduce((a, p) => a + num(p.total_hours), 0);
    const usedHours = deductions.reduce((a, d) => a + num(d.hours), 0);
    const totalPaid = purchases.reduce((a, p) => a + num(p.amount), 0);
    res.json({
      ...s,
      remaining_hours: totalHours - usedHours,
      used_hours: usedHours,
      total_paid: Math.round(totalPaid * 100) / 100,
      purchases,
      deductions,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, grade, address, need, feedback } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const rows = await api('students', {
      method: 'POST',
      body: {
        name,
        grade: grade || '',
        address: address || '',
        need: need || '',
        feedback: feedback || '',
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { name, grade, address, need, feedback } = req.body;
    await api('students', {
      method: 'PATCH',
      query: eq('id', req.params.id),
      body: {
        name,
        grade: grade || '',
        address: address || '',
        need: need || '',
        feedback: feedback || '',
      },
    });
    res.json({ id: parseInt(req.params.id, 10), ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await api('students', { method: 'DELETE', query: eq('id', req.params.id) });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Purchases =====
app.get('/api/purchases', async (req, res) => {
  try {
    const rows = await api('purchases', { query: 'order=date.desc' });
    const students = await api('students', { query: 'select=id,name,grade' });
    const smap = {};
    students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });
    const result = rows.map(p => ({
      ...p,
      date: fmtTs(p.date),
      student_name: p.student_id != null ? (smap[p.student_id] ? smap[p.student_id].name : null) : null,
      student_grade: p.student_id != null ? (smap[p.student_id] ? smap[p.student_id].grade : null) : null,
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/purchases', async (req, res) => {
  try {
    const { student_id, amount, total_hours, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!total_hours || total_hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
    const rows = await api('purchases', {
      method: 'POST',
      body: {
        student_id: num(student_id),
        amount: num(amount),
        total_hours: num(total_hours),
        note: note || '',
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Deductions =====
app.get('/api/deductions', async (req, res) => {
  try {
    const rows = await api('deductions', { query: 'order=date.desc' });
    const students = await api('students', { query: 'select=id,name,grade' });
    const smap = {};
    students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });
    const result = rows.map(d => ({
      ...d,
      student_name: d.student_id != null ? (smap[d.student_id] ? smap[d.student_id].name : null) : null,
      student_grade: d.student_id != null ? (smap[d.student_id] ? smap[d.student_id].grade : null) : null,
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/deductions', async (req, res) => {
  try {
    const { student_id, hours, date, note } = req.body;
    if (!hours || hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
    const pur = await api('purchases', { query: eq('student_id', student_id) });
    const ded = await api('deductions', { query: eq('student_id', student_id) });
    const remaining = pur.reduce((a, p) => a + num(p.total_hours), 0) - ded.reduce((a, d) => a + num(d.hours), 0);
    if (hours > remaining) return res.status(400).json({ error: `Not enough hours! Remaining: ${remaining}` });
    const rows = await api('deductions', {
      method: 'POST',
      body: {
        student_id: num(student_id),
        hours: num(hours),
        date,
        note: note || '',
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Events =====
app.get('/api/events', async (req, res) => {
  try {
    const rows = await api('events', { query: 'order=date.asc' });
    const students = await api('students', { query: 'select=id,name' });
    const smap = {};
    students.forEach(s => { smap[s.id] = s.name; });
    const result = rows.map(e => ({
      ...e,
      student_name: e.student_id != null ? (smap[e.student_id] != null ? smap[e.student_id] : null) : null,
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { type, student_id, date, time, title } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const rows = await api('events', {
      method: 'POST',
      body: {
        type: type || 'lesson',
        student_id: student_id != null ? num(student_id) : null,
        date,
        time: time || '',
        title: title || '',
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const { type, student_id, date, time, title } = req.body;
    await api('events', {
      method: 'PATCH',
      query: eq('id', req.params.id),
      body: {
        type: type || 'lesson',
        student_id: student_id != null ? num(student_id) : null,
        date,
        time: time || '',
        title: title || '',
      },
    });
    res.json({ id: parseInt(req.params.id, 10), ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await api('events', { method: 'DELETE', query: eq('id', req.params.id) });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Billing Summary =====
app.get('/api/billing', async (req, res) => {
  try {
    const students = await api('students', { query: 'order=name.asc' });
    const purchases = await api('purchases', { query: 'select=student_id,amount,total_hours' });
    const deductions = await api('deductions', { query: 'select=student_id,hours' });
    const purMap = {}, amtMap = {}, dedMap = {};
    purchases.forEach(p => {
      purMap[p.student_id] = (purMap[p.student_id] || 0) + num(p.total_hours);
      amtMap[p.student_id] = (amtMap[p.student_id] || 0) + num(p.amount);
    });
    deductions.forEach(d => { dedMap[d.student_id] = (dedMap[d.student_id] || 0) + num(d.hours); });
    const result = students.map(s => {
      const totalAmount = amtMap[s.id] || 0;
      const totalHours = purMap[s.id] || 0;
      const usedHours = dedMap[s.id] || 0;
      const remaining = totalHours - usedHours;
      const unitPrice = totalHours > 0 ? Math.round(totalAmount / totalHours) : 0;
      return {
        ...s,
        total_amount: Math.round(totalAmount * 100) / 100,
        total_hours: totalHours,
        used_hours: usedHours,
        remaining_hours: remaining,
        unit_price: unitPrice,
        has_purchased: (purMap[s.id] || 0) > 0,
      };
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Dashboard =====
app.get('/api/dashboard', async (req, res) => {
  try {
    const students = await api('students', { query: 'select=id,name,grade' });
    const studentCount = students.length;
    const smap = {};
    students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${y}-${m}`;
    const todayStr = now.toISOString().slice(0, 10);

    const monthEventsRows = await api('events', { query: `date=like.${encodeURIComponent(monthPrefix + '%')}&select=id` });
    const monthEvents = monthEventsRows.length;

    const purchases = await api('purchases', { query: 'select=student_id,amount,total_hours' });
    const deductions = await api('deductions', { query: 'select=student_id,hours' });
    const totalRevenue = Math.round(purchases.reduce((a, p) => a + num(p.amount), 0) * 100) / 100;

    const purMap = {}, dedMap = {};
    purchases.forEach(p => { purMap[p.student_id] = (purMap[p.student_id] || 0) + num(p.total_hours); });
    deductions.forEach(d => { dedMap[d.student_id] = (dedMap[d.student_id] || 0) + num(d.hours); });

    const warnings = [];
    for (const s of students) {
      const remaining = (purMap[s.id] || 0) - (dedMap[s.id] || 0);
      if (remaining <= 3) {
        warnings.push({ id: s.id, name: smap[s.id].name, grade: smap[s.id].grade, remaining_hours: remaining });
      }
    }

    const todayRows = await api('events', { query: eq('date', todayStr) });
    const todayEvents = todayRows.map(e => ({
      ...e,
      student_name: e.student_id != null ? (smap[e.student_id] != null ? smap[e.student_id].name : null) : null,
    }));

    res.json({
      student_count: studentCount,
      month_events: monthEvents,
      total_revenue: totalRevenue,
      warning_count: warnings.length,
      warnings,
      today_events: todayEvents,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Serve static files (frontend) =====
const candidate1 = path.join(__dirname, 'public');
const candidate2 = path.join(__dirname, '..', 'public');
const frontendDir = fs.existsSync(candidate1) ? candidate1 : candidate2;
if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
}

// Start
ensureAdmin().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pretty English server running on port ${PORT}`);
  });
});

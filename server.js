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
 *   SESSION_SECRET - （必填）JWT 签名密钥（>=32 位随机字符串，仅服务端）
 *   JWT_TTL     - （可选）登录有效期，默认 7d
 *   APP_ORIGIN  - （可选）前端来源，用于 CORS credentials；不填则反射请求来源
 *   COOKIE_SAMESITE - （可选）cookie SameSite，默认 lax（跨域托管前端时改 none）
 *
 * 注意：PostgREST 只能做表的增删改查，无法执行建表 DDL。
 * 表结构（含 users 与 teacher_id 列）必须先到 CloudBase 控制台「SQL 编辑器」执行 schema.sql + schema_v2.sql。
 *
 * 认证：HttpOnly + Secure + SameSite cookie（JWT）。后端每个受保护接口都校验 token + 角色 + 作用域。
 *
 * API Endpoints:
 *   POST   /api/login                 - 登录（公开），成功后下发 HttpOnly cookie
 *   POST   /api/logout                - 退出（清 cookie）
 *   GET    /api/me                    - 当前登录用户（id/role/name）
 *   POST   /api/teachers              - 创建老师账号（仅 Admin）
 *   GET    /api/teachers              - 老师列表（仅 Admin）
 *   GET    /api/students              - 学生列表（Admin 全部 / Teacher 本人学生，财务字段已剥离）
 *   POST   /api/students              - 新建学生（仅 Admin，自动归属唯一老师）
 *   PUT    /api/students/:id          - 更新学生（Admin 全字段 / Teacher 仅 feedback）
 *   DELETE /api/students/:id          - 删除学生（仅 Admin）
 *   GET    /api/students/:id          - 学生详情（Admin 含购课/付费 / Teacher 不含财务）
 *   GET    /api/purchases             - 购课/收费记录（仅 Admin）
 *   POST   /api/purchases             - 新建购课（仅 Admin）
 *   GET    /api/deductions            - 上课扣课记录（Admin 全部 / Teacher 本人学生）
 *   POST   /api/deductions            - 新建扣课（Admin 任意 / Teacher 仅本人学生，记 teacher_id）
 *   GET    /api/billing               - 收费汇总（仅 Admin）
 *   GET    /api/events                - 日历事件（Admin 全部 / Teacher 本人）
 *   POST   /api/events                - 新建事件（Admin 任意 / Teacher 本人，记 teacher_id）
 *   PUT    /api/events/:id            - 更新事件（Admin 任意 / Teacher 仅本人）
 *   DELETE /api/events/:id            - 删除事件（Admin 任意 / Teacher 仅本人）
 *   GET    /api/dashboard             - 工作台统计（Admin 含营收 / Teacher 不含营收）
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors({ origin: process.env.APP_ORIGIN || true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// ===== CloudBase PostgreSQL (PostgREST HTTP API) =====
const TCB_ENV_ID = process.env.TCB_ENV_ID;
const TCB_API_KEY = process.env.TCB_API_KEY; // service_role API Key
const TCB_API_BASE = (process.env.TCB_API_BASE ||
  `https://${TCB_ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`).replace(/\/+$/, '');

// ===== Auth config =====
const SESSION_SECRET = process.env.SESSION_SECRET;
const JWT_TTL = process.env.JWT_TTL || '7d';
const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || 'lax';

if (!TCB_ENV_ID || !TCB_API_KEY) {
  console.warn('[WARN] TCB_ENV_ID and/or TCB_API_KEY are not set. DB calls will fail until configured.');
}
if (!SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET is not set. Authentication will fail until configured.');
}

/**
 * Call the CloudBase PostgREST Data API.
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

/**
 * Verify a JWT from the HttpOnly cookie and attach req.user = { uid, role }.
 * Every protected route must use this. UI hiding is NOT a security boundary.
 */
function auth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    req.user = { uid: payload.uid, role: payload.role };
    next();
  } catch (_) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// Restrict to specific roles. Use after auth().
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

const isTeacher = (req) => req.user && req.user.role === 'teacher';
const meId = (req) => req.user.uid;

// PostgREST returns TIMESTAMP columns as "2026-08-31T15:00:00". Normalize to "2026-08-31 15:00:00".
function fmtTs(v) {
  if (typeof v !== 'string') return v;
  return v.replace('T', ' ').replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
}

const num = (v) => Number(v || 0);

// Convert JWT_TTL (e.g. "7d") to milliseconds for the cookie Max-Age.
function ttlToMs(ttl) {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 7 * 24 * 3600 * 1000;
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * mult;
}

// Look up the single teacher's users.id (used as default teacher_id for new students).
async function defaultTeacherId() {
  const rows = await api('users', { query: 'role=eq.teacher&select=id&limit=1' });
  return (rows && rows[0]) ? rows[0].id : null;
}

// Student ids assigned to the current teacher (for scoping reads/writes).
async function myStudentIds(req) {
  const rows = await api('students', { query: `${eq('teacher_id', meId(req))}&select=id` });
  return rows.map(r => r.id);
}

// ===== Init: seed default admin into users (best-effort; tables must already exist) =====
async function ensureUsers() {
  try {
    const rows = await api('users', { query: 'select=id' });
    if (!rows || rows.length === 0) {
      const hashed = bcrypt.hashSync('admin123', 10);
      await api('users', {
        method: 'POST',
        body: { username: 'admin', password: hashed, role: 'admin', name: 'Admin' },
        prefer: 'return=representation',
      });
      console.log('Seeded default admin (admin / admin123) into users table');
    }
  } catch (e) {
    console.warn('User seed skipped (users table may not exist yet in CloudBase):', e.message);
  }
}

// ===== Auth =====
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const rows = await api('users', { query: eq('username', username) });
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid username or password' });
    if (!bcrypt.compareSync(password, u.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ uid: u.id, role: u.role }, SESSION_SECRET, { expiresIn: JWT_TTL });
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: COOKIE_SAMESITE,
      path: '/',
      maxAge: ttlToMs(JWT_TTL),
    });
    res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/logout', auth, (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ success: true });
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const rows = await api('users', { query: `${eq('id', meId(req))}&select=id,username,name,role` });
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Teachers (Admin only) =====
app.get('/api/teachers', auth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await api('users', { query: 'role=eq.teacher&select=id,username,name&order=name.asc' });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/teachers', auth, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const rows = await api('users', {
      method: 'POST',
      body: { username, password: bcrypt.hashSync(password, 12), role: 'teacher', name: name || username },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Students =====
app.get('/api/students', auth, async (req, res) => {
  try {
    const query = isTeacher(req)
      ? `${eq('teacher_id', meId(req))}&order=created_at.desc`
      : 'order=created_at.desc';
    const students = await api('students', { query });
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

app.get('/api/students/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const sRows = await api('students', { query: eq('id', id) });
    const s = sRows[0];
    if (!s) return res.status(404).json({ error: 'Student not found' });
    if (isTeacher(req) && s.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });

    const deductions = (await api('deductions', { query: `${eq('student_id', id)}&order=date.desc` }))
      .map(d => ({ ...d, date: fmtTs(d.date) }));
    const totalHours = deductions.reduce((a, d) => a + num(d.hours), 0);
    const usedHours = deductions.reduce((a, d) => a + num(d.hours), 0);

    // Teacher scope: no purchases / no money at all.
    if (isTeacher(req)) {
      return res.json({ ...s, remaining_hours: totalHours - usedHours, used_hours: usedHours, deductions });
    }

    const purchases = (await api('purchases', { query: `${eq('student_id', id)}&order=date.desc` }))
      .map(p => ({ ...p, date: fmtTs(p.date) }));
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

app.post('/api/students', auth, requireRole('admin'), async (req, res) => {
  try {
    const { name, grade, address, need, feedback } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const teacherId = await defaultTeacherId();
    const rows = await api('students', {
      method: 'POST',
      body: {
        name,
        grade: grade || '',
        address: address || '',
        need: need || '',
        feedback: feedback || '',
        teacher_id: teacherId,
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.put('/api/students/:id', auth, async (req, res) => {
  try {
    const sRows = await api('students', { query: eq('id', req.params.id) });
    const s = sRows[0];
    if (!s) return res.status(404).json({ error: 'Student not found' });
    if (isTeacher(req)) {
      if (s.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });
      // Teacher may only write feedback.
      await api('students', {
        method: 'PATCH',
        query: eq('id', req.params.id),
        body: { feedback: req.body.feedback || '' },
      });
      return res.json({ id: parseInt(req.params.id, 10), feedback: req.body.feedback || '' });
    }
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

app.delete('/api/students/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await api('students', { method: 'DELETE', query: eq('id', req.params.id) });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Purchases (Admin only) =====
app.get('/api/purchases', auth, requireRole('admin'), async (req, res) => {
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

app.post('/api/purchases', auth, requireRole('admin'), async (req, res) => {
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
app.get('/api/deductions', auth, async (req, res) => {
  try {
    let rows;
    if (isTeacher(req)) {
      const ids = await myStudentIds(req);
      if (ids.length === 0) return res.json([]);
      rows = await api('deductions', { query: `student_id=in.(${ids.join(',')})&order=date.desc` });
    } else {
      rows = await api('deductions', { query: 'order=date.desc' });
    }
    const students = await api('students', { query: 'select=id,name,grade' });
    const smap = {};
    students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });
    const result = rows.map(d => ({
      ...d,
      date: fmtTs(d.date),
      student_name: d.student_id != null ? (smap[d.student_id] ? smap[d.student_id].name : null) : null,
      student_grade: d.student_id != null ? (smap[d.student_id] ? smap[d.student_id].grade : null) : null,
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/deductions', auth, async (req, res) => {
  try {
    const { student_id, hours, date, note } = req.body;
    if (!hours || hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
    const sRows = await api('students', { query: eq('id', student_id) });
    const stu = sRows[0];
    if (!stu) return res.status(404).json({ error: 'Student not found' });

    let tid = null;
    if (isTeacher(req)) {
      if (stu.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });
      tid = meId(req);
    } else {
      tid = stu.teacher_id != null ? stu.teacher_id : null;
    }

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
        teacher_id: tid,
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
app.get('/api/events', auth, async (req, res) => {
  try {
    const query = isTeacher(req)
      ? `${eq('teacher_id', meId(req))}&order=date.asc`
      : 'order=date.asc';
    const rows = await api('events', { query });
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

app.post('/api/events', auth, async (req, res) => {
  try {
    const { type, student_id, date, time, title } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    let tid = null;
    if (isTeacher(req)) {
      tid = meId(req);
      if (student_id != null) {
        const sRows = await api('students', { query: eq('id', student_id) });
        const stu = sRows[0];
        if (!stu || stu.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });
      }
    } else {
      tid = req.body.teacher_id != null ? num(req.body.teacher_id) : null;
    }
    const rows = await api('events', {
      method: 'POST',
      body: {
        type: type || 'lesson',
        student_id: student_id != null ? num(student_id) : null,
        date,
        time: time || '',
        title: title || '',
        teacher_id: tid,
      },
      prefer: 'return=representation',
    });
    res.json({ id: rows[0].id, ...req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.put('/api/events/:id', auth, async (req, res) => {
  try {
    if (isTeacher(req)) {
      const eRows = await api('events', { query: eq('id', req.params.id) });
      const ev = eRows[0];
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      if (ev.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });
    }
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

app.delete('/api/events/:id', auth, async (req, res) => {
  try {
    if (isTeacher(req)) {
      const eRows = await api('events', { query: eq('id', req.params.id) });
      const ev = eRows[0];
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      if (ev.teacher_id != meId(req)) return res.status(403).json({ error: 'forbidden' });
    }
    await api('events', { method: 'DELETE', query: eq('id', req.params.id) });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ===== Billing Summary (Admin only) =====
app.get('/api/billing', auth, requireRole('admin'), async (req, res) => {
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
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${y}-${m}`;
    const todayStr = now.toISOString().slice(0, 10);

    if (isTeacher(req)) {
      const students = await api('students', { query: `${eq('teacher_id', meId(req))}&select=id,name,grade` });
      const studentCount = students.length;
      const smap = {};
      students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });

      const monthEventsRows = await api('events', { query: `${eq('teacher_id', meId(req))}&date=like.${encodeURIComponent(monthPrefix + '%')}&select=id` });
      const monthEvents = monthEventsRows.length;

      const purMap = {}, dedMap = {};
      const purchases = await api('purchases', { query: 'select=student_id,total_hours' });
      const deductions = await api('deductions', { query: 'select=student_id,hours' });
      purchases.forEach(p => { purMap[p.student_id] = (purMap[p.student_id] || 0) + num(p.total_hours); });
      deductions.forEach(d => { dedMap[d.student_id] = (dedMap[d.student_id] || 0) + num(d.hours); });

      const warnings = [];
      for (const s of students) {
        const remaining = (purMap[s.id] || 0) - (dedMap[s.id] || 0);
        if (remaining <= 3) warnings.push({ id: s.id, name: s.name, grade: s.grade, remaining_hours: remaining });
      }

      const todayRows = await api('events', { query: `${eq('teacher_id', meId(req))}&${eq('date', todayStr)}` });
      const todayEvents = todayRows.map(e => ({
        ...e,
        student_name: e.student_id != null ? (smap[e.student_id] != null ? smap[e.student_id] : null) : null,
      }));

      return res.json({
        student_count: studentCount,
        month_events: monthEvents,
        total_revenue: 0,
        warning_count: warnings.length,
        warnings,
        today_events: todayEvents,
      });
    }

    // Admin: full scope including revenue.
    const students = await api('students', { query: 'select=id,name,grade' });
    const studentCount = students.length;
    const smap = {};
    students.forEach(s => { smap[s.id] = { name: s.name, grade: s.grade }; });

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
      if (remaining <= 3) warnings.push({ id: s.id, name: s.name, grade: s.grade, remaining_hours: remaining });
    }

    const todayRows = await api('events', { query: eq('date', todayStr) });
    const todayEvents = todayRows.map(e => ({
      ...e,
      student_name: e.student_id != null ? (smap[e.student_id] != null ? smap[e.student_id] : null) : null,
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
ensureUsers().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pretty English server running on port ${PORT}`);
  });
});

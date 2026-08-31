-- Pretty English - PostgreSQL Schema
-- 用于腾讯云 CloudBase PostgreSQL 模式环境（education-app，共享集群）
--
-- ⚠️ 重要：CloudBase 共享集群的 PostgREST HTTP API 只能对表做增删改查，
--    无法执行建表等 DDL。因此本文件【不会】由 server.js 自动执行，
--    必须手动到 CloudBase 控制台「数据库 → SQL 编辑器」里粘贴并运行本脚本，
--    先创建好 admins / students / purchases / deductions / events 五张表，
--    然后再部署/启动后端。
--    后端会用 service_role 的 API Key 访问这些表（绕过 RLS，拥有全量权限）。

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name TEXT DEFAULT 'Admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  grade TEXT,
  address TEXT,
  need TEXT,
  feedback TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  total_hours REAL NOT NULL,
  note TEXT,
  date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deductions (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  hours REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'lesson',
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

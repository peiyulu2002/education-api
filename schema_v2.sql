-- Pretty English v2 - Role authentication (simplified single-teacher model)
-- 腾讯云 CloudBase PostgreSQL 模式环境（education-app，共享集群）
--
-- ⚠️ 重要：CloudBase 共享集群的 PostgREST HTTP API 只能对表做增删改查，无法执行 DDL。
--    本文件【不会】由 server.js 自动执行，必须手动到 CloudBase 控制台
--    「数据库 → SQL 编辑器」里粘贴并运行本脚本（在 schema.sql 已执行、五张表已存在之后）。
--
-- 设计：单老师简化模型
--   - users        统一登录表（admin / teacher 两种角色），取代 admins 作为认证来源
--   - admins       原表保留为历史数据，不做认证；迁移时把其行复制进 users
--   - teacher_id   直接加在 students / events / deductions 上，引用 users(id)（role='teacher'）
--   - 不做 teachers 表、不做 student_teachers 联结表（将来要多老师时再加联结表迁移）
--   所有学生默认归属该唯一老师（后端创建学生时自动填 teacher_id）。

-- ===== 1. 统一登录表 =====
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('admin','teacher')),
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== 2. 在现有表上加 teacher_id 作用域列 =====
ALTER TABLE students   ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events     ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deductions ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- ===== 3. 索引 =====
CREATE INDEX IF NOT EXISTS idx_students_teacher    ON students(teacher_id);
CREATE INDEX IF NOT EXISTS idx_events_teacher      ON events(teacher_id);
CREATE INDEX IF NOT EXISTS idx_deductions_teacher  ON deductions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_users_username      ON users(username);

-- ===== 4. 保留现有管理员账号：复制进 users（role='admin'） =====
INSERT INTO users (username, password, role, name)
SELECT username, password, 'admin', COALESCE(name, 'Admin')
FROM admins
ON CONFLICT (username) DO NOTHING;

-- ===== 5. 一次性：创建唯一的老师账号后，把所有现有学生指向该老师 =====
--   先通过后端「老师管理」创建老师，或下方直接插入（请替换密码为 bcrypt 哈希）：
--   INSERT INTO users (username, password, role, name)
--   VALUES ('teacher', '<bcrypt-hash>', 'teacher', 'Teacher');
--   然后把该老师的 users.id 填到下面的 <teacher_user_id>：
--   UPDATE students SET teacher_id = <teacher_user_id>;
--   新建学生会在后端自动带 teacher_id，无需手动 UPDATE。

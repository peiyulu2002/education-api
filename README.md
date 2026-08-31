# Pretty English - 部署到腾讯云 CloudBase 云托管

## 项目结构

```
pretty-english/
├── Dockerfile              # 容器构建文件
├── server/
│   ├── server.js           # Node.js + Express 后端
│   ├── package.json        # 依赖声明
│   └── package-lock.json
├── public/
│   ├── index.html          # 前端（手机 App 风格 PWA）
│   ├── manifest.json       # PWA 配置
│   ├── sw.js               # Service Worker
│   ├── icon-192.png        # App 图标
│   └── icon-512.png        # App 图标
└── README.md
```

## 技术栈

- **前端**：原生 HTML/CSS/JS（单文件 PWA，手机 App 风格）
- **后端**：Node.js + Express
- **数据库**：SQLite（better-sqlite3，文件存储）
- **部署**：腾讯云 CloudBase 云托管（容器化部署）

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 3000 | 服务端口，CloudBase 会自动注入 |
| `DATA_DIR` | 当前目录 | 数据库文件存放目录（挂载 CFS 后改为 `/data`）|

## 默认账号

- 用户名：`admin`
- 密码：`admin123`
- 登录后建议立即修改密码（在 server.js 中更改 bcrypt 哈希）

## 部署步骤

### 方式一：控制台上传代码包（推荐，最简单）

1. 打开 [腾讯云开发 CloudBase 控制台](https://tcb.cloud.tencent.com/)
2. 开通云开发环境（选免费体验版）
3. 进入 **云托管** → **新建服务**
4. 服务名称填 `pretty-english`
5. 部署方式选 **上传代码包**
6. 代码包类型选 **文件夹**，选择整个 `pretty-english` 项目目录
7. 端口填 `3000`
8. 点击创建，等待部署完成（约 2-3 分钟）

### 方式二：CloudBase CLI

```bash
npm install -g @cloudbase/cli
tcb login
cd pretty-english
tcb cloudrun deploy --port 3000
```

## 数据持久化（重要）

云托管容器重启后本地文件会丢失，需要挂载 **CFS 文件存储**：

1. 在云托管服务设置中，找到 **文件存储**
2. 创建 CFS 实例（约 ¥0.35/GB/月）
3. 挂载路径设置为 `/data`
4. 在 CloudBase 环境变量中设置 `DATA_DIR=/data`

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 管理员登录 |
| GET | `/api/students` | 学员列表 |
| POST | `/api/students` | 新增学员 |
| PUT | `/api/students/:id` | 编辑学员 |
| DELETE | `/api/students/:id` | 删除学员 |
| GET | `/api/students/:id` | 学员详情（含购课/上课记录）|
| GET | `/api/billing` | 课时收费汇总 |
| POST | `/api/purchases` | 购课录入 |
| POST | `/api/deductions` | 上课扣课 |
| GET | `/api/events` | 日历事件列表 |
| POST | `/api/events` | 新增事件 |
| PUT | `/api/events/:id` | 编辑事件 |
| DELETE | `/api/events/:id` | 删除事件 |
| GET | `/api/dashboard` | 工作台统计数据 |

## 数据库 Schema

```sql
-- 管理员表
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT DEFAULT 'Admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 学员表
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade TEXT,
  address TEXT,
  need TEXT,
  feedback TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 购课记录表
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  total_hours REAL NOT NULL,
  note TEXT,
  date DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);

-- 扣课记录表
CREATE TABLE deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  hours REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);

-- 日历事件表
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'lesson',
  student_id INTEGER,
  date TEXT NOT NULL,
  time TEXT,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
```

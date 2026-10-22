const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/twitter';

const pool = new Pool({ connectionString: DATABASE_URL, max: 5, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT,
    bio TEXT DEFAULT '',
    avatar_color TEXT DEFAULT '#1d9bf0',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS reposts (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    post_id INTEGER,
    read INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 1200;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS images TEXT;
  ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS link TEXT;
  CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
  CREATE TABLE IF NOT EXISTS comment_likes (
    user_id INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, comment_id)
  );
  CREATE TABLE IF NOT EXISTS comment_reposts (
    user_id INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, comment_id)
  );
  CREATE TABLE IF NOT EXISTS verify_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    req_type TEXT NOT NULL,
    info TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id SERIAL PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(sender_id, receiver_id);
  CREATE INDEX IF NOT EXISTS idx_dm_unread ON dm_messages(receiver_id, read);
  CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    super BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE TABLE IF NOT EXISTS mutes (
    user_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, target_id)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    user_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, target_id)
  );
  CREATE TABLE IF NOT EXISTS post_actions (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id, kind)
  );
  CREATE TABLE IF NOT EXISTS topic_subs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, keyword)
  );
  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ads (
    id SERIAL PRIMARY KEY,
    slot TEXT NOT NULL DEFAULT 'feed',
    title TEXT,
    body TEXT,
    image TEXT,
    link TEXT,
    cta TEXT,
    active BOOLEAN DEFAULT TRUE,
    clicks INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS repost_of INTEGER;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_title TEXT;
  ALTER TABLE verify_requests ADD COLUMN IF NOT EXISTS title TEXT;
  UPDATE users u SET verify_title = v.title FROM verify_requests v
    WHERE v.user_id = u.id AND v.status = 'approved' AND v.title IS NOT NULL AND v.title <> '' AND (u.verify_title IS NULL OR u.verify_title = '');
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS article TEXT;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS title TEXT;
  CREATE TABLE IF NOT EXISTS trend_pins (
    tag TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_img TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_img TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS removed BOOLEAN DEFAULT FALSE;
  ALTER TABLE comments ADD COLUMN IF NOT EXISTS removed BOOLEAN DEFAULT FALSE;
  `);
  await seedAdmin();
}

// 首次启动自动建管理员账号：admin / yuacio-school-2026（可用 ADMIN_PASSWORD 覆盖）
async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM admins');
  if (rows[0].c > 0) return;
  const pwd = process.env.ADMIN_PASSWORD || 'yuacio-school-2026';
  await pool.query('INSERT INTO admins (username, password, name, super) VALUES ($1,$2,$3,TRUE)',
    ['admin', bcrypt.hashSync(pwd, 10), '超级管理员']);
  console.log('已创建默认管理员账号 admin');
}

app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, must-revalidate'); } }));
app.get('/', (req, res) => res.setHeader('Cache-Control', 'no-store, must-revalidate') || res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => { res.setHeader('Cache-Control', 'no-store, must-revalidate'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// ==================== 工具 ====================
async function notify(client, userId, actorId, type, postId = null) {
  if (userId === actorId) return;
  await client.query('INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1,$2,$3,$4)', [userId, actorId, type, postId]);
}

function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}
function authOptional(req, res, next) {
  const token = req.cookies.token;
  if (token) { try { req.user = jwt.verify(token, SECRET); } catch {} }
  next();
}

// ==================== 管理员鉴权 ====================
function signAdmin(a) {
  return jwt.sign({ aid: a.id, au: a.username, adm: true }, SECRET, { expiresIn: '12h' });
}
async function adminAuth(req, res, next) {
  const token = req.cookies.atoken;
  if (!token) return res.status(401).json({ error: '请先登录管理后台' });
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: '登录已过期' }); }
  if (!payload.adm) return res.status(401).json({ error: '无权限' });
  const { rows } = await pool.query('SELECT id, username, name, super FROM admins WHERE id = $1', [payload.aid]);
  if (!rows.length) return res.status(401).json({ error: '账号已删除' });
  req.admin = rows[0];
  next();
}

const AVATAR_COLORS = ['#1d9bf0', '#f91880', '#00ba7c', '#ffd400', '#7856ff', '#ff7a00', '#00b8d9'];

function withMe(rows, meId) {
  return rows.map(r => ({
    ...r,
    liked: !!r.liked, reposted: !!r.reposted, mine: meId === r.user_id,
  }));
}

// 通用帖子查询：附计数与当前用户状态
async function queryPosts(where, params, meId, order = 'p.id DESC') {
  const sql = `
    SELECT p.*, u.username, u.nickname, u.avatar_color, u.avatar_img, u.role,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) ::int AS likes,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) ::int AS comments,
      (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) ::int AS reposts,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $ME) AS liked,
      EXISTS(SELECT 1 FROM reposts WHERE post_id = p.id AND user_id = $ME) AS reposted,
      EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $ME) AS bookmarked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.removed IS NOT TRUE AND p.article IS NULL ${where ? 'AND (' + where + ')' : ''}
    ORDER BY ${order} LIMIT 200`;
  const finalSql = sql.replaceAll('$ME', meId ? Number(meId) : 'NULL');
  const { rows } = await pool.query(finalSql, params);
  return withMe(rows, meId);
}

// ==================== 注册 / 登录 ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, nickname } = req.body || {};
    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: '用户名需 3-20 位字母、数字或下划线' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: '密码至少 6 位' });
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length) return res.status(400).json({ error: '用户名已被占用' });
    const hash = bcrypt.hashSync(password, 10);
    const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const { rows } = await pool.query(
      'INSERT INTO users (username, password, nickname, avatar_color) VALUES ($1,$2,$3,$4) RETURNING id, username, nickname',
      [username, hash, nickname || username, color]);
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username }, SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json(user);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username || '']);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password || '', user.password))
      return res.status(400).json({ error: '用户名或密码错误' });
    if (user.banned) return res.status(403).json({ error: '该账号已被管理员封禁，如有疑问请联系学校管理员' });
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ id: user.id, username: user.username, nickname: user.nickname });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authOptional, async (req, res) => {
  if (!req.user) return res.json(null);
  const { rows } = await pool.query('SELECT id, username, nickname, bio, avatar_color, avatar_img, banner_img, location, link FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0] || null);
});

// ==================== 用户 ====================
app.get('/api/users/:username', authOptional, async (req, res) => {
  const { rows } = await pool.query(`SELECT u.id, u.username, u.nickname, u.bio, u.avatar_color, u.avatar_img, u.banner_img, u.created_at, u.role, u.verify_title, u.location, u.link,
    (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS followers,
    (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following,
    (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts_count
    FROM users u WHERE lower(u.username) = lower($1)`, [req.params.username]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: '用户不存在' });
  let is_following = false;
  const is_self = !!req.user && req.user.id === u.id;
  if (req.user) {
    const f = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, u.id]);
    is_following = f.rows.length > 0;
  }
  let mutual = false;
  if (req.user && !is_self) {
    const m = await pool.query(`SELECT 1 FROM follows f1 JOIN follows f2 ON f1.follower_id = f2.follower_id
      WHERE f1.follower_id = $1 AND f1.followee_id = $2 AND f2.followee_id = $1 LIMIT 1`, [req.user.id, u.id]);
    mutual = m.rows.length > 0;
  }
  res.json({ ...u, is_following, is_self, mutual_followers: mutual });
});

// 认证（管理密钥）
app.post('/api/admin/verify', async (req, res) => {
  try {
    const { secret, username, role } = req.body || {};
    if (secret !== (process.env.ADMIN_SECRET || 'yuacio-school-2026')) return res.status(403).json({ error: '密钥错误' });
    const r = role === 'official' ? 'official' : 'verified';
    const { rows } = await pool.query('UPDATE users SET role = $1 WHERE lower(username) = lower($2) RETURNING username, role',
      [r, username || '']);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 趋势：官媒认证话题置顶，认证用户按发帖数，普通用户不上榜
app.get('/api/trends', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT p.content, u.username, u.nickname, u.role,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts_count
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.removed IS NOT TRUE AND p.content LIKE '%#%' ORDER BY p.id DESC LIMIT 500`);
    const map = {};
    for (const r of rows) {
      const tags = (r.content.match(/#[\w一-龥]+/g) || []);
      for (let t of tags) {
        const tag = t.slice(1);
        if (!map[tag]) map[tag] = { tag, count: 0, official: false, verified: false, posts: 0, author: null };
        map[tag].count += 1;
        if (r.role === 'official') { map[tag].official = true; map[tag].author = map[tag].author || r.nickname || r.username; }
        else if (r.role === 'verified') { map[tag].verified = true; map[tag].posts = Math.max(map[tag].posts, Number(r.posts_count)); map[tag].author = map[tag].author || r.nickname || r.username; }
      }
    }
    let list = Object.values(map).filter(t => t.official || t.verified);
    list.sort((a, b) => (b.official - a.official) || (b.posts - a.posts) || (b.count - a.count));
    // 管理员干预：pinned 置顶、banned 屏蔽
    const { rows: pins } = await pool.query('SELECT tag, mode FROM trend_pins');
    const pinMap = {}; pins.forEach(x => pinMap[x.tag] = x.mode);
    list = list.filter(t => pinMap[t.tag] !== 'banned');
    const top = list.filter(t => pinMap[t.tag] === 'pinned');
    const rest = list.filter(t => pinMap[t.tag] !== 'pinned');
    res.json([...top, ...rest].slice(0, 20));
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 群组 ====================
app.get('/api/groups', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.name, g.created_at,
        (SELECT COUNT(*)::int FROM group_members WHERE group_id = g.id) AS members,
        (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS last_msg,
        (SELECT COUNT(*)::int FROM group_messages WHERE group_id = g.id AND created_at > COALESCE(
          (SELECT MAX(created_at) FROM group_messages gm2 JOIN group_members gm3 ON gm3.group_id = gm2.group_id
           WHERE gm3.user_id = $1 AND gm3.group_id = g.id), to_timestamp(0))) AS unread
      FROM groups g JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = $1 ORDER BY g.id DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/groups', auth, async (req, res) => {
  try {
    const { name, members } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '群名称不能为空' });
    const { rows } = await pool.query('INSERT INTO groups (name, creator_id) VALUES ($1,$2) RETURNING id', [name.trim(), req.user.id]);
    const gid = rows[0].id;
    await pool.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)', [gid, req.user.id]);
    const uniq = [...new Set((members || []).map(String))];
    for (const uname of uniq) {
      const u = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [uname]);
      if (u.rows.length && u.rows[0].id !== req.user.id)
        await pool.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gid, u.rows[0].id]);
    }
    res.json({ id: gid, name: name.trim() });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/groups/:id/messages', auth, async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const gm = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [gid, req.user.id]);
    if (!gm.rows.length) return res.status(403).json({ error: '不在群内' });
    const { rows } = await pool.query(`
      SELECT m.id, m.sender_id, m.content, m.created_at, u.username, u.nickname, u.avatar_color
      FROM group_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = $1 ORDER BY m.id ASC LIMIT 300`, [gid]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/groups/:id/messages', auth, async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const gm = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [gid, req.user.id]);
    if (!gm.rows.length) return res.status(403).json({ error: '不在群内' });
    const { content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    const { rows } = await pool.query('INSERT INTO group_messages (group_id, sender_id, content) VALUES ($1,$2,$3) RETURNING id, created_at',
      [gid, req.user.id, content.trim()]);
    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/groups/:id', auth, async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const { rows } = await pool.query(`SELECT g.id, g.name, u.username, u.nickname FROM groups g
      JOIN users u ON u.id = g.creator_id WHERE g.id = $1`, [gid]);
    if (!rows.length) return res.status(404).json({ error: '群不存在' });
    const members = await pool.query(`SELECT u.username, u.nickname, u.avatar_color FROM group_members gm
      JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`, [gid]);
    res.json({ ...rows[0], member_list: members.rows });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});



app.put('/api/me', auth, async (req, res) => {
  const { nickname, bio, avatar_color, location, link } = req.body || {};
  let avatar_img = req.body.avatar_img, banner_img = req.body.banner_img;
  const okImg = x => typeof x === 'string' && (x === '' || (x.startsWith('data:image/') ? x.length < 1600000 : /^https:\/\/[\w.-]+\/\S+$/.test(x)));
  if (!okImg(avatar_img)) avatar_img = undefined;
  if (!okImg(banner_img)) banner_img = undefined;
  const sets = ["nickname = COALESCE($1, nickname)", "bio = COALESCE($2, bio)", "avatar_color = COALESCE($3, avatar_color)",
    "location = COALESCE($4, location)", "link = COALESCE($5, link)"];
  const params = [nickname, bio, avatar_color, location, link];
  if (avatar_img !== undefined) { sets.push(`avatar_img = NULLIF($${params.length + 1}, '')`); params.push(avatar_img); }
  if (banner_img !== undefined) { sets.push(`banner_img = NULLIF($${params.length + 1}, '')`); params.push(banner_img); }
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:username/follow', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能关注自己' });
  const existing = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, target.id]);
  if (existing.rows.length) {
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, target.id]);
    return res.json({ following: false });
  }
  await pool.query('INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)', [req.user.id, target.id]);
  await notify(pool, target.id, req.user.id, 'follow');
  res.json({ following: true });
});

// ==================== 帖子 ====================
// 动态流：原帖 + 转推事件合并，按时间排序
async function queryFeed(where, params, meId, opts = {}) {
  const sql = `
    SELECT p.id, p.user_id, p.content, p.created_at, p.views, p.images, p.title, p.article,
      u.username, u.nickname, u.avatar_color, u.avatar_img, u.role,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) ::int AS likes,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) ::int AS comments,
      (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) ::int AS reposts,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $ME) AS liked,
      EXISTS(SELECT 1 FROM reposts WHERE post_id = p.id AND user_id = $ME) AS reposted,
      EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $ME) AS bookmarked,
      CASE WHEN $ME IS NOT NULL AND p.user_id <> $ME THEN EXISTS(SELECT 1 FROM follows WHERE follower_id = $ME AND followee_id = p.user_id) END AS author_following,
      t.rt_user_id, ru.username AS rt_username, ru.nickname AS rt_nickname
    FROM (
      SELECT id, NULL::int AS rt_user_id, created_at AS sort_time FROM posts
      UNION ALL
      SELECT p.id, r.user_id, r.created_at FROM reposts r JOIN posts p ON p.id = r.post_id
    ) t
    JOIN posts p ON p.id = t.id
    JOIN users u ON u.id = p.user_id
    LEFT JOIN users ru ON ru.id = t.rt_user_id
    WHERE p.removed IS NOT TRUE ${opts.noArticle ? 'AND p.article IS NULL' : ''}
      ${where ? 'AND (' + where + ')' : ''}
      ${meId ? `AND p.user_id NOT IN (SELECT target_id FROM mutes WHERE user_id=$ME)
               AND p.user_id NOT IN (SELECT target_id FROM blocks WHERE user_id=$ME)
               AND p.id NOT IN (SELECT post_id FROM post_actions WHERE user_id=$ME AND kind='notint')` : ''}
    ORDER BY t.sort_time DESC LIMIT 200`;
  const finalSql = sql.replaceAll('$ME', meId ? Number(meId) : 'NULL');
  const { rows } = await pool.query(finalSql, params);
  return rows.map(r => ({ ...r, liked: !!r.liked, reposted: !!r.reposted, bookmarked: !!r.bookmarked, mine: meId === r.user_id }));
}

app.get('/api/posts', authOptional, async (req, res) => {
  try { res.json(await queryFeed('', [], req.user?.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/timeline', auth, async (req, res) => {
  try {
    const where = `(p.user_id = $1 OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1) OR t.rt_user_id = $1 OR t.rt_user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1))`;
    res.json(await queryFeed(where, [req.user.id], req.user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 静音 / 屏蔽 / 不感兴趣 ====================
app.post('/api/users/:username/mute', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username)=lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const tid = rows[0].id;
    if (tid === req.user.id) return res.status(400).json({ error: '不能对自己操作' });
    const ex = await pool.query('SELECT 1 FROM mutes WHERE user_id=$1 AND target_id=$2', [req.user.id, tid]);
    if (ex.rows.length) { await pool.query('DELETE FROM mutes WHERE user_id=$1 AND target_id=$2', [req.user.id, tid]); return res.json({ muted: false }); }
    await pool.query('INSERT INTO mutes (user_id,target_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, tid]);
    res.json({ muted: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/users/:username/block', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username)=lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const tid = rows[0].id;
    if (tid === req.user.id) return res.status(400).json({ error: '不能屏蔽自己' });
    const ex = await pool.query('SELECT 1 FROM blocks WHERE user_id=$1 AND target_id=$2', [req.user.id, tid]);
    if (ex.rows.length) { await pool.query('DELETE FROM blocks WHERE user_id=$1 AND target_id=$2', [req.user.id, tid]); return res.json({ blocked: false }); }
    await pool.query('INSERT INTO blocks (user_id,target_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, tid]);
    // 屏蔽同时解除双向关注
    await pool.query('DELETE FROM follows WHERE (follower_id=$1 AND followee_id=$2) OR (follower_id=$2 AND followee_id=$1)', [req.user.id, tid]);
    res.json({ blocked: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/posts/:id/notinterested', auth, async (req, res) => {
  try {
    await pool.query("INSERT INTO post_actions (user_id,post_id,kind) VALUES ($1,$2,'notint') ON CONFLICT DO NOTHING", [req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 单帖详情（快速）
app.get('/api/posts/:id/single', authOptional, async (req, res) => {
  try {
    const rows = await queryFeed('p.id = $1', [req.params.id], req.user?.id, { allowArticle: true });
    if (!rows.length) return res.status(404).json({ error: '帖子不存在' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 浏览计数：每次查看详情 +1
app.post('/api/posts/:id/view', async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE posts SET views = views + 1 WHERE id = $1 RETURNING views', [req.params.id]);
    res.json({ views: rows[0] ? Number(rows[0].views) : 0 });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/users/:username/posts', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    res.json(await queryPosts('p.user_id = $1', [rows[0].id], req.user?.id));
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/users/:username/reposts', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const uid = rows[0].id;
    const ids = (await pool.query('SELECT post_id FROM reposts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [uid])).rows.map(r => r.post_id);
    if (!ids.length) return res.json([]);
    res.json(await queryFeed('p.id = ANY($1::int[])', [ids], req.user?.id));
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/users/:username/articles', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const { rows: arts } = await pool.query(`SELECT p.id, p.title, p.content, p.article, p.images, p.views, p.created_at, u.username, u.nickname
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1 AND p.article IS NOT NULL AND p.removed IS NOT TRUE
      ORDER BY p.created_at DESC LIMIT 50`, [rows[0].id]);
    res.json(arts);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    if (content.length > 400) return res.status(400).json({ error: '最多 400 个字符' });
    let images = req.body.images || [];
    if (!Array.isArray(images)) images = [];
    images = images.slice(0, 4).filter(x => typeof x === 'string' && (x.startsWith('data:image/') ? x.length < 900000 : /^https:\/\/[\w.-]+\/\S+$/.test(x)));
    const { rows: inserted } = await pool.query('INSERT INTO posts (user_id, content, images) VALUES ($1,$2,$3) RETURNING id',
      [req.user.id, content.trim(), images.length ? JSON.stringify(images) : null]);
    const posts = await queryPosts('p.id = $1', [inserted[0].id], req.user.id);
    res.json(posts[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: '帖子不存在' });
    if (post.user_id !== req.user.id) return res.status(403).json({ error: '只能删除自己的帖子' });
    await pool.query('DELETE FROM comments WHERE post_id = $1', [post.id]);
    await pool.query('DELETE FROM likes WHERE post_id = $1', [post.id]);
    await pool.query('DELETE FROM reposts WHERE post_id = $1', [post.id]);
    await pool.query('DELETE FROM notifications WHERE post_id = $1', [post.id]);
    await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: '帖子不存在' });
    const existing = await pool.query('SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, post.id]);
    if (existing.rows.length) {
      await pool.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, post.id]);
    } else {
      await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1,$2)', [req.user.id, post.id]);
      await notify(pool, post.user_id, req.user.id, 'like', post.id);
    }
    const count = (await pool.query('SELECT COUNT(*) AS c FROM likes WHERE post_id = $1', [post.id])).rows[0].c;
    res.json({ liked: existing.rows.length === 0, likes: Number(count) });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts/:id/repost', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: '帖子不存在' });
    const existing = await pool.query('SELECT 1 FROM reposts WHERE user_id = $1 AND post_id = $2', [req.user.id, post.id]);
    if (existing.rows.length) {
      await pool.query('DELETE FROM reposts WHERE user_id = $1 AND post_id = $2', [req.user.id, post.id]);
    } else {
      await pool.query('INSERT INTO reposts (user_id, post_id) VALUES ($1,$2)', [req.user.id, post.id]);
      await notify(pool, post.user_id, req.user.id, 'repost', post.id);
    }
    const count = (await pool.query('SELECT COUNT(*) AS c FROM reposts WHERE post_id = $1', [post.id])).rows[0].c;
    res.json({ reposted: existing.rows.length === 0, reposts: Number(count) });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/posts/:id/comments', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, u.username, u.nickname, u.avatar_color,
        pu.username AS parent_username, pu.nickname AS parent_nickname,
        (SELECT COUNT(*)::int FROM comment_likes WHERE comment_id = c.id) AS clikes,
        (SELECT COUNT(*)::int FROM comment_reposts WHERE comment_id = c.id) AS creposts,
        EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = $ME) AS liked,
        EXISTS(SELECT 1 FROM comment_reposts WHERE comment_id = c.id AND user_id = $ME) AS reposted,
        false AS bookmarked
      FROM comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN comments pc ON pc.id = c.parent_id
      LEFT JOIN users pu ON pu.id = pc.user_id
      WHERE c.post_id = $1 ORDER BY c.id ASC`.replaceAll('$ME', req.user?.id ? Number(req.user.id) : 'NULL'), [req.params.id]);
    res.json(withMe(rows, req.user?.id));
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const { content, parent_id } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '帖子不存在' });
    await pool.query('INSERT INTO comments (user_id, post_id, content, parent_id) VALUES ($1,$2,$3,$4)',
      [req.user.id, req.params.id, content.trim(), parent_id || null]);
    await notify(pool, rows[0].user_id, req.user.id, 'comment', Number(req.params.id));
    // 回复别人时也通知被回复人
    if (parent_id) {
      const p = await pool.query('SELECT user_id, post_id FROM comments WHERE id = $1', [parent_id]);
      if (p.rows.length && p.rows[0].user_id !== rows[0].user_id)
        await notify(pool, p.rows[0].user_id, req.user.id, 'comment', Number(req.params.id));
    }
    const { rows: c } = await pool.query(`
      SELECT c.*, u.username, u.nickname, u.avatar_color,
        pu.username AS parent_username, pu.nickname AS parent_nickname,
        (SELECT COUNT(*)::int FROM comment_likes WHERE comment_id = c.id) AS clikes,
        (SELECT COUNT(*)::int FROM comment_reposts WHERE comment_id = c.id) AS creposts,
        EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = $ME) AS liked,
        EXISTS(SELECT 1 FROM comment_reposts WHERE comment_id = c.id AND user_id = $ME) AS reposted,
        false AS bookmarked
      FROM comments c JOIN users u ON u.id = c.user_id
      LEFT JOIN comments pc ON pc.id = c.parent_id
      LEFT JOIN users pu ON pu.id = pc.user_id
      WHERE c.post_id = $1 ORDER BY c.id DESC LIMIT 1`.replaceAll('$ME', Number(req.user.id)), [req.params.id]);
    res.json(withMe(c, req.user.id)[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 用户回复列表（个人主页"回复"标签）
app.get('/api/users/:username/replies', authOptional, async (req, res) => {
  try {
    const { rows: u } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!u.length) return res.status(404).json({ error: '用户不存在' });
    const { rows } = await pool.query(`
      SELECT c.id, c.content, c.created_at, c.post_id, c.parent_id,
        p.content AS parent_content, pu.username AS parent_username, pu.nickname AS parent_nickname,
        cu.username, cu.nickname, cu.avatar_color, cu.avatar_img
      FROM comments c
      JOIN posts p ON p.id = c.post_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN users pu ON pu.id = p.user_id
      WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT 100`, [u[0].id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 谁喜欢了该用户的帖子
app.get('/api/users/:username/likers', authOptional, async (req, res) => {
  try {
    const { rows: u } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!u.length) return res.status(404).json({ error: '用户不存在' });
    const { rows } = await pool.query(`
      SELECT l.user_id, l.post_id,
        a.username, a.nickname, a.avatar_color, a.avatar_img, a.role,
        p.content AS post_content
      FROM likes l
      JOIN posts p ON p.id = l.post_id
      JOIN users a ON a.id = l.user_id
      WHERE p.user_id = $1
      ORDER BY l.post_id DESC LIMIT 100`, [u[0].id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 删除评论（作者本人或帖子作者）
app.delete('/api/comments/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query('SELECT user_id, post_id FROM comments WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: '回复不存在' });
    const { rows: p } = await pool.query('SELECT user_id FROM posts WHERE id=$1', [rows[0].post_id]);
    if (req.user.id !== rows[0].user_id && (!p.length || req.user.id !== p[0].user_id))
      return res.status(403).json({ error: '无权删除' });
    await pool.query('DELETE FROM comment_likes WHERE comment_id=$1', [id]);
    await pool.query('DELETE FROM comment_reposts WHERE comment_id=$1', [id]);
    await pool.query('DELETE FROM comments WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 评论点赞切换
app.post('/api/comments/:id/like', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = await pool.query('SELECT 1 FROM comment_likes WHERE user_id=$1 AND comment_id=$2', [req.user.id, id]);
    if (ex.rows.length) {
      await pool.query('DELETE FROM comment_likes WHERE user_id=$1 AND comment_id=$2', [req.user.id, id]);
    } else {
      await pool.query('INSERT INTO comment_likes (user_id, comment_id) VALUES ($1,$2)', [req.user.id, id]);
      const c = await pool.query('SELECT user_id, post_id FROM comments WHERE id=$1', [id]);
      if (c.rows.length) await notify(pool, c.rows[0].user_id, req.user.id, 'like', c.rows[0].post_id);
    }
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM comment_likes WHERE comment_id=$1', [id]);
    res.json({ liked: ex.rows.length === 0, likes: rows[0].c });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 评论转推切换（转发该条评论为新帖）
app.post('/api/comments/:id/repost', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = await pool.query('SELECT 1 FROM comment_reposts WHERE user_id=$1 AND comment_id=$2', [req.user.id, id]);
    if (ex.rows.length) {
      await pool.query('DELETE FROM comment_reposts WHERE user_id=$1 AND comment_id=$2', [req.user.id, id]);
    } else {
      await pool.query('INSERT INTO comment_reposts (user_id, comment_id) VALUES ($1,$2)', [req.user.id, id]);
      const c = await pool.query('SELECT user_id, post_id FROM comments WHERE id=$1', [id]);
      if (c.rows.length) await notify(pool, c.rows[0].user_id, req.user.id, 'repost', c.rows[0].post_id);
    }
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM comment_reposts WHERE comment_id=$1', [id]);
    res.json({ reposted: ex.rows.length === 0, reposts: rows[0].c });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 私信 ====================
// 会话列表：每个对端 + 最后一条消息 + 未读数
app.get('/api/dm/conversations', auth, async (req, res) => {
  try {
    const me = req.user.id;
    const { rows } = await pool.query(`
      WITH pairs AS (
        SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id,
               MAX(created_at) AS last_time
        FROM dm_messages WHERE sender_id = $1 OR receiver_id = $1
        GROUP BY 1
      )
      SELECT p.other_id, p.last_time,
        u.username, u.nickname, u.avatar_color,
        (SELECT content FROM dm_messages m WHERE (m.sender_id = p.other_id AND m.receiver_id = $1)
            OR (m.sender_id = $1 AND m.receiver_id = p.other_id) ORDER BY m.id DESC LIMIT 1) AS last_msg,
        (SELECT sender_id FROM dm_messages m WHERE (m.sender_id = p.other_id AND m.receiver_id = $1)
            OR (m.sender_id = $1 AND m.receiver_id = p.other_id) ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*)::int FROM dm_messages m WHERE m.sender_id = p.other_id AND m.receiver_id = $1 AND m.read = 0) AS unread
      FROM pairs p JOIN users u ON u.id = p.other_id
      ORDER BY p.last_time DESC`, [me]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 未读总数（轮询用，轻量）
app.get('/api/dm/unread', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM dm_messages WHERE receiver_id = $1 AND read = 0', [req.user.id]);
    res.json({ unread: rows[0].c });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 与某人的消息列表（并标记已读）
app.get('/api/dm/with/:username', auth, async (req, res) => {
  try {
    const { rows: u } = await pool.query('SELECT id, username, nickname, avatar_color FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!u.length) return res.status(404).json({ error: '用户不存在' });
    const other = u[0].id, me = req.user.id;
    await pool.query('UPDATE dm_messages SET read = 1 WHERE sender_id = $1 AND receiver_id = $2 AND read = 0', [other, me]);
    const { rows } = await pool.query(`
      SELECT m.id, m.sender_id, m.content, m.created_at, u.username, u.nickname
      FROM dm_messages m JOIN users u ON u.id = m.sender_id
      WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
      ORDER BY m.id ASC LIMIT 300`, [me, other]);
    res.json({ user: u[0], messages: rows, me: me });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 发送私信
app.post('/api/dm/send', auth, async (req, res) => {
  try {
    const { to, content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    const { rows: u } = await pool.query('SELECT id, username, nickname FROM users WHERE lower(username) = lower($1)', [to || '']);
    if (!u.length) return res.status(404).json({ error: '收件人不存在' });
    if (u[0].id === req.user.id) return res.status(400).json({ error: '不能给自己发私信' });
    const { rows } = await pool.query(
      'INSERT INTO dm_messages (sender_id, receiver_id, content) VALUES ($1,$2,$3) RETURNING id, created_at',
      [req.user.id, u[0].id, content.trim()]);
    await notify(pool, u[0].id, req.user.id, 'dm', null);
    res.json({ id: rows[0].id, created_at: rows[0].created_at, to: u[0].username });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 推荐用户（未关注的人，按关注者数排序）
app.get('/api/suggested', authOptional, async (req, res) => {
  try {
    const me = req.user?.id || 0;
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.nickname, u.avatar_color, u.avatar_img, u.bio,
        (SELECT COUNT(*)::int FROM follows WHERE followee_id = u.id) AS followers,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = u.id) AS is_following
      FROM users u
      WHERE u.id <> $1 AND NOT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = u.id)
      ORDER BY (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) DESC, u.id DESC
      LIMIT 30`, [me]);
    res.json(rows.map(r => ({ ...r, is_following: !!r.is_following })));
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 全部用户（建群/私信选择用）
app.get('/api/all-users', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT username, nickname, avatar_color, avatar_img, bio FROM users WHERE id <> $1 ORDER BY id DESC LIMIT 200', [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 认证申请 ====================
app.get('/api/verify/status', auth, async (req, res) => {
  try {
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    const r = await pool.query("SELECT req_type, status, created_at FROM verify_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
    res.json({ role: me.rows[0].role, request: r.rows[0] || null });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
// ==================== 话题订阅 ====================
app.get('/api/subs', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT keyword FROM topic_subs WHERE user_id=$1 ORDER BY id DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/subs', auth, async (req, res) => {
  try {
    const kw = String(req.body?.keyword || '').trim().slice(0, 30);
    if (!kw) return res.status(400).json({ error: '话题不能为空' });
    const ex = await pool.query('SELECT 1 FROM topic_subs WHERE user_id=$1 AND keyword=$2', [req.user.id, kw]);
    if (ex.rows.length) { await pool.query('DELETE FROM topic_subs WHERE user_id=$1 AND keyword=$2', [req.user.id, kw]); return res.json({ subscribed: false }); }
    await pool.query('INSERT INTO topic_subs (user_id, keyword) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, kw]);
    res.json({ subscribed: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
// 订阅话题相关帖子（关键词全文检索，供首页穿插）
app.get('/api/subs/feed', auth, async (req, res) => {
  try {
    const kws = (await pool.query('SELECT keyword FROM topic_subs WHERE user_id=$1', [req.user.id])).rows.map(r => r.keyword);
    if (!kws.length) return res.json([]);
    const conds = kws.map((_, i) => `p.content ILIKE '%' || $${i + 2} || '%'`).join(' OR ');
    const { rows } = await pool.query(
      `SELECT p.id FROM posts p WHERE p.removed IS NOT TRUE AND p.user_id <> $1 AND (${conds})
       ORDER BY p.created_at DESC LIMIT 30`, [req.user.id, ...kws]);
    const ids = rows.map(r => r.id);
    if (!ids.length) return res.json([]);
    const feed = await queryFeed('p.id = ANY($1::int[])', [ids], req.user.id);
    res.json(feed);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/verify/apply', auth, async (req, res) => {
  try {
    const { req_type, info } = req.body || {};
    if (!['official','verified','org','gov','star'].includes(req_type)) return res.status(400).json({ error: '类型无效' });
    if (!info || !info.trim()) return res.status(400).json({ error: '请填写认证说明' });
    const me = await pool.query("SELECT role FROM users WHERE id=$1", [req.user.id]);
    if (me.rows[0].role !== 'user') return res.status(400).json({ error: '你已认证' });
    const dup = await pool.query("SELECT id FROM verify_requests WHERE user_id=$1 AND status='pending'", [req.user.id]);
    if (dup.rows.length) return res.status(400).json({ error: '已有申请在审核中' });
    const title = String(req.body?.title || '').trim().slice(0, 30);
    await pool.query('INSERT INTO verify_requests (user_id, req_type, info, title) VALUES ($1,$2,$3,$4)', [req.user.id, req_type, info.trim(), title || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/verify', async (req, res) => {
  try {
    const { secret, username, role, request_id } = req.body || {};
    if (secret !== (process.env.ADMIN_SECRET || 'yuacio-school-2026')) return res.status(403).json({ error: '密钥错误' });
    if (request_id) {
      const approve = role !== 'reject';
      const r = await pool.query('SELECT user_id, req_type FROM verify_requests WHERE id=$1', [Number(request_id)]);
      if (!r.rows.length) return res.status(404).json({ error: '申请不存在' });
      await pool.query("UPDATE verify_requests SET status=$1 WHERE id=$2", [approve ? 'approved' : 'rejected', Number(request_id)]);
      if (approve) {
        await pool.query('UPDATE users SET role=$1, verify_title=$2 WHERE id=$3', [r.rows[0].req_type, r.rows[0].title || null, r.rows[0].user_id]);
        await pool.query("INSERT INTO notifications (user_id, actor_id, type) VALUES ($1,$2,'verified')", [r.rows[0].user_id, r.rows[0].user_id]);
      }
      return res.json({ ok: true, approved: approve });
    }
    const rv = role === 'official' ? 'official' : 'verified';
    const { rows } = await pool.query('UPDATE users SET role = $1 WHERE lower(username) = lower($2) RETURNING username, role', [rv, username || '']);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
// 待审申请列表（管理员）
app.post('/api/admin/verify/list', auth, async (req, res) => {
  try {
    if (req.body.secret !== (process.env.ADMIN_SECRET || 'yuacio-school-2026')) return res.status(403).json({ error: '密钥错误' });
    const { rows } = await pool.query(`SELECT v.id, v.req_type, v.info, v.created_at, u.username, u.nickname
      FROM verify_requests v JOIN users u ON u.id = v.user_id WHERE v.status='pending' ORDER BY v.id ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 管理后台 API ====================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM admins WHERE lower(username) = lower($1)', [String(username || '')]);
    const a = rows[0];
    if (!a || !bcrypt.compareSync(String(password || ''), a.password))
      return res.status(400).json({ error: '账号或密码错误' });
    res.cookie('atoken', signAdmin(a), { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600e3 });
    res.json({ id: a.id, username: a.username, name: a.name, super: a.super });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('atoken'); res.json({ ok: true }); });
// ==================== 图床上传代理（imgbb） ====================
// 数据库只存 URL：前端压缩后经此接口上传到 imgbb 免费图床，失败时前端自动回退 base64
const uploadAuth = (req, res, next) => {
  if (req.cookies.token) return auth(req, res, next);
  if (req.cookies.atoken) return adminAuth(req, res, next);
  next();
};
app.post('/api/upload', uploadAuth, async (req, res) => {
  try {
    let { data } = req.body || {};
    if (!data) return res.status(400).json({ error: '缺少图片数据' });
    const s = await pool.query("SELECT value FROM site_settings WHERE key='imgbb_key'");
    const key = ((s.rows[0] && s.rows[0].value) || process.env.IMGBB_KEY || '').trim();
    if (!key) return res.status(400).json({ error: 'no_key' });
    data = String(data).replace(/^data:\w+\/\w+;base64,/, '').trim();
    if (data.length > 16e6) return res.status(400).json({ error: '图片过大' });
    const fd = new FormData();
    fd.append('image', data);
    const up = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key), { method: 'POST', body: fd, signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': '*/*' } });
    const j = await up.json().catch(() => null);
    if (!j || !j.success || !j.data || !j.data.url) {
      const msg = (j && j.error && (j.error.message || j.error.code)) || '未知错误';
      console.error('imgbb err:', msg);
      // Cloudflare 封数据中心 IP 时，让前端用用户自己的网络直传
      if (/forbidden/i.test(msg)) return res.status(502).json({ error: 'forbidden_direct', key });
      return res.status(502).json({ error: '图床上传失败: ' + msg });
    }
    res.json({ url: j.data.url, thumb: (j.data.medium && j.data.medium.url) || j.data.url });
  } catch (e) { console.error('upload:', e.message); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 界面可视化编辑（site_settings） ====================
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM site_settings WHERE key <> $1', ['imgbb_key']);
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) { res.json({}); }
});
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value, updated_at FROM site_settings ORDER BY key');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const entries = req.body || {};
    for (const [k, v] of Object.entries(entries)) {
      if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
      await pool.query(`INSERT INTO site_settings (key, value) VALUES ($1,$2)
        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [k, String(v ?? '').slice(k === 'modules_json' ? 3000000 : 2000)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.delete('/api/admin/settings/:key', adminAuth, async (req, res) => {
  try { await pool.query('DELETE FROM site_settings WHERE key=$1', [req.params.key]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 广告系统 ====================
app.get('/api/ads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, body, image, link, cta FROM ads WHERE active = TRUE ORDER BY created_at DESC LIMIT 3');
    res.json(rows);
  } catch (e) { res.json([]); }
});
app.post('/api/ads/:id/view', async (req, res) => {
  try { await pool.query('UPDATE ads SET views = views + 1 WHERE id = $1', [req.params.id]); res.json({ ok: true }); } catch (e) { res.json({}); }
});
app.post('/api/ads/:id/click', async (req, res) => {
  try { await pool.query('UPDATE ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]); res.json({ ok: true }); } catch (e) { res.json({}); }
});
app.get('/api/admin/ads', adminAuth, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM ads ORDER BY created_at DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/ads', adminAuth, async (req, res) => {
  try {
    const { title, body, image, link, cta, active } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
    const { rows } = await pool.query(
      'INSERT INTO ads (title, body, image, link, cta, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title.trim().slice(0, 80), (body || '').slice(0, 200), image || null, link || null, cta || '了解详情', active !== false]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.put('/api/admin/ads/:id', adminAuth, async (req, res) => {
  try {
    const { title, body, image, link, cta, active } = req.body || {};
    const { rows } = await pool.query(`UPDATE ads SET
      title = COALESCE($1, title), body = COALESCE($2, body), image = COALESCE($3, image),
      link = COALESCE($4, link), cta = COALESCE($5, cta), active = COALESCE($6, active)
      WHERE id = $7 RETURNING *`,
      [title, body, image, link, cta, active, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '广告不存在' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.delete('/api/admin/ads/:id', adminAuth, async (req, res) => {
  try { await pool.query('DELETE FROM ads WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/admin/me', adminAuth, (req, res) => res.json(req.admin));

// 概览数据
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const q = async (sql) => Number((await pool.query(sql)).rows[0].c);
    const [users, posts, comments, todayUsers, todayPosts, pendingVerify, pendingReports, banned, removed, groups, dms] = await Promise.all([
      q('SELECT COUNT(*) c FROM users'), q('SELECT COUNT(*) c FROM posts WHERE removed IS NOT TRUE'),
      q('SELECT COUNT(*) c FROM comments WHERE removed IS NOT TRUE'),
      q("SELECT COUNT(*) c FROM users WHERE created_at > now() - interval '1 day'"),
      q("SELECT COUNT(*) c FROM posts WHERE created_at > now() - interval '1 day'"),
      q("SELECT COUNT(*) c FROM verify_requests WHERE status='pending'"),
      q("SELECT COUNT(*) c FROM reports WHERE status='pending'"),
      q('SELECT COUNT(*) c FROM users WHERE banned IS TRUE'), q('SELECT COUNT(*) c FROM posts WHERE removed IS TRUE'),
      q('SELECT COUNT(*) c FROM groups'), q('SELECT COUNT(*) c FROM dm_messages')
    ]);
    const { rows: trend } = await pool.query(`SELECT to_char(g::date,'MM-DD') AS lb,
      (SELECT COUNT(*)::int FROM users u WHERE u.created_at::date = g::date) users,
      (SELECT COUNT(*)::int FROM posts p WHERE p.created_at::date = g::date) posts
      FROM generate_series(now()::date - 6, now()::date, '1 day') AS g ORDER BY g`);
    const { rows: hot } = await pool.query(`SELECT p.id, left(p.content,40) content, u.username,
      (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) likes FROM posts p JOIN users u ON u.id=p.user_id
      WHERE p.removed IS NOT TRUE ORDER BY likes DESC, p.id DESC LIMIT 5`);
    res.json({ users, posts, comments, todayUsers, todayPosts, pendingVerify, pendingReports, banned, removed, groups, dms, trend, hot });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 用户管理
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const kw = String(req.query.q || '').trim();
    const like = `%${kw.replace(/[%_]/g, '')}%`;
    const onlyBanned = req.query.banned === '1';
    const { rows } = await pool.query(`SELECT u.id, u.username, u.nickname, u.role, u.banned, u.created_at, u.bio,
        (SELECT COUNT(*)::int FROM posts WHERE user_id=u.id AND removed IS NOT TRUE) posts,
        (SELECT COUNT(*)::int FROM follows WHERE followee_id=u.id) followers,
        (SELECT COUNT(*)::int FROM follows WHERE follower_id=u.id) following
      FROM users u
      WHERE ($1 = '%%' OR u.username ILIKE $1 OR u.nickname ILIKE $1) ${onlyBanned ? 'AND u.banned IS TRUE' : ''}
      ORDER BY u.id DESC LIMIT 100`, [like]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, value } = req.body || {};
    const target = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (action === 'ban') {
      await pool.query('UPDATE users SET banned=$1 WHERE id=$2', [!!value, id]);
    } else if (action === 'role') {
      if (!['user', 'verified', 'official'].includes(value)) return res.status(400).json({ error: '角色无效' });
      await pool.query('UPDATE users SET role=$1 WHERE id=$2', [value, id]);
      if (value !== 'user') await pool.query("INSERT INTO notifications (user_id, actor_id, type) VALUES ($1,$1,'verified')", [id]);
    } else if (action === 'nickname') {
      const v = String(value || '').trim().slice(0, 40);
      if (!v) return res.status(400).json({ error: '昵称不能为空' });
      await pool.query('UPDATE users SET nickname=$1 WHERE id=$2', [v, id]);
    } else if (action === 'password') {
      const v = String(value || '');
      if (v.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [bcrypt.hashSync(v, 10), id]);
    } else if (action === 'delete') {
      if (!req.admin.super) return res.status(403).json({ error: '仅超级管理员可删除用户' });
      await pool.query('DELETE FROM comments WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [id]);
      await pool.query('DELETE FROM likes WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [id]);
      await pool.query('DELETE FROM reposts WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [id]);
      await pool.query('DELETE FROM bookmarks WHERE user_id=$1', [id]);
      await pool.query('DELETE FROM notifications WHERE user_id=$1 OR actor_id=$1', [id]);
      await pool.query('DELETE FROM follows WHERE follower_id=$1 OR followee_id=$1', [id]);
      await pool.query('DELETE FROM dm_messages WHERE sender_id=$1 OR receiver_id=$1', [id]);
      await pool.query('DELETE FROM group_members WHERE user_id=$1', [id]);
      await pool.query('DELETE FROM group_messages WHERE sender_id=$1', [id]);
      await pool.query('DELETE FROM verify_requests WHERE user_id=$1', [id]);
      await pool.query('DELETE FROM posts WHERE user_id=$1', [id]);
      await pool.query('DELETE FROM users WHERE id=$1', [id]);
    } else return res.status(400).json({ error: '未知操作' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 内容管理
app.get('/api/admin/posts', adminAuth, async (req, res) => {
  try {
    const kw = String(req.query.q || '').trim();
    const like = `%${kw.replace(/[%_]/g, '')}%`;
    const onlyRemoved = req.query.removed === '1';
    const { rows } = await pool.query(`SELECT p.id, p.content, p.created_at, p.removed, p.images, u.username, u.nickname, u.id AS user_id,
        (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) likes,
        (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) comments,
        (SELECT COUNT(*)::int FROM reposts WHERE post_id=p.id) reposts
      FROM posts p JOIN users u ON u.id=p.user_id
      WHERE ($1='%%' OR p.content ILIKE $1 OR u.username ILIKE $1) ${onlyRemoved ? 'AND p.removed IS TRUE' : ''}
      ORDER BY p.id DESC LIMIT 100`, [like]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action } = req.body || {};
    if (action === 'remove' || action === 'restore') {
      await pool.query('UPDATE posts SET removed=$1 WHERE id=$2', [action === 'remove', id]);
    } else if (action === 'delete') {
      await pool.query('DELETE FROM comments WHERE post_id=$1', [id]);
      await pool.query('DELETE FROM likes WHERE post_id=$1', [id]);
      await pool.query('DELETE FROM reposts WHERE post_id=$1', [id]);
      await pool.query('DELETE FROM bookmarks WHERE post_id=$1', [id]);
      await pool.query('DELETE FROM notifications WHERE post_id=$1', [id]);
      await pool.query('DELETE FROM posts WHERE id=$1', [id]);
    } else return res.status(400).json({ error: '未知操作' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/admin/comments', adminAuth, async (req, res) => {
  try {
    const kw = String(req.query.q || '').trim();
    const like = `%${kw.replace(/[%_]/g, '')}%`;
    const { rows } = await pool.query(`SELECT c.id, c.content, c.created_at, c.removed, u.username, u.nickname, c.post_id
      FROM comments c JOIN users u ON u.id=c.user_id
      WHERE ($1='%%' OR c.content ILIKE $1 OR u.username ILIKE $1) ORDER BY c.id DESC LIMIT 100`, [like]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/comments/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action } = req.body || {};
    if (action === 'remove' || action === 'restore') await pool.query('UPDATE comments SET removed=$1 WHERE id=$2', [action === 'remove', id]);
    else if (action === 'delete') {
      await pool.query('DELETE FROM comments WHERE id=$1 OR parent_id=$1', [id]);
      await pool.query('DELETE FROM comment_likes WHERE comment_id=$1', [id]);
    } else return res.status(400).json({ error: '未知操作' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 举报：用户提交 + 后台处理
app.post('/api/report', auth, async (req, res) => {
  try {
    const { target_type, target_id, reason } = req.body || {};
    if (!['post', 'comment', 'user'].includes(target_type)) return res.status(400).json({ error: '类型无效' });
    await pool.query('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4)',
      [req.user.id, target_type, Number(target_id), String(reason || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT r.*, u.username AS reporter
      FROM reports r LEFT JOIN users u ON u.id=r.reporter_id
      WHERE r.status='pending' ORDER BY r.id DESC LIMIT 100`);
    const out = [];
    for (const r of rows) {
      let snippet = '', author = '';
      if (r.target_type === 'post') {
        const x = (await pool.query('SELECT p.content, u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [r.target_id])).rows[0];
        if (x) { snippet = x.content; author = x.username; }
      } else if (r.target_type === 'comment') {
        const x = (await pool.query('SELECT c.content, u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1', [r.target_id])).rows[0];
        if (x) { snippet = x.content; author = x.username; }
      } else {
        const x = (await pool.query('SELECT username, bio FROM users WHERE id=$1', [r.target_id])).rows[0];
        if (x) { snippet = x.bio || ''; author = x.username; }
      }
      out.push({ ...r, snippet, author });
    }
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    const { action } = req.body || {};
    await pool.query('UPDATE reports SET status=$1 WHERE id=$2', [action === 'handle' ? 'handled' : 'ignored', Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 认证审批（后台版）
app.get('/api/admin/verify', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT v.id, v.req_type, v.info, v.status, v.created_at, u.id AS user_id,
        u.username, u.nickname, u.role,
        (SELECT COUNT(*)::int FROM posts WHERE user_id=u.id) posts,
        (SELECT COUNT(*)::int FROM follows WHERE followee_id=u.id) followers
      FROM verify_requests v JOIN users u ON u.id=v.user_id
      ORDER BY CASE WHEN v.status='pending' THEN 0 ELSE 1 END, v.id DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/verify/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, role } = req.body || {};
    const r = (await pool.query('SELECT * FROM verify_requests WHERE id=$1', [id])).rows[0];
    if (!r) return res.status(404).json({ error: '申请不存在' });
    const ok = action === 'approve';
    await pool.query('UPDATE verify_requests SET status=$1 WHERE id=$2', [ok ? 'approved' : 'rejected', id]);
    if (ok) {
      const rv = ['official', 'verified'].includes(role) ? role : r.req_type;
      await pool.query('UPDATE users SET role=$1, verify_title=$2 WHERE id=$3', [rv, r.title || null, r.user_id]);
      await pool.query("INSERT INTO notifications (user_id, actor_id, type) VALUES ($1,$1,'verified')", [r.user_id]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 趋势干预
app.get('/api/admin/trends', adminAuth, async (req, res) => {
  try {
    const { rows: pins } = await pool.query('SELECT tag, mode FROM trend_pins ORDER BY created_at DESC');
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/trends');
    const list = await r.json();
    const pinMap = {}; pins.forEach(p => pinMap[p.tag] = p.mode);
    res.json({ list: list.map(t => ({ ...t, mode: pinMap[t.tag] || '' })), pins });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.post('/api/admin/trends', adminAuth, async (req, res) => {
  try {
    const { tag, mode } = req.body || {};
    const t = String(tag || '').replace(/^#/, '').trim();
    if (!t) return res.status(400).json({ error: '话题不能为空' });
    if (mode === 'clear') await pool.query('DELETE FROM trend_pins WHERE tag=$1', [t]);
    else if (['pinned', 'banned'].includes(mode))
      await pool.query('INSERT INTO trend_pins (tag, mode) VALUES ($1,$2) ON CONFLICT (tag) DO UPDATE SET mode=$2', [t, mode]);
    else return res.status(400).json({ error: '模式无效' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 管理员账号
app.get('/api/admin/admins', adminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, name, super, created_at FROM admins ORDER BY id');
  res.json(rows);
});
app.post('/api/admin/admins', adminAuth, async (req, res) => {
  try {
    if (!req.admin.super) return res.status(403).json({ error: '仅超级管理员可添加' });
    const { username, password, name } = req.body || {};
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(String(username || ''))) return res.status(400).json({ error: '账号需 3-20 位字母数字' });
    if (String(password || '').length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    await pool.query('INSERT INTO admins (username, password, name) VALUES ($1,$2,$3)',
      [username, bcrypt.hashSync(String(password), 10), String(name || username).slice(0, 40)]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: '账号已存在' }); }
});
app.delete('/api/admin/admins/:id', adminAuth, async (req, res) => {
  try {
    if (!req.admin.super) return res.status(403).json({ error: '仅超级管理员可删除' });
    const id = Number(req.params.id);
    if (id === req.admin.id) return res.status(400).json({ error: '不能删除自己' });
    await pool.query('DELETE FROM admins WHERE id=$1 AND super IS NOT TRUE', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 关注/粉丝列表
app.get('/api/users/:username/follow_list', authOptional, async (req, res) => {
  try {
    const u = (await pool.query('SELECT id FROM users WHERE lower(username)=lower($1)', [req.params.username])).rows[0];
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const { rows: following } = await pool.query(`SELECT f.followee_id AS id, us.username, us.nickname, us.avatar_color, us.avatar_img, us.role, us.bio,
      EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND followee_id=f.followee_id) AS is_following
      FROM follows f JOIN users us ON us.id=f.followee_id WHERE f.follower_id=$1 ORDER BY f.followee_id DESC LIMIT 100`, [u.id, req.user?.id || 0]);
    const { rows: followers } = await pool.query(`SELECT f.follower_id AS id, us.username, us.nickname, us.avatar_color, us.avatar_img, us.role, us.bio,
      EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND followee_id=f.follower_id) AS is_following
      FROM follows f JOIN users us ON us.id=f.follower_id WHERE f.followee_id=$1 ORDER BY f.follower_id DESC LIMIT 100`, [u.id, req.user?.id || 0]);
    res.json({ following, followers });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// 修改密码
app.post('/api/me/password', auth, async (req, res) => {
  try {
    const { old_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const { rows } = await pool.query('SELECT password FROM users WHERE id=$1', [req.user.id]);
    if (!bcrypt.compareSync(String(old_password || ''), rows[0].password)) return res.status(400).json({ error: '当前密码错误' });
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [bcrypt.hashSync(String(new_password), 10), req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 导出我的数据
app.get('/api/me/export', auth, async (req, res) => {
  try {
    const me = (await pool.query('SELECT id, username, nickname, bio, avatar_color, location, link, created_at FROM users WHERE id=$1', [req.user.id])).rows[0];
    const posts = (await pool.query('SELECT id, content, created_at FROM posts WHERE user_id=$1 ORDER BY id', [req.user.id])).rows;
    const likes = (await pool.query('SELECT p.id, p.content FROM likes l JOIN posts p ON p.id=l.post_id WHERE l.user_id=$1', [req.user.id])).rows;
    const dms = (await pool.query(`SELECT * FROM (SELECT sender_id, receiver_id, content, created_at FROM dm_messages WHERE sender_id=$1 OR receiver_id=$1) t ORDER BY created_at LIMIT 500`, [req.user.id])).rows;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="yuacio-data.json"');
    res.json({ exported_at: new Date().toISOString(), account: me, posts, likes, messages: dms });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 注销申请（写入举报表由管理员处理）
app.post('/api/me/deactivate', auth, async (req, res) => {
  try {
    const dup = await pool.query("SELECT id FROM reports WHERE reporter_id=$1 AND target_type='deactivate' AND status='pending'", [req.user.id]);
    if (dup.rows.length) return res.status(400).json({ error: '已有注销申请在处理中' });
    await pool.query("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1,'deactivate',$2,'用户申请注销账号')", [req.user.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

// 创作者中心统计
// ==================== 文章创作 ====================
app.post('/api/articles', auth, async (req, res) => {
  try {
    const { title, body, image } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
    if (!body || body.trim().length < 10) return res.status(400).json({ error: '正文至少 10 个字符' });
    const t = title.trim().slice(0, 100);
    const text = body.trim().slice(0, 20000);
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, content, article, title, images)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.id, text.slice(0, 400), text, t, image ? JSON.stringify([image]) : null]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});
app.put('/api/articles/:id', auth, async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const { rows } = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '文章不存在' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: '只能编辑自己的文章' });
    await pool.query('UPDATE posts SET title=$1, article=$2, content=$3 WHERE id=$4',
      [title.trim().slice(0,100), body.trim().slice(0,20000), body.trim().slice(0,400), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.delete('/api/articles/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '文章不存在' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: '只能删除自己的文章' });
    await pool.query('UPDATE posts SET removed=TRUE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});
app.get('/api/articles/:id', authOptional, async (req, res) => {
  try {
    await pool.query('UPDATE posts SET views = views + 1 WHERE id = $1', [req.params.id]);
    const rows = await queryFeed('p.id = $1', [req.params.id], req.user?.id, { allowArticle: true });
    if (!rows.length) return res.status(404).json({ error: '文章不存在' });
    const full = await pool.query('SELECT title, article FROM posts WHERE id=$1', [req.params.id]);
    res.json({ ...rows[0], title: full.rows[0].title, article: full.rows[0].article });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/creator/weekly', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const views = Number((await pool.query(`SELECT COALESCE(SUM(views),0)::int c FROM posts WHERE user_id=$1 AND created_at > now() - interval '7 days'`, [uid])).rows[0].c);
    const inter = Number((await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM likes WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) +
      (SELECT COUNT(*)::int FROM reposts WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) +
      (SELECT COUNT(*)::int FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) c`, [uid])).rows[0].c);
    const fans = Number((await pool.query(`SELECT COUNT(*)::int c FROM follows WHERE followee_id=$1`, [uid])).rows[0].c);
    res.json({ views, inter, fans });
  } catch (e) { res.json({ views: 0, inter: 0, fans: 0 }); }
});

app.get('/api/creator/stats', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const agg = (await pool.query(`SELECT
      COALESCE(SUM(views),0)::int AS views,
      (SELECT COUNT(*)::int FROM likes WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) AS likes,
      (SELECT COUNT(*)::int FROM reposts WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) AS reposts,
      (SELECT COUNT(*)::int FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)) AS replies
      FROM posts WHERE user_id=$1`, [uid])).rows[0];
    const { rows: top } = await pool.query(`SELECT id, left(content,60) AS content, views FROM posts WHERE user_id=$1 ORDER BY views DESC, id DESC LIMIT 5`, [uid]);
    res.json({ views: agg.views, likes: agg.likes, reposts: agg.reposts, replies: agg.replies, top });
  } catch (e) { console.error(e); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 书签 ====================
app.post('/api/posts/:id/bookmark', auth, async (req, res) => {
  const existing = await pool.query('SELECT 1 FROM bookmarks WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.id]);
  if (existing.rows.length) {
    await pool.query('DELETE FROM bookmarks WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.id]);
    return res.json({ bookmarked: false });
  }
  await pool.query('INSERT INTO bookmarks (user_id, post_id) VALUES ($1,$2)', [req.user.id, req.params.id]);
  res.json({ bookmarked: true });
});

app.get('/api/bookmarks', auth, async (req, res) => {
  const posts = await queryPosts('p.id IN (SELECT post_id FROM bookmarks WHERE user_id = $1)', [req.user.id], req.user.id);
  res.json(posts);
});

// ==================== 搜索 ====================
app.get('/api/search', authOptional, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ posts: [], users: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const posts = await queryPosts('p.content ILIKE $1', [like], req.user?.id);
  const { rows: users } = await pool.query(`SELECT id, username, nickname, avatar_color, bio,
    (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS followers
    FROM users u WHERE username ILIKE $1 OR nickname ILIKE $1 LIMIT 10`, [like]);
  res.json({ posts, users });
});

// ==================== 通知 ====================
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT n.*, a.username AS actor_username, a.nickname AS actor_nickname, p.content AS post_content
      FROM notifications n
      JOIN users a ON a.id = n.actor_id
      LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT 100`, [req.user.id]);
    const unread = Number((await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read = 0', [req.user.id])).rows[0].c);
    res.json({ unread, items: rows });
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  await pool.query('UPDATE notifications SET read = 1 WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Twitter clone (Postgres) running on port ${PORT}`)))
  .catch(e => { console.error('数据库初始化失败:', e.message); process.exit(1); });

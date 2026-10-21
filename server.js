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
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
  `);
}

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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
    SELECT p.*, u.username, u.nickname, u.avatar_color,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments,
      (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) AS reposts,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $ME) AS liked,
      EXISTS(SELECT 1 FROM reposts WHERE post_id = p.id AND user_id = $ME) AS reposted,
      EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $ME) AS bookmarked
    FROM posts p JOIN users u ON u.id = p.user_id
    ${where ? 'WHERE ' + where : ''}
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
  const { rows } = await pool.query('SELECT id, username, nickname, bio, avatar_color FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0] || null);
});

// ==================== 用户 ====================
app.get('/api/users/:username', authOptional, async (req, res) => {
  const { rows } = await pool.query(`SELECT u.id, u.username, u.nickname, u.bio, u.avatar_color, u.created_at,
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
  res.json({ ...u, is_following, is_self });
});

app.put('/api/me', auth, async (req, res) => {
  const { nickname, bio, avatar_color } = req.body || {};
  await pool.query('UPDATE users SET nickname = COALESCE($1, nickname), bio = COALESCE($2, bio), avatar_color = COALESCE($3, avatar_color) WHERE id = $4',
    [nickname, bio, avatar_color, req.user.id]);
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
app.get('/api/posts', authOptional, async (req, res) => {
  try { res.json(await queryPosts('', [], req.user?.id)); }
  catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/timeline', auth, async (req, res) => {
  try {
    const where = `(p.user_id = $1 OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1) OR p.user_id IN (SELECT user_id FROM reposts WHERE user_id = $1))`;
    res.json(await queryPosts(where, [req.user.id], req.user.id));
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.get('/api/users/:username/posts', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    res.json(await queryPosts('p.user_id = $1', [rows[0].id], req.user?.id));
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    if (content.length > 280) return res.status(400).json({ error: '最多 280 个字符' });
    const { rows: inserted } = await pool.query('INSERT INTO posts (user_id, content) VALUES ($1,$2) RETURNING id', [req.user.id, content.trim()]);
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
        false AS liked, false AS reposted
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1 ORDER BY c.id ASC`, [req.params.id]);
    res.json(withMe(rows, req.user?.id));
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '帖子不存在' });
    await pool.query('INSERT INTO comments (user_id, post_id, content) VALUES ($1,$2,$3)', [req.user.id, req.params.id, content.trim()]);
    await notify(pool, rows[0].user_id, req.user.id, 'comment', Number(req.params.id));
    const { rows: c } = await pool.query(`
      SELECT c.*, u.username, u.nickname, u.avatar_color, false AS liked, false AS reposted
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1 ORDER BY c.id DESC LIMIT 1`, [req.params.id]);
    res.json(withMe(c, req.user.id)[0]);
  } catch (e) { res.status(500).json({ error: '服务器错误' }); }
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
